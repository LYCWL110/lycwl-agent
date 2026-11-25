import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";
import { TEST_CERT_PEM, TEST_KEY_PEM } from "../fakes/web-cert.ts";

let root = "";
let server: Server | null = null;
let port = 0;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-web-"));
  await new Promise<void>((resolve) => {
    server = createServer({ cert: TEST_CERT_PEM, key: TEST_KEY_PEM }, (request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/elsewhere" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>real fetch body</html>");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      port = typeof address === "object" && address !== null ? address.port : 0;
      resolve();
    });
  });
});

after(async () => {
  if (server !== null) await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

function tools(enableWeb: boolean) {
  return createWorkspaceTools({
    workspaceRoot: root,
    approvals: { decide: async () => "approved" },
    ids: { create: () => "id" },
    enableWrites: false,
    enableProcesses: false,
    enableWeb,
  });
}

describe("web tools through the composition root", () => {
  it("is exposed by default unless web is explicitly disabled", () => {
    const t = createWorkspaceTools({
      workspaceRoot: root,
      approvals: { decide: async () => "approved" },
      ids: { create: () => "id" },
      enableWrites: false,
      enableProcesses: false,
    });
    for (const toolName of ["web_fetch", "web_search"]) {
      assert.ok(t.getDefinition(toolName), `${toolName} must be available by default`);
    }
  });

  it("keeps fetch but hides Harness search when the Provider searches natively", async () => {
    const t = createWorkspaceTools({
      workspaceRoot: root,
      approvals: { decide: async () => "approved" },
      ids: { create: () => "id" },
      enableWrites: false,
      enableProcesses: false,
      enableWeb: true,
      enableWebSearch: false,
    });
    assert.equal(t.getDefinition("web_search"), null);
    assert.ok(t.getDefinition("web_fetch"));
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "web_search",
      arguments: { query: "x" },
    });
    assert.deepEqual(result, {
      status: "failed",
      safeCode: "tool_unavailable_in_build",
      text: null,
    });
  });

  it("stays unavailable when web is disabled", async () => {
    const t = tools(false);
    for (const toolName of ["web_fetch", "web_search"]) {
      const result = await t.execute({
        toolCallId: "c1",
        toolName,
        arguments: { url: "https://example.com/", query: "x" },
      });
      assert.deepEqual(result, {
        status: "failed",
        safeCode: "tool_unavailable_in_build",
        text: null,
      });
    }
  });

  it("declares both web tools as approval-required external requests", () => {
    const t = tools(true);
    for (const toolName of ["web_fetch", "web_search"]) {
      const definition = t.getDefinition(toolName);
      assert.equal(definition?.requiresApproval, true, `${toolName} must need approval`);
      assert.equal(definition?.sideEffectClass, "external_request");
    }
  });

  it("refuses WebSearch because no paid backend is configured", async () => {
    const t = tools(true);
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "web_search",
      arguments: { query: "typescript" },
    });

    // Surcharge review is not configured, so the request is refused before send.
    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(
      result.safeCode === "fee_classification_unknown" ||
        result.safeCode === "search_backend_not_configured",
      true,
    );
  });

  it("previews WebFetch with the resolved address set", async () => {
    const t = tools(true);
    const preview = await t.preview?.({
      toolCallId: "c1",
      toolName: "web_fetch",
      arguments: { url: `https://localhost:${port}/` },
    });

    assert.match(preview ?? "", /localhost/);
    assert.match(preview ?? "", /127\.0\.0\.1\[loopback\]/);
    assert.match(preview ?? "", /warning=target resolves to a non-public address/);
    assert.match(preview ?? "", /redirects=never followed automatically/);
    assert.match(preview ?? "", /login=no browser session/);
  });

  it("rejects an unsupported scheme before any network call", async () => {
    const t = tools(true);
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "web_fetch",
      arguments: { url: "ftp://example.com/file" },
    });
    assert.deepEqual(result, {
      status: "failed",
      safeCode: "unsupported_scheme",
      text: null,
    });
  });

  it("rejects a disallowed header", async () => {
    const t = tools(true);
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "web_fetch",
      arguments: {
        url: `https://localhost:${port}/`,
        headers: { Authorization: "Bearer secret" },
      },
    });
    assert.deepEqual(result, {
      status: "failed",
      safeCode: "header_not_allowed",
      text: null,
    });
  });
});
