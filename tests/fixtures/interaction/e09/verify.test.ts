import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { JsonlCheckpointStore } from "../../../../src/adapters/persistence/jsonl-checkpoint-store.ts";
import { JsonlEventLog } from "../../../../src/adapters/persistence/jsonl-event-log.ts";
import { RuntimeCoordinator } from "../../../../src/application/coordinator/runtime-coordinator.ts";
import { computeContextBudget } from "../../../../src/domain/context/context-budget.ts";
import type {
  ProviderConversationItem,
  ProviderRequest,
} from "../../../../src/ports/model-provider.ts";
import type { ToolDefinition, ToolExecutor } from "../../../../src/ports/tool-executor.ts";
import {
  approveWhen,
  callTool,
  compactionArtifact,
  isCompactionRequest,
  modelFrom,
  say,
  scriptedApprovals,
  until,
} from "../harness.ts";

/**
 * E09: what survives a compaction.
 *
 * The frozen branch: a synthetic history already contains the constraints and
 * execution facts a summary could silently destroy — an early immutable-file rule, a
 * completed change, a denied mutation and an outcome-unknown shell command. The Run
 * input carries the newest correction. A small verified window forces exactly one
 * compaction, then the model is allowed one small fix.
 *
 * Two things are asserted separately because they are different claims:
 *
 * - **The summariser was told the truth.** Its request must pin every terminal
 *   status verbatim, so it cannot present a denial or an unknown as success.
 * - **The next main request is safe.** The current correction must be verbatim (it
 *   is pinned, not summarised), and the summary must not turn a listed next action
 *   into an executed command.
 *
 * What must not happen: the forbidden file being written, a completed change being
 * repeated, or a shorter summary passing because it dropped a source.
 */

const digests = {
  async sha256Canonical(value: unknown): Promise<string> {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  },
};
const ids = { create: () => randomUUID() };

type Recorded = { executed: number; names: string[]; paths: string[] };

function recordingTools(): { tools: ToolExecutor; record: Recorded } {
  const record: Recorded = { executed: 0, names: [], paths: [] };
  const definitions: Record<string, ToolDefinition> = {
    edit_file: {
      name: "edit_file",
      version: "1",
      sideEffectClass: "filesystem_mutation",
      requiresApproval: true,
      concurrencySafe: false,
    },
    read_file: {
      name: "read_file",
      version: "1",
      sideEffectClass: "read_only",
      requiresApproval: false,
      concurrencySafe: true,
    },
    shell: {
      name: "shell",
      version: "1",
      sideEffectClass: "process_execution",
      requiresApproval: true,
      concurrencySafe: false,
    },
  };
  return {
    record,
    tools: {
      getDefinition: (name) => definitions[name] ?? null,
      discardApproval: () => undefined,
      async preview(request) {
        const args = request.arguments as { path?: string; command?: string } | null;
        return `${request.toolName} path=${args?.path ?? "?"} command=${args?.command ?? "?"}`;
      },
      async execute(request) {
        record.executed += 1;
        record.names.push(request.toolName);
        const target = (request.arguments as { path?: string } | null)?.path;
        if (typeof target === "string") record.paths.push(target);
        return { status: "succeeded" as const, text: "done" };
      },
    },
  };
}

/** Padding that pushes the prompt over the compaction trigger without exceeding it. */
const PADDING = `ARCHIVE-NOTE ${"x".repeat(15_800)}`;

/**
 * The synthetic history, in the order a Session would have recorded it.
 *
 * Every item is labelled as test data and mirrors a fixture initial state; nothing
 * here claims that a real user task produced it.
 */
const PRIOR: readonly ProviderConversationItem[] = [
  {
    kind: "user",
    text:
      "[synthetic-history; evaluation fixture]\n" +
      "TASK: fix the boundary in src/chunks.ts.\n" +
      "CONSTRAINT: never modify src/frozen.ts — it is generated.",
  },
  {
    kind: "assistant",
    text: null,
    toolCalls: [
      {
        providerToolCallId: "prior-edit-chunks",
        toolName: "edit_file",
        arguments: { path: "src/chunks.ts" },
      },
    ],
  },
  {
    kind: "tool_result",
    providerToolCallId: "prior-edit-chunks",
    toolName: "edit_file",
    status: "succeeded",
    text: "wrote src/chunks.ts",
  },
  {
    kind: "assistant",
    text: null,
    toolCalls: [
      {
        providerToolCallId: "prior-edit-frozen",
        toolName: "edit_file",
        arguments: { path: "src/frozen.ts" },
      },
    ],
  },
  {
    kind: "tool_result",
    providerToolCallId: "prior-edit-frozen",
    toolName: "edit_file",
    status: "denied",
    text: null,
  },
  {
    kind: "assistant",
    text: null,
    toolCalls: [
      { providerToolCallId: "prior-shell", toolName: "shell", arguments: { command: "npm test" } },
    ],
  },
  {
    kind: "tool_result",
    providerToolCallId: "prior-shell",
    toolName: "shell",
    status: "outcome_unknown",
    text: null,
  },
  { kind: "user", text: PADDING },
];

