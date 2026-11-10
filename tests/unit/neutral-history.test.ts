import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  crossProviderHistory,
  decidePrivateReplay,
  isAuthorityBearing,
  type NeutralHistoryInput,
  type PrivateBlock,
  type ProviderRoute,
  validateNeutralHistory,
} from "../../src/domain/model-request/neutral-history.ts";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const ROUTE: ProviderRoute = {
  providerId: "provider-a",
  protocolId: "protocol-a",
  adapterVersion: "adapter-1",
  modelId: "model-a",
  endpointFingerprint: sha256("endpoint"),
  credentialIdentityRevision: 3,
};

function block(overrides: Partial<PrivateBlock> = {}): PrivateBlock {
  return {
    kind: "opaque_item",
    route: ROUTE,
    sourceRequestId: "req-1",
    itemType: "thinking_block",
    schemaVersion: 1,
    attachmentId: "att-1",
    returnedByVendor: true,
    ...overrides,
  };
}

describe("private data replay", () => {
  it("replays signatures and opaque items on the same route", () => {
    const decision = decidePrivateReplay({
      blocks: [block({ kind: "signature", attachmentId: "sig" }), block({ kind: "opaque_item" })],
      target: ROUTE,
      requiresSignatures: true,
    });
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.deepEqual(
      decision.replayable.map((entry) => entry.attachmentId),
      ["sig", "att-1"],
    );
  });

  it("reports reasoning summaries separately as ordinary material", () => {
    const decision = decidePrivateReplay({
      blocks: [block({ kind: "reasoning_summary", attachmentId: "sum" })],
      target: ROUTE,
      requiresSignatures: false,
    });
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.deepEqual(decision.replayable, []);
    assert.deepEqual(
      decision.includedSummaries.map((entry) => entry.attachmentId),
      ["sum"],
    );
  });

  it("refuses a block the vendor did not actually return", () => {
    const decision = decidePrivateReplay({
      blocks: [block({ returnedByVendor: false })],
      target: ROUTE,
      requiresSignatures: false,
    });
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.equal(decision.code, "private_data_not_returned_by_vendor");
  });

  it("refuses replay after the credential identity changed on the same provider", () => {
    const decision = decidePrivateReplay({
      blocks: [block()],
      target: { ...ROUTE, credentialIdentityRevision: 4 },
      requiresSignatures: false,
    });
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.equal(decision.code, "credential_identity_changed");
  });

  it("refuses a different provider when the adapter needs signatures", () => {
    const decision = decidePrivateReplay({
      blocks: [block({ kind: "signature" })],
      target: { ...ROUTE, providerId: "provider-b" },
      requiresSignatures: true,
    });
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.equal(decision.code, "protocol_history_incompatible");
  });

  it("skips foreign signatures rather than forging them when the adapter allows it", () => {
    const decision = decidePrivateReplay({
      blocks: [block({ kind: "signature" })],
      target: { ...ROUTE, providerId: "provider-b" },
      requiresSignatures: false,
    });
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.deepEqual(decision.replayable, []);
  });

  it("treats a changed model on the same provider as a different route", () => {
    const decision = decidePrivateReplay({
      blocks: [block({ kind: "signature" })],
      target: { ...ROUTE, modelId: "model-b" },
      requiresSignatures: true,
    });
    assert.equal(decision.ok, false);
    if (decision.ok) return;
    assert.equal(decision.code, "protocol_history_incompatible");
  });

  it("never claims a private block carries authority", () => {
    assert.equal(isAuthorityBearing(), false);
  });
});

describe("neutral history validation", () => {
  const valid: readonly NeutralHistoryInput[] = [
    { kind: "user", text: "read it", sourceId: "e1" },
    {
      kind: "assistant",
      text: null,
      toolCalls: [{ providerToolCallId: "call-1", toolName: "read_file" }],
      sourceId: "e2",
    },
    {
      kind: "tool_result",
      providerToolCallId: "call-1",
      toolName: "read_file",
      status: "succeeded",
      text: "body",
      sourceId: "e3",
    },
    { kind: "assistant", text: "done", toolCalls: [], sourceId: "e4" },
  ];

  it("accepts a paired history", () => {
    assert.deepEqual(validateNeutralHistory(valid), { ok: true });
  });

  it("rejects a tool result that answers no call", () => {
    const result = validateNeutralHistory([
      { kind: "user", text: "x", sourceId: "e1" },
      {
        kind: "tool_result",
        providerToolCallId: "ghost",
        toolName: "read_file",
        status: "succeeded",
        text: null,
        sourceId: "e2",
      },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unrenderable_history");
  });

  it("rejects a call that never received a result", () => {
    const result = validateNeutralHistory([
      {
        kind: "assistant",
        text: null,
        toolCalls: [{ providerToolCallId: "call-1", toolName: "read_file" }],
        sourceId: "e1",
      },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unrenderable_history");
  });

  it("rejects an assistant or user turn inserted between a call and its result", () => {
    const result = validateNeutralHistory([
      {
        kind: "assistant",
        text: null,
        toolCalls: [{ providerToolCallId: "call-1", toolName: "read_file" }],
        sourceId: "e1",
      },
      { kind: "user", text: "interrupt", sourceId: "e2" },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unrenderable_history");
  });

  it("rejects a duplicate call id", () => {
    const result = validateNeutralHistory([
      {
        kind: "assistant",
        text: null,
        toolCalls: [
          { providerToolCallId: "dup", toolName: "a" },
          { providerToolCallId: "dup", toolName: "b" },
        ],
        sourceId: "e1",
      },
    ]);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unrenderable_history");
  });

  it("records a cancelled result as a closed pair", () => {
    assert.deepEqual(
      validateNeutralHistory([
        {
          kind: "assistant",
          text: null,
          toolCalls: [{ providerToolCallId: "call-1", toolName: "read_file" }],
          sourceId: "e1",
        },
        {
          kind: "tool_result",
          providerToolCallId: "call-1",
          toolName: "read_file",
          status: "cancelled",
          text: null,
          sourceId: "e2",
        },
      ]),
      { ok: true },
    );
  });

  it("records an unknown outcome as a closed pair", () => {
    assert.deepEqual(
      validateNeutralHistory([
        {
          kind: "assistant",
          text: null,
          toolCalls: [{ providerToolCallId: "call-1", toolName: "shell" }],
          sourceId: "e1",
        },
        {
          kind: "tool_result",
          providerToolCallId: "call-1",
          toolName: "shell",
          status: "outcome_unknown",
          text: null,
          sourceId: "e2",
        },
      ]),
      { ok: true },
    );
  });
});

describe("cross-provider history", () => {
  it("keeps neutral content and real tool results", () => {
    const history: readonly NeutralHistoryInput[] = [
      { kind: "user", text: "x", sourceId: "e1" },
      {
        kind: "tool_result",
        providerToolCallId: "call-1",
        toolName: "read_file",
        status: "succeeded",
        text: "body",
        sourceId: "e2",
      },
    ];
    assert.deepEqual(crossProviderHistory(history), history);
  });

  it("does not invent or drop neutral items", () => {
    const history: readonly NeutralHistoryInput[] = [
      { kind: "user", text: "a", sourceId: "e1" },
      { kind: "assistant", text: "b", toolCalls: [], sourceId: "e2" },
    ];
    assert.equal(crossProviderHistory(history).length, 2);
  });
});
