import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  boundLspText,
  canUseInstance,
  formatDiagnostics,
  formatLocations,
  LSP_LIMITS,
  type LspInstance,
  normalizeDiagnostics,
  normalizeLocations,
  rejectServerInitiatedRequest,
  requiresReapproval,
  validateLspMessageSize,
  validatePosition,
} from "../../src/domain/language/lsp.ts";

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

describe("LSP instance approval", () => {
  it("allows a ready, approved instance", () => {
    const result = canUseInstance(instance());
    assert.equal(result.ok, true);
  });

  it("refuses an unapproved or non-ready instance", () => {
    assert.deepEqual(canUseInstance(instance({ approvedInstanceId: "other" })), {
      ok: false,
      code: "instance_not_approved",
    });
    assert.deepEqual(canUseInstance(instance({ state: "starting" })), {
      ok: false,
      code: "instance_not_ready",
    });
    assert.deepEqual(canUseInstance(null), { ok: false, code: "not_found" });
  });

  it("requires reapproval when the execution identity is gone or changed", () => {
    assert.equal(requiresReapproval(instance(), "exec-1"), false);
    assert.equal(requiresReapproval(instance(), "exec-2"), true);
    assert.equal(requiresReapproval(instance({ executionIdentity: null }), "exec-1"), true);
  });
});

describe("LSP position validation", () => {
  it("accepts zero-based non-negative positions", () => {
    assert.deepEqual(validatePosition({ line: 0, character: 0 }), {
      ok: true,
      value: { line: 0, character: 0 },
    });
  });

  it("rejects negative or non-integer positions", () => {
    for (const value of [null, {}, { line: -1, character: 0 }, { line: 1.5, character: 0 }]) {
      assert.equal(validatePosition(value).ok, false);
    }
  });
});

describe("LSP message and result bounds", () => {
  it("accepts a message within the hard cap and rejects one above it", () => {
    assert.deepEqual(validateLspMessageSize(1024), { ok: true, value: 1024 });
    assert.deepEqual(validateLspMessageSize(LSP_LIMITS.maxMessageBytes + 1), {
      ok: false,
      code: "message_too_large",
    });
  });

  it("normalizes diagnostics and caps the count", () => {
    const raw = [
      { path: "a.ts", line: 1, character: 2, severity: "error", message: "bad", source: "ts" },
      { path: "b.ts", line: 0, character: 0, severity: "hint", message: "note" },
    ];
    const result = normalizeDiagnostics(raw);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.length, 2);
    assert.equal(result.value[1]?.source, null);
  });

  it("rejects a malformed or unknown severity diagnostic", () => {
    assert.equal(
      normalizeDiagnostics([{ path: "a", line: 0, character: 0, severity: "fatal", message: "m" }])
        .ok,
      false,
    );
    assert.equal(normalizeDiagnostics([{ path: "a", line: 0 }]).ok, false);
    assert.equal(normalizeDiagnostics("nope").ok, false);
  });

  it("normalizes locations and caps the count", () => {
    const result = normalizeLocations([{ path: "a.ts", line: 3, character: 4 }]);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, [{ path: "a.ts", line: 3, character: 4 }]);
    assert.equal(normalizeLocations([{ path: "a" }]).ok, false);
  });

  it("bounds model-facing text", () => {
    assert.equal(boundLspText("short"), "short");
    const long = "x".repeat(LSP_LIMITS.maxModelUnits + 10);
    assert.match(boundLspText(long), /\[truncated: model budget\]/);
  });
});

describe("LSP server-initiated requests", () => {
  it("always rejects edits and execute-command requests", () => {
    for (const kind of ["edit", "execute_command", "other"] as const) {
      assert.deepEqual(rejectServerInitiatedRequest({ method: "x", kind }), {
        ok: false,
        code: "server_initiated_request_rejected",
      });
    }
  });
});

describe("LSP formatting", () => {
  it("reports no diagnostics explicitly", () => {
    assert.equal(formatDiagnostics([]), "lsp_diagnostics: no diagnostics");
  });

  it("lists each diagnostic with its source", () => {
    const text = formatDiagnostics([
      {
        path: "a.ts",
        line: 1,
        character: 2,
        severity: "error",
        message: "bad",
        source: "ts",
      },
    ]);
    assert.match(text, /a\.ts:1:2 error bad \[ts\]/);
  });

  it("reports no locations explicitly", () => {
    assert.equal(formatLocations("lsp_definition", []), "lsp_definition: no locations");
    assert.match(
      formatLocations("lsp_references", [{ path: "a.ts", line: 1, character: 0 }]),
      /lsp_references: 1 location\(s\)/,
    );
  });
});
