import { spawn } from "node:child_process";
import { LSP_LIMITS } from "../../domain/language/lsp.js";
import { filterChildEnvironment } from "../../domain/process/shell.js";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export function createLspConnection(options) {
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const filter = filterChildEnvironment(options.inheritedEnvironment, {}, {
        platform: process.platform === "linux" ? "linux" : "win32",
        ...(options.providerCredentialNames === undefined
            ? {}
            : { providerCredentialNames: options.providerCredentialNames }),
        grantedNames: options.environmentGrants ?? [],
    });
    let child;
    try {
        child = spawn(options.executable, [...options.argv], {
            cwd: options.cwd,
            env: filter.environment,
            // No shell interpretation: the model cannot inject interpreters.
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
    }
    catch {
        return { error: "spawn_failed" };
    }
    let closed = false;
    let nextId = 1;
    let buffer = Buffer.alloc(0);
    const pending = new Map();
    child.on("error", () => {
        closed = true;
        for (const resolve of pending.values()) {
            resolve({ jsonrpc: "2.0", error: { code: -32000, message: "server_exited" } });
        }
        pending.clear();
    });
    child.on("exit", () => {
        closed = true;
        for (const resolve of pending.values()) {
            resolve({ jsonrpc: "2.0", error: { code: -32000, message: "server_exited" } });
        }
        pending.clear();
    });
    child.stdout.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        drain();
    });
    // Stderr is drained so a chatty server cannot block on a full pipe.
    child.stderr.on("data", () => undefined);
    function drain() {
        for (;;) {
            const headerEnd = buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
                if (buffer.length > LSP_LIMITS.maxMessageBytes)
                    buffer = Buffer.alloc(0);
                return;
            }
            const header = buffer.subarray(0, headerEnd).toString("ascii");
            const match = /Content-Length:\s*(\d+)/i.exec(header);
            if (match === null) {
                // A malformed header cannot be trusted; drop the connection buffer.
                buffer = buffer.subarray(headerEnd + 4);
                continue;
            }
            const length = Number(match[1]);
            if (length > LSP_LIMITS.maxMessageBytes) {
                buffer = Buffer.alloc(0);
                return;
            }
            const bodyStart = headerEnd + 4;
            if (buffer.length < bodyStart + length)
                return;
            const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
            buffer = buffer.subarray(bodyStart + length);
            let message;
            try {
                message = JSON.parse(body);
            }
            catch {
                continue;
            }
            dispatch(message);
        }
    }
    function dispatch(message) {
        if (message.id !== undefined && message.method !== undefined) {
            // Server-initiated request. It is reported but never applied, and every
            // such request is refused with an error response.
            options.onServerRequest?.(message);
            write({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32601, message: "server-initiated requests are rejected" },
            });
            return;
        }
        if (message.id === undefined) {
            // Notification from the server; ignored for the read-only tools.
            return;
        }
        const resolve = pending.get(message.id);
        if (resolve !== undefined) {
            pending.delete(message.id);
            resolve(message);
        }
    }
    function write(message) {
        if (closed)
            return;
        const body = Buffer.from(JSON.stringify(message), "utf8");
        const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
        try {
            child.stdin.write(Buffer.concat([header, body]));
        }
        catch {
            closed = true;
        }
    }
    async function request(method, params) {
        if (closed) {
            return { jsonrpc: "2.0", error: { code: -32000, message: "server_exited" } };
        }
        const id = nextId;
        nextId += 1;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                resolve({ jsonrpc: "2.0", id, error: { code: -32001, message: "request_timeout" } });
            }, requestTimeoutMs);
            timer.unref?.();
            pending.set(id, (message) => {
                clearTimeout(timer);
                resolve(message);
            });
            write({ jsonrpc: "2.0", id, method, params });
        });
    }
    function notify(method, params) {
        write({ jsonrpc: "2.0", method, params });
    }
    async function close() {
        if (closed)
            return;
        // Two-second grace, then a hard kill, per the confirmed bounded shutdown.
        try {
            child.stdin.end();
        }
        catch {
            // Already closed.
        }
        const exited = new Promise((resolve) => {
            const timer = setTimeout(() => resolve(), 2_000);
            timer.unref?.();
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
        await exited;
        if (!closed) {
            try {
                child.kill();
            }
            catch {
                // Ignore; the exit handler already settled state.
            }
        }
        closed = true;
    }
    return {
        request,
        notify,
        close,
        isAlive: () => !closed,
        processId: child.pid ?? null,
    };
}
