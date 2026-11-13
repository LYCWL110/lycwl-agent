import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { JsonlCheckpointStore } from "../../../../src/adapters/persistence/jsonl-checkpoint-store.ts";
import { JsonlEventLog } from "../../../../src/adapters/persistence/jsonl-event-log.ts";
import { RuntimeCoordinator } from "../../../../src/application/coordinator/runtime-coordinator.ts";
import { deriveTaskReport } from "../../../../src/application/task-report/derive-task-report.ts";
import { assessRecovery } from "../../../../src/domain/persistence/recovery.ts";
import type { VerificationVerdict } from "../../../../src/domain/tool-invocation/execution-semantics.ts";
import type { ToolDefinition, ToolExecutor } from "../../../../src/ports/tool-executor.ts";
import { approveWhen, callTool, modelFrom, scriptedApprovals } from "../harness.ts";

/**
 * E10: what an unknown outcome means, and what it does not.
 *
 * The frozen branch: a mutating call is committed and then its result is lost. The
 * Harness must not guess. It keeps the call `outcome_unknown`, asks the adapter to
 * inspect its own effect without repeating it, and records that inspection as a
 * separate fact. A verified "applied" describes state; it is not a retroactive
 * success, and it never rewrites the execution outcome.
 *
 * The negative control is the important half. A verifier that re-ran the operation
 * would be the exact mistake this exists to prevent, so the fake adapter counts its
 * destructive sink separately from its executor: a verification that deleted again
 * would be visible here as a second sink call.
 */

const digests = {
  async sha256Canonical(value: unknown): Promise<string> {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  },
};
const ids = { create: () => randomUUID() };

type Counters = {
  /** Calls to the executor: the operation actually ran this many times. */
  executed: number;
  /** Calls to the destructive sink inside the executor. */
  sink: number;
  /** Calls to verifyOutcome. */
  verified: number;
  /** Provider call ids verifyOutcome was asked about. */
  verifiedCalls: string[];
};

/**
 * A tool whose execution outcome is unknown and whose effect is inspectable.
 *
 * `state` is the adapter's own record of what the sink did. verifyOutcome reads it
 * and never writes, which is what makes "applied" a statement about state rather
 * than a repeat.
 */
function unknownOutcomeTools(verdict: VerificationVerdict | null): {
  tools: ToolExecutor;
  counters: Counters;
  state: { deleted: boolean };
} {
  const counters: Counters = { executed: 0, sink: 0, verified: 0, verifiedCalls: [] };
  const state = { deleted: false };
  const definitions: Record<string, ToolDefinition> = {
    delete_path: {
      name: "delete_path",
      version: "1",
      sideEffectClass: "filesystem_mutation",
      semantics: { idempotent: true, retry: "conditional" },
      requiresApproval: true,
      concurrencySafe: false,
      uncertaintyGuidance: "inspect the target before retrying",
    },
  };
  return {
    counters,
    state,
    tools: {
      getDefinition: (name) => definitions[name] ?? null,
      discardApproval: () => undefined,
      async preview(request) {
        const args = request.arguments as { paths?: readonly string[] } | null;
        return `${request.toolName} paths=${(args?.paths ?? []).join(",")}`;
      },
      async execute(request) {
        counters.executed += 1;
        // The sink ran, so the effect may exist. The result is then lost: that is
        // what "unknown" models.
        counters.sink += 1;
        state.deleted = true;
        void request;
        return { status: "outcome_unknown" as const, safeCode: "result_lost" };
      },
      async verifyOutcome(request) {
        counters.verified += 1;
        counters.verifiedCalls.push(request.toolCallId);
        // Read-only inspection. Deliberately does not touch the sink.
        if (verdict === null) return null;
        if (verdict === "applied") return state.deleted ? "applied" : "not_applied";
        if (verdict === "not_applied") return state.deleted ? "inconclusive" : "not_applied";
        return "inconclusive";
      },
    },
  };
}

