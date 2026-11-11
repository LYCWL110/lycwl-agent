import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { JsonlCheckpointStore } from "../../src/adapters/persistence/jsonl-checkpoint-store.ts";
import { JsonlEventLog } from "../../src/adapters/persistence/jsonl-event-log.ts";
import { createSpillStore } from "../../src/adapters/persistence/spill-store.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type { ProviderCompletion } from "../../src/ports/model-provider.ts";
import type { ToolDefinition, ToolExecutionResult } from "../../src/ports/tool-executor.ts";

/**
 * Completeness through a real Run.
 *
 * The field must reach the recorded event, not only the text: a report or a replay
 * reads the event, and a marker in prose can be paraphrased away by a later summary.
 */

const digests = {
  async sha256Canonical(value: unknown): Promise<string> {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  },
};
const ids = { create: () => randomUUID() };

/** One tool call, then finish. */
function oneCall(): { complete: () => Promise<ProviderCompletion> } {
  let calls = 0;
  return {
    async complete(): Promise<ProviderCompletion> {
      calls += 1;
      if (calls === 1) {
        return {
          kind: "completed",
          toolCalls: [{ providerToolCallId: "c1", toolName: "probe", arguments: {} }],
          text: null,
        };
      }
      return { kind: "completed", toolCalls: [], text: "done" };
    },
  };
}

async function runWith(
  toolResult: ToolExecutionResult,
  options: { spill?: boolean } = {},
): Promise<
  | Extract<
      import("../../src/ports/event-log.ts").InternalEvent["payload"],
      { kind: "tool_execution_finished" }
    >
  | undefined
> {
  const root = await mkdtemp(path.join(tmpdir(), "completeness-"));
  try {
    const coordinator = new RuntimeCoordinator({
      provider: oneCall(),
      tools: {
        getDefinition(name: string): ToolDefinition | null {
          if (name !== "probe") return null;
          return {
            name: "probe",
            version: "1",
            sideEffectClass: "read_only",
            requiresApproval: false,
            concurrencySafe: true,
          };
        },
        discardApproval: () => undefined,
        async execute(): Promise<ToolExecutionResult> {
          return toolResult;
        },
        async verifyOutcome() {
          return null;
        },
      },
      approvals: { decide: async () => "approved" },
      eventLog: new JsonlEventLog(root, ids, digests),
      checkpoints: new JsonlCheckpointStore(root, digests),
      ids,
      nowUtc: () => new Date().toISOString(),
      suspendOnApproval: false,
      // A unique id per run: the event log holds an exclusive writer lock, so two
      // concurrent tests sharing an id fail the append.
      sessionId: `ws-completeness-${randomUUID()}`,
      ...(options.spill === true
        ? {
            spillStore: createSpillStore({
              sessionDirectory: path.join(root, "s"),
              workspaceRoot: root,
            }),
          }
        : {}),
    });
    const outcome = await coordinator.run("go");
    await coordinator.closeSession("close");
    const finished = outcome.events.find(
      (event) => event.payload.kind === "tool_execution_finished",
    );
    return finished?.payload.kind === "tool_execution_finished" ? finished.payload : undefined;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("completeness recorded on the event", () => {
  it("omits the field for a small complete result", async () => {
    // Absent means complete; writing `complete` on every call would be noise.
    const finished = await runWith({ status: "succeeded", text: "small" });
    assert.equal(finished?.completeness, undefined);
  });

  it("records partial with a reason when output is spilled", async () => {
    const finished = await runWith(
      { status: "succeeded", text: "x".repeat(50_000) },
      { spill: true },
    );
    assert.equal(finished?.completeness?.outcome, "partial");
    assert.equal(finished?.completeness?.reason, "spilled");
    // The continuation must point somewhere, or the model cannot reach the rest.
    assert.match(finished?.completeness?.continuation ?? "", /stored copy|spill/);
  });

  it("records unconfirmed for an unknown outcome, not partial", async () => {
    // The distinction matters: partial means "there is more", unconfirmed means
    // "nobody knows".
    const finished = await runWith({ status: "outcome_unknown", safeCode: "timeout" });
    assert.equal(finished?.completeness?.outcome, "unconfirmed");
    assert.equal(finished?.completeness?.reason, "unverified");
  });

  it("leaves a failed result without completeness", async () => {
    // A confirmed failure is not incomplete; it is over.
    const finished = await runWith({ status: "failed", safeCode: "boom", text: null });
    assert.equal(finished?.completeness, undefined);
  });

  it("keeps the text marker alongside the field", async () => {
    // The model reads text; a report reads the field. Both carry the fact.
    const finished = await runWith(
      { status: "succeeded", text: "x".repeat(50_000) },
      { spill: true },
    );
    assert.match(finished?.text ?? "", /output spilled/);
    assert.equal(finished?.completeness?.outcome, "partial");
  });

  it("survives a full read of the log", async () => {
    // The validator must accept the optional field, or the append fails and the
    // whole Run aborts.
    const root = await mkdtemp(path.join(tmpdir(), "completeness-read-"));
    try {
      const coordinator = new RuntimeCoordinator({
        provider: oneCall(),
        tools: {
          getDefinition: (name) =>
            name === "probe"
              ? {
                  name: "probe",
                  version: "1",
                  sideEffectClass: "read_only",
                  requiresApproval: false,
                  concurrencySafe: true,
                }
              : null,
          discardApproval: () => undefined,
          async execute() {
            return { status: "outcome_unknown" as const, safeCode: "timeout" };
          },
          async verifyOutcome() {
            return null;
          },
        },
        approvals: { decide: async () => "approved" },
        eventLog: new JsonlEventLog(root, ids, digests),
        checkpoints: new JsonlCheckpointStore(root, digests),
        ids,
        nowUtc: () => new Date().toISOString(),
        suspendOnApproval: false,
        sessionId: "ws-read",
      });
      await coordinator.run("go");
      const read = await new JsonlEventLog(root, ids, digests).readWithRecovery("ws-read");
      assert.equal(read.ok, true);
      if (!read.ok) return;
      const finished = read.events.find(
        (event) => event.payload.kind === "tool_execution_finished",
      );
      assert.equal(
        finished?.payload.kind === "tool_execution_finished"
          ? finished.payload.completeness?.outcome
          : null,
        "unconfirmed",
      );
      await coordinator.closeSession("close");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
