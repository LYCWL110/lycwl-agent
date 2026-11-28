import { spawn } from "node:child_process";
import { MCP_LIMITS } from "../../domain/mcp/mcp-server.js";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLIENT_PROTOCOL_VERSION = "2024-11-05";
/**
 * Start a server and complete the MCP handshake.
 *
 * A server that fails the handshake is closed rather than left running: an
 * uninitialised process is a leak with no capability.
 */
export async function connectMcpServer(options) {
    const spawnProcess = options.spawnProcess ?? spawn;
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const launch = resolveLaunch(options.command, options.args);
    let child;
    try {
        child = spawnProcess(launch.command, [...launch.args], {
            cwd: options.cwd,
            // The caller passes the final filtered environment. Nothing is merged here, so
            // an inherited variable cannot slip back in.
            env: { ...options.environment },
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
    }
    catch (error) {
        return {
            ok: false,
            code: "spawn_failed",
            ...(error instanceof Error ? { detail: error.message } : {}),
        };
    }
    const pending = new Map();
    let nextId = 1;
    let closed = false;
    let buffer = "";
    let stderrTail = "";
    function settleAll(code) {
        for (const [, entry] of pending) {
            clearTimeout(entry.timer);
            entry.reject(code);
        }
        pending.clear();
    }
    child.on("error", () => {
        closed = true;
        settleAll("spawn_failed");
    });
    child.on("exit", () => {
        closed = true;
        settleAll("closed");
    });
    child.stderr.on("data", (chunk) => {
        // Only the tail is kept, and it never enters model context: it exists so a
        // startup failure can name a cause in a diagnostic.
        stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-1_000);
    });
    child.stdout.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer, "utf8") > MCP_LIMITS.maxFrameBytes) {
            // A frame larger than the cap is a protocol violation, not a long answer.
            buffer = "";
            settleAll("frame_too_large");
            return;
        }
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line.length > 0)
                deliver(line);
            newline = buffer.indexOf("\n");
        }
    });
    function deliver(line) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            settleAll("invalid_frame");
            return;
        }
        if (typeof parsed !== "object" || parsed === null) {
            settleAll("invalid_frame");
            return;
        }
        const record = parsed;
        const id = record["id"];
        const method = record["method"];
        if (typeof method === "string" && typeof id === "number") {
            // A server-initiated request. This client supports none, and answering one
            // would give the server a way to drive the Harness, so it is refused.
            send({
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: "client does not implement server requests" },
            });
            return;
        }
        if (typeof id !== "number")
            return;
        const entry = pending.get(id);
        if (entry === undefined)
            return;
        pending.delete(id);
        clearTimeout(entry.timer);
        if (record["error"] !== undefined) {
            const error = record["error"];
            entry.resolve({
                kind: "error",
                id,
                code: typeof error === "object" && error !== null
                    ? Number(error.code) || 0
                    : 0,
                message: typeof error === "object" &&
                    error !== null &&
                    typeof error.message === "string"
                    ? error.message
                    : "server error",
            });
            return;
        }
        entry.resolve({ kind: "response", id, result: record["result"] });
    }
    function send(message) {
        if (closed)
            return;
        try {
            child.stdin.write(`${JSON.stringify(message)}\n`);
        }
        catch {
            closed = true;
            settleAll("closed");
        }
    }
    function request(method, params) {
        if (closed)
            return Promise.reject("closed");
        const id = nextId;
        nextId += 1;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject("timeout");
            }, requestTimeoutMs);
            timer.unref?.();
            pending.set(id, { resolve, reject, timer });
            send({ jsonrpc: "2.0", id, method, params });
        });
    }
    async function close() {
        if (closed)
            return;
        closed = true;
        settleAll("closed");
        try {
            child.stdin.end();
        }
        catch {
            // A stdin that already closed is not an error worth reporting.
        }
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                try {
                    child.kill();
                }
                catch {
                    // Already gone.
                }
                resolve();
            }, MCP_LIMITS.shutdownGraceMs);
            timer.unref?.();
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
    // Handshake.
    let init;
    try {
        init = await request("initialize", {
            protocolVersion: CLIENT_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "lycwl-agent", version: "0.1.0" },
        });
    }
    catch (error) {
        await close();
        return {
            ok: false,
            code: error,
            ...(stderrTail.length === 0 ? {} : { detail: stderrTail }),
        };
    }
    if (init.kind !== "response") {
        await close();
        return { ok: false, code: "handshake_failed" };
    }
    // The notification has no id and no reply.
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const connection = {
        serverId: options.serverId,
        processId: child.pid ?? null,
        async listTools() {
            const frame = await request("tools/list", {});
            if (frame.kind !== "response")
                return [];
            if (typeof frame.result !== "object" || frame.result === null)
                return [];
            const tools = frame.result["tools"];
            if (!Array.isArray(tools))
                return [];
            const result = [];
            for (const entry of tools) {
                if (typeof entry !== "object" || entry === null)
                    continue;
                const record = entry;
                const name = record["name"];
                if (typeof name !== "string" || name.length === 0)
                    continue;
                result.push({
                    name,
                    description: typeof record["description"] === "string" ? record["description"] : "",
                    // Passed through as-is; the domain layer normalizes the shape.
                    inputSchema: record["inputSchema"],
                });
            }
            return result;
        },
        async callTool(name, args) {
            let frame;
            try {
                frame = await request("tools/call", { name, arguments: args ?? {} });
            }
            catch (error) {
                return { ok: false, code: error };
            }
            if (frame.kind === "error") {
                return { ok: false, code: "protocol_error", detail: frame.message };
            }
            if (frame.kind !== "response") {
                return { ok: false, code: "protocol_error" };
            }
            return { ok: true, ...readToolContent(frame.result) };
        },
        close,
    };
    return { ok: true, connection };
}
/**
 * Resolve how to launch a declared command.
 *
 * On Windows, `npx`, `npm` and most MCP servers are `.cmd` batch files. Node
 * refuses to spawn a batch file directly (EINVAL, since the fix for
 * CVE-2024-27980), so the only correct route is `cmd.exe /c`. Without this every
 * `npx`-based server fails to start, which is most of them.
 *
 * The command is passed as a separate argument rather than concatenated into one
 * string, so the quoting `cmd.exe` applies cannot be influenced by the command or
 * its arguments.
 *
 * On other platforms the command is used as declared.
 */