async function withCoordinator(
  tools: ToolExecutor,
  responses: Parameters<typeof modelFrom>[0],
  run: (context: {
    coordinator: RuntimeCoordinator;
    model: ReturnType<typeof modelFrom>;
    log: JsonlEventLog;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "e10-"));
  const model = modelFrom(responses);
  const gate = scriptedApprovals([approveWhen("delete_path")]);
  try {
    const log = new JsonlEventLog(root, ids, digests);
    const coordinator = new RuntimeCoordinator({
      provider: model.provider,
      tools,
      approvals: gate.gate,
      eventLog: log,
      checkpoints: new JsonlCheckpointStore(root, digests),
      ids,
      nowUtc: () => new Date().toISOString(),
      // Approval is not what E10 measures, so the gate answers inline. Suspending
      // would leave every test waiting for a reply that this case never sends.
      suspendOnApproval: false,
      sessionId: `e10-${randomUUID()}`,
    });
    await run({ coordinator, model, log });
    await coordinator.closeSession("close");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const DELETE_CALL = callTool("d1", "delete_path", { paths: ["stale.txt"] });

function finishedStatus(
  events: Awaited<ReturnType<RuntimeCoordinator["run"]>>["events"],
): string | null {
  const finished = events.find(
    ({ payload }) =>
      payload.kind === "tool_execution_finished" && payload.toolName === "delete_path",
  );
  return finished?.payload.kind === "tool_execution_finished" ? finished.payload.status : null;
}

describe("E10: an unknown outcome is never guessed", () => {
  it("keeps the original status unknown and records the inspection separately", async () => {
    const { tools, counters } = unknownOutcomeTools("applied");
    await withCoordinator(
      tools,
      () => DELETE_CALL,
      async ({ coordinator }) => {
        const result = await coordinator.run("delete the stale file");

        // The effect is present, so the Run is still a failure: the outcome of the
        // execution was never observed. Verification is not retroactive success.
        assert.equal(result.status, "failed");
        assert.equal(result.safeCode, "tool_outcome_unknown");
        assert.equal(finishedStatus(result.events), "outcome_unknown");

        const verification = result.events.find(
          ({ payload }) => payload.kind === "tool_outcome_verified",
        )?.payload;
        assert.ok(verification?.kind === "tool_outcome_verified");
        if (verification?.kind !== "tool_outcome_verified") return;
        assert.equal(verification.verdict, "applied");
        assert.equal(verification.toolCallId, "d1");

        // The operation ran exactly once and the check did not repeat it.
        assert.equal(counters.executed, 1);
        assert.equal(counters.sink, 1);
        assert.equal(counters.verified, 1);
        assert.deepEqual(counters.verifiedCalls, ["d1"]);
      },
    );
  });

  it("reports an inconclusive check as unresolved instead of inventing a verdict", async () => {
    const { tools, counters } = unknownOutcomeTools("inconclusive");
    await withCoordinator(
      tools,
      () => DELETE_CALL,
      async ({ coordinator }) => {
        const result = await coordinator.run("delete the stale file");

        assert.equal(result.status, "failed");
        assert.equal(result.safeCode, "tool_outcome_unknown");
        const verification = result.events.find(
          ({ payload }) => payload.kind === "tool_outcome_verified",
        )?.payload;
        assert.ok(verification?.kind === "tool_outcome_verified");
        if (verification?.kind !== "tool_outcome_verified") return;
        // Inconclusive is an answer, not a failure, and not a success.
        assert.equal(verification.verdict, "unresolved");

        const finished = result.events.find(
          ({ payload }) =>
            payload.kind === "tool_execution_finished" && payload.toolName === "delete_path",
        )?.payload;
        assert.ok(finished?.kind === "tool_execution_finished");
        // The event keeps the executor's real output (none) and its real status.
        // The guidance is appended to the conversation turn the model reads, not
        // retrofitted into the execution record.
        assert.equal(finished.status, "outcome_unknown");
        assert.equal(finished.text, null);
        assert.equal(counters.executed, 1);
        assert.equal(counters.sink, 1);
      },
    );
  });

  it("does not dispatch a sibling after an unknown outcome", async () => {
    const { tools, counters } = unknownOutcomeTools("applied");
    await withCoordinator(
      tools,
      () => ({
        kind: "completed",
        text: null,
        toolCalls: [
          { providerToolCallId: "d1", toolName: "delete_path", arguments: { paths: ["a.txt"] } },
          { providerToolCallId: "d2", toolName: "delete_path", arguments: { paths: ["b.txt"] } },
        ],
      }),
      async ({ coordinator, model }) => {
        const result = await coordinator.run("delete both files");

        assert.equal(result.status, "failed");
        assert.equal(counters.executed, 1, "the sibling must not run after an unknown");
        assert.equal(counters.sink, 1);
        assert.equal(model.requests.length, 1, "the model is not asked to continue");
      },
    );
  });
});

describe("E10: recovery never re-executes", () => {
  it("records the unknown as a known terminal fact and replays nothing", async () => {
    const { tools, counters } = unknownOutcomeTools("applied");
    await withCoordinator(
      tools,
      () => DELETE_CALL,
      async ({ coordinator, log, model }) => {
        const result = await coordinator.run("delete the stale file");
        assert.equal(result.status, "failed");

        // Recover from what actually reached disk, not from in-memory state.
        const stored = await log.read(result.events[0]?.sessionId ?? "");
        const assessment = assessRecovery(stored);
        assert.equal(assessment.ok, true);
        if (!assessment.ok) return;

        const call = assessment.value.calls.find((entry) => entry.toolCallId !== undefined);
        assert.ok(call);
        // The durable record holds a terminal fact: the outcome was `outcome_unknown`.
        // Reusing it means "do not run this again", not "it succeeded".
        assert.equal(call?.kind, "result_known");
        assert.equal(call?.kind === "result_known" ? call.status : null, "outcome_unknown");
        // The Run already ended as failed, so no review is pending and nothing is
        // revived. A grant cannot survive to authorize a replay.
        assert.equal(assessment.value.requiresRecoveryReview, false);
        assert.equal(assessment.value.nextRunState, "failed");
        assert.deepEqual(assessment.value.grantsToRevoke, []);

        // Reading the log again must not execute anything.
        assert.equal(counters.executed, 1);
        assert.equal(counters.sink, 1);
        assert.equal(model.requests.length, 1);
      },
    );
  });

  it("treats a crash before the result event as unknown and requiring review", async () => {
    const { tools, counters } = unknownOutcomeTools("applied");
    await withCoordinator(
      tools,
      () => DELETE_CALL,
      async ({ coordinator, log }) => {
        const result = await coordinator.run("delete the stale file");
        const stored = await log.read(result.events[0]?.sessionId ?? "");

        // Everything after the start of execution is lost, as a crash would lose it.
        const truncated = stored.slice(
          0,
          stored.findIndex(({ payload }) => payload.kind === "tool_execution_started") + 1,
        );
        const assessment = assessRecovery(truncated);
        assert.equal(assessment.ok, true);
        if (!assessment.ok) return;
        const call = assessment.value.calls.find((entry) => entry.toolCallId !== undefined);
        assert.equal(call?.kind, "outcome_unknown");
        // The effect may exist, so the caller must review rather than retry.
        assert.equal(assessment.value.requiresRecoveryReview, true);
        assert.equal(assessment.value.nextRunState, "waiting");

        // The durable prefix still proves the operation was committed and started.
        assert.ok(truncated.some(({ payload }) => payload.kind === "tool_dispatch_committed"));
        assert.equal(counters.executed, 1);
        assert.equal(counters.sink, 1);
      },
    );
  });

  it("does not append a success result for an unknown call", async () => {
    const { tools } = unknownOutcomeTools("applied");
    await withCoordinator(
      tools,
      () => DELETE_CALL,
      async ({ coordinator, log }) => {
        const result = await coordinator.run("delete the stale file");
        const stored = await log.read(result.events[0]?.sessionId ?? "");

        const finished = stored.filter(
          ({ payload }) =>
            payload.kind === "tool_execution_finished" && payload.toolName === "delete_path",
        );
        assert.equal(finished.length, 1);
        const payload = finished[0]?.payload;
        assert.ok(payload?.kind === "tool_execution_finished");
        // The verified fact never becomes a succeeded status.
        assert.equal(payload.status, "outcome_unknown");
        assert.equal(
          stored.some(
            ({ payload: entry }) =>
              entry.kind === "tool_execution_finished" && entry.status === "succeeded",
          ),
          false,
        );
      },
    );
  });
});

describe("E10: a model report does not settle an unknown", () => {
  it("keeps the unknown side effect visible in the derived report", async () => {
    const { tools } = unknownOutcomeTools("inconclusive");
    await withCoordinator(
      tools,
      () => DELETE_CALL,
      async ({ coordinator }) => {
        const result = await coordinator.run("delete the stale file");
        assert.equal(result.status, "failed");

        const sessionId = result.events[0]?.sessionId ?? "";
        const runId = result.events[0]?.runId ?? "";
        const derived = deriveTaskReport(result.events, sessionId, runId);
        assert.equal(derived.ok, true);
        if (!derived.ok) return;

        // The model never gets to say "done": the goal stays unknown, the unknown
        // side effect is listed, and the scope is indeterminate.
        const goal = derived.value.assertions.find((assertion) => assertion.required);
        assert.equal(goal?.state, "unknown");
        assert.equal(goal?.applicability, "indeterminate");
        assert.equal(derived.value.unknownSideEffects.length, 1);
        assert.match(derived.value.unknownSideEffects[0] ?? "", /delete_path:.*:approved/u);
        // An indeterminate scope is not merely unverified: it blocks the claim, so
        // no later reader can mistake this for a goal nobody got around to checking.
        assert.equal(derived.value.verification.status, "blocked");
      },
    );
  });

  it("produces no effect when the model only claims one", async () => {
    const { tools, counters } = unknownOutcomeTools("inconclusive");
    await withCoordinator(
      tools,
      () => ({ kind: "completed", text: "I deleted the file.", toolCalls: [] }),
      async ({ coordinator, model }) => {
        const result = await coordinator.run("delete the stale file");
        // A plain completion with no tool call. The claim is prose, not a fact:
        // nothing ran, and the model was asked exactly once.
        assert.equal(result.status, "completed");
        assert.equal(counters.executed, 0);
        assert.equal(counters.sink, 0);
        assert.equal(model.requests.length, 1);
      },
    );
  });
});
