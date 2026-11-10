import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { connectMcpServer, resolveLaunch } from "../../src/adapters/windows/mcp-connection.ts";
import { startMcpServers } from "../../src/bootstrap/mcp-startup.ts";
import type { ApprovalDecision, ApprovalGate } from "../../src/ports/approval-gate.ts";

/**
 * A real child process, real pipes, real JSON-RPC.
 *
 * The server is a small Node script that answers the MCP handshake, lists one tool
 * and echoes the arguments back. Nothing is mocked except the approval decision.
 */

const SERVER_SOURCE = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) handle(JSON.parse(line));
    index = buffer.indexOf("\\n");
  }
});
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake", version: "1" },
    }});
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "echo", description: "echo the arguments", inputSchema: { type: "object" } },
      { name: "env", description: "report a variable", inputSchema: { type: "object" } },
    ]}});
    return;
  }
  if (message.method === "tools/call") {
    if (message.params.name === "env") {
      const name = message.params.arguments && message.params.arguments.name;
      send({ jsonrpc: "2.0", id: message.id, result: {
        content: [{ type: "text", text: String(process.env[name] === undefined ? "MISSING" : process.env[name]) }],
      }});
      return;
    }
    if (message.params.name === "fail") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        content: [{ type: "text", text: "deliberate failure" }], isError: true,
      }});
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: {
      content: [{ type: "text", text: JSON.stringify(message.params.arguments) }],
    }});
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
  }
}
`;

function writeServer(directory: string): string {
  const file = path.join(directory, "fake-mcp-server.mjs");
  writeFileSync(file, SERVER_SOURCE, "utf8");
  return file;
}

const allow: ApprovalGate = { decide: async (): Promise<ApprovalDecision> => "approved" };
const deny: ApprovalGate = { decide: async (): Promise<ApprovalDecision> => "denied" };

describe("MCP stdio connection", () => {
  it("completes the handshake and lists tools", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mcp-"));
    const server = writeServer(directory);
    const started = await connectMcpServer({
      serverId: "fake",
      command: process.execPath,
      args: [server],
      environment: { PATH: process.env["PATH"] ?? "" },
      cwd: directory,
      requestTimeoutMs: 10_000,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const tools = await started.connection.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["echo", "env"],
    );
    await started.connection.close();
  });

  it("calls a tool and returns its text", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mcp-"));
    const server = writeServer(directory);
    const started = await connectMcpServer({
      serverId: "fake",
      command: process.execPath,
      args: [server],
      environment: { PATH: process.env["PATH"] ?? "" },
      cwd: directory,
      requestTimeoutMs: 10_000,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const called = await started.connection.callTool("echo", { value: 42 });
    assert.equal(called.ok, true);
    assert.equal(called.ok ? called.text : null, '{"value":42}');
    assert.equal(called.ok ? called.isError : true, false);
    await started.connection.close();
  });

  it("reports a server-declared tool error as a failure result", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mcp-"));
    const server = writeServer(directory);
    const started = await connectMcpServer({
      serverId: "fake",
      command: process.execPath,
      args: [server],
      environment: { PATH: process.env["PATH"] ?? "" },
      cwd: directory,
      requestTimeoutMs: 10_000,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const called = await started.connection.callTool("fail", {});
    assert.equal(called.ok, true);
    assert.equal(called.ok ? called.isError : false, true);
    await started.connection.close();
  });

  it("fails when the executable does not exist", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mcp-"));
    const started = await connectMcpServer({
      serverId: "fake",
      command: path.join(directory, "does-not-exist.exe"),
      args: [],
      environment: {},
      cwd: directory,
      requestTimeoutMs: 3_000,
    });
    assert.equal(started.ok, false);
  });
});

describe("MCP startup", () => {
  it("does not spawn when approval is denied", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mcp-"));
    const server = writeServer(directory);
    const result = await startMcpServers({
      declared: [{ serverId: "fake", command: process.execPath, args: [server] }],
      workspaceRoot: directory,
      approvals: deny,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "approval_denied");
  });

  it("spawns, lists tools and namespaces them after approval", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mcp-"));
    const server = writeServer(directory);
    const result = await startMcpServers({
      declared: [{ serverId: "fake", command: process.execPath, args: [server] }],
      workspaceRoot: directory,
      approvals: allow,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.connections.length, 1);
    assert.deepEqual(
      result.connections[0]?.tools.map((tool) => tool.namespaced),
      ["mcp__fake__echo", "mcp__fake__env"],
    );
    await result.connections[0]?.connection.close();
  });

  it("removes a filtered credential name from the declared environment", async () => {
    // The declaration names a filtered variable. It must be absent in the child,
    // proving the filter runs after the merge rather than before.
    const directory = mkdtempSync(path.join(tmpdir(), "mcp-"));
    const server = writeServer(directory);
    const result = await startMcpServers({
      declared: [
        {
          serverId: "fake",
          command: process.execPath,
          args: [server],
          environment: { GITHUB_TOKEN: "leaked-value" },
        },
      ],
      workspaceRoot: directory,
      approvals: allow,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const connection = result.connections[0]?.connection;
    assert.notEqual(connection, undefined);
    const called = await connection?.callTool("env", { name: "GITHUB_TOKEN" });
    assert.equal(called?.ok, true);
    assert.equal(called?.ok ? called.text : null, "MISSING");
    await connection?.close();
  });

  it("reports a failed server without taking the Session down", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mcp-"));
    const server = writeServer(directory);
    const result = await startMcpServers({
      declared: [
        { serverId: "good", command: process.execPath, args: [server] },
        { serverId: "bad", command: path.join(directory, "missing.exe") },
      ],
      workspaceRoot: directory,
      approvals: allow,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.connections.length, 1);
    assert.equal(result.warnings.length, 1);
    await result.connections[0]?.connection.close();
  });

  it("rejects an invalid declaration before spawning anything", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mcp-"));
    const result = await startMcpServers({
      declared: [{ serverId: "Bad Id", command: "npx" }],
      workspaceRoot: directory,
      approvals: allow,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.code, "declaration_invalid");
  });
});

describe("launch resolution", () => {
  /**
   * Windows cannot spawn a .cmd batch file directly: Node raises EINVAL since the
   * fix for CVE-2024-27980. Most MCP servers are launched through npx, which is a
   * .cmd shim, so without this route every npx server fails to start.
   */
  it("routes a bare command through cmd.exe on Windows", () => {
    const launch = resolveLaunch(
      "npx",
      ["-y", "server"],
      "win32",
      "C:\\Windows\\system32\\cmd.exe",
    );
    assert.deepEqual(launch, {
      command: "C:\\Windows\\system32\\cmd.exe",
      args: ["/c", "npx", "-y", "server"],
    });
  });

  it("routes an explicit .cmd through cmd.exe", () => {
    const launch = resolveLaunch("C:\\tools\\server.cmd", ["--flag"], "win32", "cmd.exe");
    assert.equal(launch.command, "cmd.exe");
    assert.deepEqual(launch.args, ["/c", "C:\\tools\\server.cmd", "--flag"]);
  });

  it("routes a .bat through cmd.exe", () => {
    const launch = resolveLaunch("start.bat", [], "win32", "cmd.exe");
    assert.equal(launch.command, "cmd.exe");
    assert.deepEqual(launch.args, ["/c", "start.bat"]);
  });

  it("does not wrap an absolute .exe", () => {
    const launch = resolveLaunch("C:\\tools\\server.exe", ["--flag"], "win32", "cmd.exe");
    assert.deepEqual(launch, { command: "C:\\tools\\server.exe", args: ["--flag"] });
  });

  it("does not wrap an absolute path without an extension", () => {
    const launch = resolveLaunch("C:\\tools\\server", [], "win32", "cmd.exe");
    assert.deepEqual(launch, { command: "C:\\tools\\server", args: [] });
  });

  it("leaves a non-Windows launch untouched", () => {
    const launch = resolveLaunch("npx", ["-y", "server"], "linux", undefined);
    assert.deepEqual(launch, { command: "npx", args: ["-y", "server"] });
  });

  it("falls back to cmd.exe when there is no ComSpec", () => {
    // null is the explicit "none"; undefined would mean "look it up".
    const launch = resolveLaunch("npx", [], "win32", null);
    assert.equal(launch.command, "cmd.exe");
  });

  it("uses the ComSpec from the environment when not supplied", () => {
    const launch = resolveLaunch("npx", [], "win32");
    // Whatever the host has, the result must be an absolute shell path or the
    // literal fallback, never a bare command name.
    assert.equal(
      launch.command === "cmd.exe" || launch.command.toLowerCase().endsWith("cmd.exe"),
      true,
    );
  });

  it("keeps the command as a separate argument, not a concatenated string", () => {
    // Concatenating would let a command or argument influence cmd.exe quoting.
    const launch = resolveLaunch("npx", ["a b", "c&d"], "win32", "cmd.exe");
    assert.deepEqual(launch.args, ["/c", "npx", "a b", "c&d"]);
  });
});
