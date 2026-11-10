import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createLspTools,
  LSP_DEFINITION_DEFINITION,
  LSP_DIAGNOSTICS_DEFINITION,
  LSP_REFERENCES_DEFINITION,
  type LspToolDependencies,
} from "../../src/adapters/tools/lsp-tools.ts";
import { LSP_LIMITS, type LspInstance } from "../../src/domain/language/lsp.ts";

function instance(overrides: Partial<LspInstance> = {}): LspInstance {
  return {
    instanceId: "lsp-1",
    sessionId: "session-1",
    serverId: "typescript",
    state: "ready",
    approvedInstanceId: "lsp-1",
    executionIdentity: "exec-1",
    ...overrides,
  };
}

type Fixture = {
  tool: ReturnType<typeof createLspTools>;
  calls: string[];
};

function fixture(
  options: {
    current?: LspInstance | null;
    liveIdentity?: string | null;
    diagnosticsPayload?: unknown;
    locationsPayload?: unknown;
    messageBytes?: number;
    unknown?: boolean;
  } = {},
): Fixture {
  const calls: string[] = [];
  const dependencies: LspToolDependencies = {
    getInstance: () => (options.current === undefined ? instance() : options.current),
    getLiveIdentity: () => (options.liveIdentity === undefined ? "exec-1" : options.liveIdentity),
    diagnostics: async (_instance, path) => {
      calls.push(`diagnostics:${path}`);
      if (options.unknown === true) return { kind: "unknown", safeCode: "server_lost" };
      return {
        kind: "result",
        payload: options.diagnosticsPayload ?? [],
        messageBytes: options.messageBytes ?? 128,
      };
    },
    definition: async (_instance, path, position) => {
      calls.push(`definition:${path}:${position.line}:${position.character}`);
      if (options.unknown === true) return { kind: "unknown", safeCode: "server_lost" };
      return {
        kind: "result",
        payload: options.locationsPayload ?? [],
        messageBytes: options.messageBytes ?? 128,
      };
    },
    references: async (_instance, path, position) => {
      calls.push(`references:${path}:${position.line}:${position.character}`);
      if (options.unknown === true) return { kind: "unknown", safeCode: "server_lost" };
      return {
        kind: "result",
        payload: options.locationsPayload ?? [],
        messageBytes: options.messageBytes ?? 128,
      };
    },
  };
  return { tool: createLspTools(dependencies), calls };
}

describe("LSP tool definitions", () => {
  it("declares three read-only, approval-free tools", () => {
    const f = fixture();
    for (const definition of [
      LSP_DIAGNOSTICS_DEFINITION,
      LSP_DEFINITION_DEFINITION,
      LSP_REFERENCES_DEFINITION,
    ]) {
      assert.equal(f.tool.getDefinition(definition.name), definition);
      assert.equal(definition.sideEffectClass, "read_only");
      assert.equal(definition.requiresApproval, false);
    }
  });
});

describe("LSP instance gating", () => {
  it("refuses when no instance exists", async () => {
    const f = fixture({ current: null });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "lsp_diagnostics",
      arguments: { path: "a.ts" },
    });
    assert.deepEqual(result, { status: "failed", safeCode: "not_found", text: null });
    assert.equal(f.calls.length, 0);
  });

  it("refuses an instance that was never approved", async () => {
    const f = fixture({ current: instance({ approvedInstanceId: null }) });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "lsp_diagnostics",
      arguments: { path: "a.ts" },
    });
    assert.deepEqual(result, {
      status: "failed",
      safeCode: "instance_not_approved",
      text: null,
    });
  });

  it("requires fresh approval after a restart changes the live identity", async () => {
    const f = fixture({ liveIdentity: "exec-2" });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "lsp_diagnostics",
      arguments: { path: "a.ts" },
    });
    assert.deepEqual(result, {
      status: "failed",
      safeCode: "instance_not_approved",
      text: null,
    });
    assert.equal(f.calls.length, 0);
  });
});

describe("lsp_diagnostics", () => {
  it("reports no diagnostics explicitly", async () => {
    const f = fixture({ diagnosticsPayload: [] });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "lsp_diagnostics",
      arguments: { path: "a.ts" },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.text, "lsp_diagnostics: no diagnostics");
  });

  it("lists diagnostics with severity and source", async () => {
    const f = fixture({
      diagnosticsPayload: [
        {
          path: "a.ts",
          line: 4,
          character: 2,
          severity: "error",
          message: "Type mismatch",
          source: "ts",
        },
      ],
    });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "lsp_diagnostics",
      arguments: { path: "a.ts" },
    });
    assert.equal(result.status, "succeeded");
    assert.match(result.text ?? "", /a\.ts:4:2 error Type mismatch \[ts\]/);
  });

  it("fails explicitly when the response exceeds the message cap", async () => {
    const f = fixture({ messageBytes: LSP_LIMITS.maxMessageBytes + 1 });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "lsp_diagnostics",
      arguments: { path: "a.ts" },
    });
    assert.deepEqual(result, {
      status: "failed",
      safeCode: "message_too_large",
      text: null,
    });
  });

  it("reports an unknown server outcome", async () => {
    const f = fixture({ unknown: true });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "lsp_diagnostics",
      arguments: { path: "a.ts" },
    });
    assert.deepEqual(result, { status: "outcome_unknown", safeCode: "server_lost" });
  });
});

describe("lsp_definition and lsp_references", () => {
  it("returns locations for a valid position", async () => {
    const f = fixture({
      locationsPayload: [{ path: "b.ts", line: 10, character: 0 }],
    });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "lsp_definition",
      arguments: { path: "a.ts", position: { line: 3, character: 7 } },
    });
    assert.equal(result.status, "succeeded");
    assert.match(result.text ?? "", /lsp_definition: 1 location\(s\)/);
    assert.match(result.text ?? "", /b\.ts:10:0/);
    assert.deepEqual(f.calls, ["definition:a.ts:3:7"]);
  });

  it("reports no locations without claiming an error", async () => {
    const f = fixture({ locationsPayload: [] });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "lsp_references",
      arguments: { path: "a.ts", position: { line: 0, character: 0 } },
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.text, "lsp_references: no locations");
  });

  it("rejects an invalid position before calling the server", async () => {
    const f = fixture();
    const cases: readonly (readonly [unknown, string])[] = [
      [undefined, "invalid_arguments"],
      [{ line: -1, character: 0 }, "invalid_position"],
      [{ line: 1.5, character: 0 }, "invalid_position"],
    ];
    for (const [position, expected] of cases) {
      const result = await f.tool.execute({
        toolCallId: "call-1",
        toolName: "lsp_definition",
        arguments: { path: "a.ts", position },
      });
      assert.deepEqual(result, {
        status: "failed",
        safeCode: expected,
        text: null,
      });
    }
    assert.equal(f.calls.length, 0);
  });

  it("rejects a missing path", async () => {
    const f = fixture();
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "lsp_references",
      arguments: { position: { line: 0, character: 0 } },
    });
    assert.deepEqual(result, {
      status: "failed",
      safeCode: "invalid_arguments",
      text: null,
    });
  });
});