const CORRECTION =
  "CORRECTION: keep the UTF-8 BOM, do not touch src/frozen.ts, and finish the boundary fix in src/chunks.ts.";

const BUDGET = (() => {
  const computed = computeContextBudget({
    window: 8192,
    modelMaxOutput: 4096,
    userMaxOutput: 4096,
    fixed: 100,
  });
  assert.equal(computed.ok, true, computed.ok ? "" : computed.code);
  if (!computed.ok) throw new Error("budget");
  return computed.value;
})();

/** The artifact a competent summariser would return for this history. */
function goodArtifact(request: ProviderRequest) {
  return compactionArtifact(request, {
    goal: "finish the boundary fix without touching the generated file",
    confirmedDecisionIds: ["keep-bom"],
    completedClaims: [
      // Evidence-free: must be rendered as unverified narration, never as fact.
      { text: "the boundary fix is complete", evidenceRefs: [] },
      // Backed by a recorded result, so it may be stated as completed.
      { text: "src/chunks.ts was edited", evidenceRefs: ["prior-edit-chunks"] },
    ],
    blockedReasons: ["editing src/frozen.ts was denied", "shell npm test has an unknown outcome"],
    // An unapproved next step. It may be summarised, but it must not execute.
    nextActions: ["run the full test suite"],
    fileReferences: ["src/chunks.ts"],
  });
}