export function resolveLaunch(command, args, platform = process.platform, comspec) {
    if (platform !== "win32")
        return { command, args };
    // An absolute path to an .exe needs no shell. Anything ending in .cmd or .bat,
    // and any bare name that resolves through PATH to one, does.
    const lower = command.toLowerCase();
    const needsShell = lower.endsWith(".cmd") ||
        lower.endsWith(".bat") ||
        // A bare name is resolved by cmd.exe's own lookup, which finds the .cmd shim.
        (!lower.endsWith(".exe") && !lower.includes("\\") && !lower.includes("/"));
    if (!needsShell)
        return { command, args };
    // undefined means "look it up"; null means "there is none". A default parameter
    // would collapse the two and make the fallback untestable.
    const resolved = comspec === undefined ? process.env["ComSpec"] : comspec;
    const shell = resolved === undefined || resolved === null || resolved.length === 0 ? "cmd.exe" : resolved;
    return { command: shell, args: ["/c", command, ...args] };
}
/**
 * Extract text from a `tools/call` result.
 *
 * MCP returns a content array. Only text parts are joined; a non-text part is
 * described by its type rather than serialized, because a binary blob in model
 * context would be both useless and a size hazard.
 */
function readToolContent(result) {
    if (typeof result !== "object" || result === null)
        return { text: "", isError: false };
    const record = result;
    const isError = record["isError"] === true;
    const content = record["content"];
    if (!Array.isArray(content))
        return { text: "", isError };
    const parts = [];
    for (const entry of content) {
        if (typeof entry !== "object" || entry === null)
            continue;
        const block = entry;
        if (block["type"] === "text" && typeof block["text"] === "string") {
            parts.push(block["text"]);
            continue;
        }
        parts.push(`[${String(block["type"] ?? "unknown")} content omitted]`);
    }
    return { text: parts.join("\n"), isError };
}
