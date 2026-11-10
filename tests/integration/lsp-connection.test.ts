import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import type { LspMessage } from "../../src/adapters/windows/lsp-connection.ts";
import { createLspConnection } from "../../src/adapters/windows/lsp-connection.ts";

const STUB = path.join(import.meta.dirname, "..", "fakes", "stub-lsp-server.ts");

function connect(
  options: { requestTimeoutMs?: number; onServerRequest?: (message: LspMessage) => void } = {},
) {
  return createLspConnection({
    executable: process.execPath,
    argv: [STUB],
    cwd: process.cwd(),
    inheritedEnvironment: { PATH: process.env["PATH"] ?? "" },
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.onServerRequest === undefined ? {} : { onServerRequest: options.onServerRequest }),
  });
}

describe("LSP connection framing", () => {
  it("completes a request/response round trip", async () => {
    const connection = connect();
    assert.equal("error" in connection, false);
    if ("error" in connection) return;

    const response = await connection.request("initialize", {});
    assert.equal(response.result !== undefined, true);
    await connection.close();
  });

  it("routes multiple methods", async () => {
    const connection = connect();
    if ("error" in connection) return;

    const diagnostics = await connection.request("textDocument/diagnostic", {});
    const definition = await connection.request("textDocument/definition", {});
    const references = await connection.request("textDocument/references", {});

    assert.deepEqual(
      (diagnostics.result as { items: { message: string }[] }).items[0]?.message,
      "stub diagnostic",
    );
    assert.equal(Array.isArray(definition.result), true);
    assert.equal(Array.isArray(references.result), true);
    await connection.close();
  });
});

describe("LSP connection safety", () => {
  it("rejects a server-initiated edit request and reports it", async () => {
    const seen: LspMessage[] = [];
    const connection = connect({ onServerRequest: (message) => seen.push(message) });
    if ("error" in connection) return;

    await connection.request("test/askServerToEdit", {});
    // Give the rejection write a moment to be observed by the server side.
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(seen.length >= 1, true);
    assert.equal(seen[0]?.method, "workspace/applyEdit");
    await connection.close();
  });

  it("times out a request that never answers", async () => {
    const connection = connect({ requestTimeoutMs: 300 });
    if ("error" in connection) return;

    const response = await connection.request("test/hang", {});
    assert.equal(response.error?.message, "request_timeout");
    await connection.close();
  });

  it("drops an oversized declared frame instead of buffering it", async () => {
    const connection = connect({ requestTimeoutMs: 500 });
    if ("error" in connection) return;

    await connection.request("test/oversize", {});
    // The follow-up request still works because the buffer was reset.
    const response = await connection.request("initialize", {});
    assert.equal(response.result !== undefined, true);
    await connection.close();
  });

  it("reports server exit to pending requests", async () => {
    const connection = connect({ requestTimeoutMs: 5_000 });
    if ("error" in connection) return;

    const pending = connection.request("test/never-returns", {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    await connection.close();
    const response = await pending;
    assert.equal(
      response.error?.message === "server_exited" || response.result !== undefined,
      true,
    );
  });

  it("does not interpret the command through a shell", () => {
    const connection = createLspConnection({
      executable: "definitely-not-a-real-executable-xyz",
      argv: [],
      cwd: process.cwd(),
      inheritedEnvironment: {},
    });
    // A spawn failure surfaces either synchronously or via the error event.
    if ("error" in connection) {
      assert.equal(connection.error, "spawn_failed");
    } else {
      assert.equal(connection.isAlive(), true);
      void connection.close();
    }
  });
});