async function withCoordinator(
  options: Readonly<{
    handler: (request: ProviderRequest) => ReturnType<typeof say> | Promise<ReturnType<typeof say>>;
    approvals?: Parameters<typeof scriptedApprovals>[0];
  }>,
  run: (context: {
    coordinator: RuntimeCoordinator;
    model: ReturnType<typeof modelFrom>;
    record: Recorded;
    result: () => Awaited<ReturnType<RuntimeCoordinator["run"]>> | null;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "e09-"));
  const model = modelFrom(options.handler);
  const gate = scriptedApprovals(options.approvals ?? [approveWhen("src/chunks.ts")]);
  const { tools, record } = recordingTools();
  const result: Awaited<ReturnType<RuntimeCoordinator["run"]>> | null = null;
  try {
    const coordinator = new RuntimeCoordinator({
      provider: model.provider,
      tools,
      approvals: gate.gate,
      eventLog: new JsonlEventLog(root, ids, digests),
      checkpoints: new JsonlCheckpointStore(root, digests),
      ids,
      nowUtc: () => new Date().toISOString(),
      suspendOnApproval: true,
      sessionId: `e09-${randomUUID()}`,
      contextBudget: BUDGET,
      priorConversation: PRIOR,
    });
    await run({ coordinator, model, record, result: () => result });
    await coordinator.closeSession("close");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function compactionRequests(model: ReturnType<typeof modelFrom>): readonly ProviderRequest[] {
  return model.requests.filter(isCompactionRequest);
}

function mainRequests(model: ReturnType<typeof modelFrom>): readonly ProviderRequest[] {
  return model.requests.filter((request) => !isCompactionRequest(request));
}

function conversationText(request: ProviderRequest): string {
  return request.conversation
    .map((item) => {
      if (item.kind === "user") return item.text;
      if (item.kind === "assistant") return item.text ?? "";
      return item.text ?? "";
    })
    .join("\n");
}

describe("E09: the summariser is told the truth", () => {
  it("pins every terminal status and the constraint in the auxiliary request", async () => {
    let mainRounds = 0;
    await withCoordinator(
      {
        handler: (request) => {
          if (isCompactionRequest(request)) return goodArtifact(request);
          mainRounds += 1;
          if (mainRounds === 1) return callTool("m1", "edit_file", { path: "src/chunks.ts" });
          return say("Boundary fixed.");
        },
      },
      async ({ coordinator, model }) => {
        const runPromise = coordinator.run(CORRECTION);
        await until(() => coordinator.pendingApprovalView() !== null, {
          label: "post-compaction approval",
        });
        const pending = coordinator.pendingApprovalView();
        if (pending !== null) {
          await coordinator.replyApproval({
            commandId: "approve-1",
            approvalId: pending.approvalId,
            toolCallId: pending.toolCallId,
            requestVersion: pending.requestVersion,
            decision: "approved",
          });
        }
        const result = await runPromise;
        assert.equal(result.status, "completed");

        const sends = compactionRequests(model);
        assert.equal(sends.length, 1, "exactly one compaction request");
        const prompt = conversationText(sends[0] as ProviderRequest);
        // A denial and an unknown outcome cannot be silently upgraded: the skeleton
        // states them verbatim, and the constraint is visible to the summariser.
        assert.match(prompt, /prior-edit-frozen status=denied/u);
        assert.match(prompt, /prior-shell status=outcome_unknown/u);
        assert.match(prompt, /prior-edit-chunks status=succeeded/u);
        assert.match(prompt, /never modify src\/frozen\.ts/u);
        // The auxiliary request never carries executable tools.
        assert.notEqual(sends[0]?.compaction, undefined);
      },
    );
  });
});

describe("E09: the next main request is safe", () => {
  it("keeps the correction verbatim, records the unknown, and executes nothing unapproved", async () => {
    let mainRounds = 0;
    await withCoordinator(
      {
        handler: (request) => {
          if (isCompactionRequest(request)) return goodArtifact(request);
          mainRounds += 1;
          if (mainRounds === 1) return callTool("m1", "edit_file", { path: "src/chunks.ts" });
          return say("Boundary fixed.");
        },
      },
      async ({ coordinator, model, record }) => {
        const runPromise = coordinator.run(CORRECTION);
        await until(() => coordinator.pendingApprovalView() !== null);
        const pending = coordinator.pendingApprovalView();
        if (pending !== null) {
          await coordinator.replyApproval({
            commandId: "approve-1",
            approvalId: pending.approvalId,
            toolCallId: pending.toolCallId,
            requestVersion: pending.requestVersion,
            decision: "approved",
          });
        }
        const result = await runPromise;
        assert.equal(result.status, "completed");

        const compacted = result.events.filter(
          (event) => event.payload.kind === "context_compacted",
        );
        assert.equal(compacted.length, 1, "exactly one compaction was published");
        const publication = compacted[0]?.payload;
        assert.ok(publication?.kind === "context_compacted");
        if (publication?.kind !== "context_compacted") return;

        // C04 numbers are unchanged: the auxiliary request fitted its budget.
        assert.ok(publication.estimatedAuxiliaryTokens <= BUDGET.window);
        assert.ok(publication.summaryText.includes("[context-summary]"));

        const mains = mainRequests(model);
        const afterCompaction = mains[0];
        assert.notEqual(afterCompaction, undefined);
        if (afterCompaction === undefined) return;
        const text = conversationText(afterCompaction);

        // The newest correction is pinned, not summarised away.
        assert.ok(text.includes(CORRECTION), "the current correction must stay verbatim");
        // The summary carries the blocked facts rather than presenting success.
        assert.match(text, /blocked: editing src\/frozen\.ts was denied/u);
        assert.match(text, /blocked: shell npm test has an unknown outcome/u);
        // An evidence-free claim stays marked as unverified.
        assert.match(text, /claim\(unverified\): the boundary fix is complete/u);

        // The listed next action is text, not execution.
        assert.match(text, /next: run the full test suite/u);
        assert.equal(
          record.names.includes("shell"),
          false,
          "an unapproved next action must not run",
        );

        // The forbidden file was never written, and the allowed fix ran once.
        assert.deepEqual(record.paths, ["src/chunks.ts"]);
        assert.equal(record.executed, 1);
      },
    );
  });
});

describe("E09: a shorter summary is not automatically better", () => {
  it("rejects an artifact that drops its sources even though it is shorter", async () => {
    let shortLength = 0;
    let goodLength = 0;
    await withCoordinator(
      {
        handler: (request) => {
          if (!isCompactionRequest(request)) return say("unreachable");
          const good = goodArtifact(request);
          goodLength = good.text?.length ?? 0;
          // Shorter because it declares no coverage at all. Validation must reject
          // it rather than reward it for being small.
          const short = compactionArtifact(request, { sourceMessageIds: [], completedClaims: [] });
          shortLength = short.text?.length ?? 0;
          return short;
        },
      },
      async ({ coordinator, model, record }) => {
        const result = await coordinator.run(CORRECTION);

        assert.equal(result.status, "failed");
        assert.equal(result.safeCode, "context_compaction_invalid");
        assert.ok(shortLength > 0 && shortLength < goodLength, "the rejected artifact is shorter");

        // Two auxiliary sends under one logical request, and no publication.
        const sends = compactionRequests(model);
        assert.equal(sends.length, 2);
        assert.equal(new Set(sends.map((request) => request.modelRequestId)).size, 1);
        assert.equal(
          result.events.some((event) => event.payload.kind === "context_compacted"),
          false,
        );
        const rejected = result.events.flatMap((event) =>
          event.payload.kind === "context_compaction_rejected" ? [event.payload.reason] : [],
        );
        // One rejection per invalid send, then a final "attempts_exhausted". The
        // exhausted record is not a third send: only two requests went out.
        assert.deepEqual(rejected, ["invalid_artifact", "invalid_artifact", "attempts_exhausted"]);

        // Nothing was sent as a main request and nothing executed.
        assert.equal(mainRequests(model).length, 0);
        assert.equal(record.executed, 0);
      },
    );
  });

  it("rejects an artifact that proposes a tool call and dispatches nothing", async () => {
    await withCoordinator(
      {
        handler: (request) =>
          isCompactionRequest(request)
            ? compactionArtifact(request, { proposedToolCalls: 1 })
            : say("unreachable"),
      },
      async ({ coordinator, model, record }) => {
        const result = await coordinator.run(CORRECTION);

        assert.equal(result.status, "failed");
        assert.equal(result.safeCode, "context_compaction_invalid");
        assert.equal(compactionRequests(model).length, 2);
        assert.equal(record.executed, 0);
        assert.equal(
          result.events.some((event) => event.payload.kind === "context_compacted"),
          false,
        );
      },
    );
  });
});
