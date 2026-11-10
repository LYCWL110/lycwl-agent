import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import {
  emptyOwnedKeyRegistry,
  type OwnedKeyRegistry,
  registerOwnedKey,
} from "../../src/domain/security/owned-key-guard.ts";
import { guardText, guardToolResultText } from "../../src/services/security/guarded-delivery.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedApprovalGate,
  ScriptedProvider,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

const KEY = "sk-owned-abcdef0123456789";

function registryWith(...values: readonly string[]): OwnedKeyRegistry {
  let registry = emptyOwnedKeyRegistry();
  values.forEach((value, index) => {
    const result = registerOwnedKey(registry, { keyId: `key-${index}`, value });
    assert.equal(result.ok, true);
    if (result.ok) registry = result.registry;
  });
  return registry;
}

function build(
  responses: readonly {
    kind: "completed";
    toolCalls: readonly {
      providerToolCallId: string;
      toolName: string;
      arguments: unknown;
    }[];
    text: string | null;
  }[],
  toolText: string | null,
  ownedKeys?: OwnedKeyRegistry,
) {
  const ids = new SequenceIds("guard");
  const digests = new JsonDigest();
  const eventLog = new InMemoryEventLog(ids, digests);
  const coordinator = new RuntimeCoordinator({
    provider: new ScriptedProvider(responses),
    tools: new RecordingTools(false, { status: "succeeded", text: toolText }),
    approvals: new ScriptedApprovalGate([]),
    eventLog,
    ids,
    nowUtc: () => "2026-11-02T00:00:00.000Z",
    sleep: async () => undefined,
    ...(ownedKeys === undefined ? {} : { ownedKeys }),
  });
  return { coordinator };
}

describe("guarded text delivery", () => {
  it("passes text through when no keys are registered", () => {
    assert.deepEqual(guardText(emptyOwnedKeyRegistry(), `anything ${KEY}`), {
      kind: "delivered",
      text: `anything ${KEY}`,
    });
  });

  it("delivers ordinary text unchanged", () => {
    assert.deepEqual(guardText(registryWith(KEY), "ordinary output"), {
      kind: "delivered",
      text: "ordinary output",
    });
  });

  it("blocks a payload containing the key", () => {
    assert.deepEqual(guardText(registryWith(KEY), `leak ${KEY} here`), {
      kind: "blocked",
      reason: "owned_key_detected",
    });
  });

  it("blocks a key split across the internal chunk boundary", () => {
    const filler = "x".repeat(512 - 5);
    const split = `${filler}${KEY}`;
    assert.deepEqual(guardText(registryWith(KEY), split), {
      kind: "blocked",
      reason: "owned_key_detected",
    });
  });

  it("keeps the tool status but drops the text when blocked", () => {
    assert.deepEqual(guardToolResultText(registryWith(KEY), "succeeded", `out ${KEY}`), {
      status: "succeeded",
      text: null,
      deliveryBlocked: true,
      reason: "owned_key_detected",
    });
  });

  it("leaves a null tool text alone", () => {
    assert.deepEqual(guardToolResultText(registryWith(KEY), "failed", null), {
      status: "failed",
      text: null,
      deliveryBlocked: false,
    });
  });
});

describe("owned-key guard inside the Runtime", () => {
  it("delivers ordinary tool output normally", async () => {
    const { coordinator } = build(
      [
        {
          kind: "completed",
          toolCalls: [{ providerToolCallId: "p1", toolName: "write_note", arguments: {} }],
          text: null,
        },
        { kind: "completed", toolCalls: [], text: "done" },
      ],
      "safe output",
      registryWith(KEY),
    );

    const result = await coordinator.run("task");
    assert.equal(result.status, "completed");
    assert.equal(result.text, "done");
  });

  it("blocks a tool result that contains an owned key", async () => {
    const { coordinator } = build(
      [
        {
          kind: "completed",
          toolCalls: [{ providerToolCallId: "p1", toolName: "write_note", arguments: {} }],
          text: null,
        },
        { kind: "completed", toolCalls: [], text: "recovered" },
      ],
      `accidental ${KEY} leak`,
      registryWith(KEY),
    );

    const result = await coordinator.run("task");

    // The call still executed and succeeded; only its text was withheld.
    assert.equal(result.status, "waiting");
    assert.equal(result.safeCode, "protected_delivery_blocked");
    const finished = result.events.find(
      (event) => event.payload.kind === "tool_execution_finished",
    );
    assert.equal(finished?.payload.kind, "tool_execution_finished");
    if (finished?.payload.kind !== "tool_execution_finished") return;
    assert.equal(finished.payload.status, "succeeded");

    const recordedText = finished.payload.text ?? "";
    assert.equal(recordedText.includes(KEY), false);
  });

  it("waits for recovery when the final assistant text contains an owned key", async () => {
    const { coordinator } = build(
      [{ kind: "completed", toolCalls: [], text: `here is the key: ${KEY}` }],
      null,
      registryWith(KEY),
    );

    const result = await coordinator.run("task");

    assert.equal(result.status, "waiting");
    assert.equal(result.safeCode, "protected_delivery_blocked");
    assert.equal(result.text, null);
    assert.notEqual(
      result.events.find((event) => event.payload.kind === "tool_result_delivery_blocked"),
      undefined,
    );
    // The key must not appear anywhere in the recorded events.
    assert.equal(JSON.stringify(result.events).includes(KEY), false);
  });

  it("does not block anything when the registry is empty", async () => {
    const { coordinator } = build(
      [{ kind: "completed", toolCalls: [], text: `text mentioning ${KEY}` }],
      null,
      emptyOwnedKeyRegistry(),
    );

    const result = await coordinator.run("task");
    assert.equal(result.status, "completed");
    assert.equal(result.text, `text mentioning ${KEY}`);
  });
});
