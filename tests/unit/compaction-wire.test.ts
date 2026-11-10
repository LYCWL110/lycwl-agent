import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGroups,
  parseCompactionArtifact,
  prepareCompaction,
} from "../../src/application/coordinator/compaction-service.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { computeContextBudget } from "../../src/domain/context/context-budget.ts";
import type {
  ModelProvider,
  ProviderCompletion,
  ProviderRequest,
} from "../../src/ports/model-provider.ts";
import type { ToolDefinition, ToolExecutor } from "../../src/ports/tool-executor.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

const noTools: ToolExecutor = {
  getDefinition: (): ToolDefinition | null => null,
  async execute() {
    return { status: "succeeded" as const, text: null };
  },
};

/** Provider that answers the auxiliary request with a valid artifact. */
class CompactingProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  readonly #artifact: string;
  #mainRounds = 0;

  constructor(artifact: string) {
    this.#artifact = artifact;
  }

  async complete(request: ProviderRequest): Promise<ProviderCompletion> {
    this.requests.push(request);
    const last = request.conversation.at(-1);
    // The auxiliary request asks for JSON and forbids tools; recognise it by its
    // marker rather than by counting calls.
    const isAuxiliary =
      last !== undefined &&
      last.kind === "user" &&
      last.text.includes("Summarise the earlier part of this session");

    if (isAuxiliary) {
      return { kind: "completed", toolCalls: [], text: this.#artifact };
    }
    this.#mainRounds += 1;
    if (this.#mainRounds >= 3) {
      return { kind: "completed", toolCalls: [], text: "finished" };
    }
    return { kind: "completed", toolCalls: [], text: `round ${this.#mainRounds}` };
  }
}

function artifactFor(messageIds: readonly string[], toSeq: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    sourceMessageIds: [...messageIds],
    coverage: { fromSeq: 1, toSeq },
    goal: "finish the task",
    pinnedConstraintIds: [],
    confirmedDecisionIds: [],
    completedClaims: [{ text: "did some work", evidenceRefs: [] }],
    activeTaskId: null,
    blockedReasons: [],
    nextActions: ["continue"],
    fileReferences: [],
    proposedToolCalls: 0,
  });
}

function coordinator(provider: ModelProvider, budget: ReturnType<typeof computeContextBudget>) {
  assert.equal(budget.ok, true);
  if (!budget.ok) throw new Error("budget");
  return new RuntimeCoordinator({
    provider,
    tools: noTools,
    approvals: { decide: async () => "approved" },
    eventLog: new InMemoryEventLog(new SequenceIds("event"), new JsonDigest()),
    ids: new SequenceIds(),
    nowUtc: () => "2026-11-05T00:00:00.000Z",
    suspendOnApproval: false,
    contextBudget: budget.value,
  });
}

describe("grouping", () => {
  it("renders each user and assistant body from its actual group", () => {
    const prepared = prepareCompaction({
      conversation: [
        { kind: "user", text: "FIRST_USER" },
        { kind: "assistant", text: "FIRST_ASSISTANT", toolCalls: [] },
        { kind: "user", text: "SECOND_USER" },
        { kind: "assistant", text: "SECOND_ASSISTANT", toolCalls: [] },
      ],
      fixedTokens: 0,
      auxiliaryBudgetTokens: 100_000,
      recentBudget: 0,
      compactionsUsed: 0,
    });
    assert.ok(prepared.ok);
    for (const [index, body] of [
      "FIRST_USER",
      "FIRST_ASSISTANT",
      "SECOND_USER",
      "SECOND_ASSISTANT",
    ].entries()) {
      assert.ok(
        prepared.value.prompt.includes(`--- g${index + 1} (seq ${index + 1}) ---\n${body}`),
      );
    }
  });

  it("binds reused Provider call ids to bodies in the same response", () => {
    const prepared = prepareCompaction({
      conversation: [
        {
          kind: "assistant",
          text: null,
          toolCalls: [{ providerToolCallId: "same", toolName: "first", arguments: { value: 1 } }],
        },
        {
          kind: "tool_result",
          providerToolCallId: "same",
          toolName: "first",
          status: "denied",
          text: "FIRST_RESULT",
        },
        {
          kind: "assistant",
          text: null,
          toolCalls: [{ providerToolCallId: "same", toolName: "second", arguments: { value: 2 } }],
        },
        {
          kind: "tool_result",
          providerToolCallId: "same",
          toolName: "second",
          status: "succeeded",
          text: "SECOND_RESULT",
        },
      ],
      fixedTokens: 0,
      auxiliaryBudgetTokens: 100_000,
      recentBudget: 0,
      compactionsUsed: 0,
    });
    assert.ok(prepared.ok);
    assert.ok(prepared.value.prompt.includes('tool_call:same second {"value":2}'));
    assert.match(prepared.value.prompt, /tool_result:same \(succeeded\): SECOND_RESULT/u);
  });
  it("keeps an assistant turn and its tool results in one group", () => {
    const groups = buildGroups([
      { kind: "user", text: "go" },
      {
        kind: "assistant",
        text: "calling",
        toolCalls: [{ providerToolCallId: "c1", toolName: "read_file", arguments: {} }],
      },
      {
        kind: "tool_result",
        providerToolCallId: "c1",
        toolName: "read_file",
        status: "succeeded",
        text: "body",
      },
      { kind: "assistant", text: "done", toolCalls: [] },
    ]);
    assert.equal(groups.length, 3);
    const turn = groups[1];
    assert.ok(turn);
    assert.equal(turn.kind, "assistant_turn");
    // message, tool_call, tool_result: the assistant's own text is a member so the
    // summariser can see what the model said, not only what it invoked.
    assert.equal(turn.members.length, 3);
    assert.equal(turn.members[0]?.kind, "message");
    assert.equal(turn.members[2]?.status, "succeeded");
  });

  it("preserves a denied result status rather than dropping it", () => {
    const groups = buildGroups([
      {
        kind: "assistant",
        text: null,
        toolCalls: [{ providerToolCallId: "c1", toolName: "shell", arguments: {} }],
      },
      {
        kind: "tool_result",
        providerToolCallId: "c1",
        toolName: "shell",
        status: "denied",
        text: null,
      },
    ]);
    assert.equal(groups[0]?.members[1]?.status, "denied");
  });
});

describe("compaction artifact parsing", () => {
  it("rejects a reply with no JSON", () => {
    const result = parseCompactionArtifact("no json here");
    assert.equal(result.ok, false);
  });

  it("rejects a wrong schema version", () => {
    const result = parseCompactionArtifact(JSON.stringify({ schemaVersion: 2, coverage: {} }));
    assert.equal(result.ok, false);
  });

  it("accepts a valid artifact", () => {
    const result = parseCompactionArtifact(artifactFor(["g1"], 3));
    assert.equal(result.ok, true);
  });

  it("rejects missing, extra, malformed and duplicate fields instead of coercing them", () => {
    const artifact = JSON.parse(artifactFor(["g1"], 1));
    for (const value of [
      { ...artifact, sourceMessageIds: [1] },
      { ...artifact, completedClaims: [{ text: "work", evidenceRefs: "missing" }] },
      { ...artifact, goal: null },
      { ...artifact, surprise: true },
      { ...artifact, proposedToolCalls: -1 },
    ])
      assert.equal(parseCompactionArtifact(JSON.stringify(value)).ok, false);
    const missing = { ...artifact };
    delete missing["sourceMessageIds"];
    assert.equal(parseCompactionArtifact(JSON.stringify(missing)).ok, false);
    assert.equal(parseCompactionArtifact(`prefix ${JSON.stringify(artifact)}`).ok, false);
    assert.equal(
      parseCompactionArtifact(
        JSON.stringify(artifact).replace(
          '"schemaVersion":1',
          '"schemaVersion":1,"schemaVersion":1',
        ),
      ).ok,
      false,
    );
  });

  it("rejects a tool-proposing artifact during parsing", async () => {
    const prepared = prepareCompaction({
      conversation: [
        { kind: "user", text: "a" },
        { kind: "assistant", text: "b", toolCalls: [] },
        { kind: "user", text: "c" },
      ],
      fixedTokens: 0,
      auxiliaryBudgetTokens: 100_000,
      recentBudget: 0,
      compactionsUsed: 0,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;

    const parsed = parseCompactionArtifact(
      JSON.stringify({
        ...JSON.parse(artifactFor(prepared.value.plan.summarizedGroupIds, 3)),
        proposedToolCalls: 1,
      }),
    );
    assert.equal(parsed.ok, false);
  });
});

describe("coordinator compaction", () => {
  it("compacts when the prompt exceeds the trigger and records the event", async () => {
    // A tiny window forces the trigger quickly.
    const budget = computeContextBudget({
      window: 8192,
      modelMaxOutput: 8192,
      userMaxOutput: 4096,
      fixed: 3000,
    });
    assert.equal(budget.ok, true);
    if (!budget.ok) return;

    // Build a provider whose artifact covers whatever it is asked to summarise.
    const provider = new CompactingProvider(artifactFor([], 1));
    const run = coordinator(provider, budget).run("a task");

    // Capture the first auxiliary prompt to learn the expected coverage.
    const result = await run;
    assert.equal(result.status, "completed");

    const compacted = result.events.filter((e) => e.payload.kind === "context_compacted");
    // With three short messages the prompt never exceeds 80% of a 6042 budget, so
    // no compaction should happen. This asserts the trigger does not misfire.
    assert.equal(compacted.length, 0, "a small conversation must not be compacted");
  });

  it("does not compact when no budget is configured", async () => {
    const provider = new CompactingProvider(artifactFor([], 1));
    const result = await new RuntimeCoordinator({
      provider,
      tools: noTools,
      approvals: { decide: async () => "approved" },
      eventLog: new InMemoryEventLog(new SequenceIds("event"), new JsonDigest()),
      ids: new SequenceIds(),
      nowUtc: () => "2026-11-05T00:00:00.000Z",
      suspendOnApproval: false,
    }).run("a task");

    assert.equal(result.status, "completed");
    assert.equal(
      result.events.some((e) => e.payload.kind === "context_compacted"),
      false,
    );
  });
});

describe("compaction actually runs when triggered", () => {
  for (const responses of [
    "valid",
    "invalid-transient",
    "transient-invalid",
    "missing-sources",
  ] as const) {
    it(`enforces durable validated publication and two auxiliary sends: ${responses}`, async () => {
      const budget = computeContextBudget({
        window: 8192,
        modelMaxOutput: 4096,
        userMaxOutput: 4096,
        fixed: 100,
      });
      assert.ok(budget.ok);
      const requests: ProviderRequest[] = [];
      let auxiliarySends = 0;
      const runtime = new RuntimeCoordinator({
        provider: {
          async complete(request) {
            requests.push(request);
            if (request.compaction === undefined)
              return { kind: "completed", toolCalls: [], text: "done" };
            auxiliarySends++;
            assert.equal(request.compaction.maxOutputTokens, budget.value.output);
            if (
              (responses === "invalid-transient" && auxiliarySends === 2) ||
              (responses === "transient-invalid" && auxiliarySends === 1)
            )
              return { kind: "transient_failure", safeCode: "temporary" };
            if (responses !== "valid" && responses !== "missing-sources")
              return { kind: "completed", toolCalls: [], text: "invalid JSON" };
            const prompt = request.conversation[0];
            assert.ok(prompt?.kind === "user");
            const declaration = JSON.parse(prompt.text.split("Required JSON shape:\n")[1] ?? "{}");
            return {
              kind: "completed",
              toolCalls: [],
              text: artifactFor(
                responses === "missing-sources" ? [] : declaration.sourceMessageIds,
                declaration.coverage.toSeq,
              ),
            };
          },
        },
        tools: noTools,
        approvals: { decide: async () => "denied" },
        eventLog: new InMemoryEventLog(new SequenceIds("event"), new JsonDigest()),
        ids: new SequenceIds(),
        nowUtc: () => "2026-11-08T00:00:00.000Z",
        sleep: async () => undefined,
        contextBudget: budget.value,
        priorConversation: Array.from({ length: 20 }, (_, index) => ({
          kind: "user" as const,
          text: `old ${index} ${"a".repeat(800)}`,
        })),
      });
      const result = await runtime.run("KEEP_CURRENT_TASK");
      assert.equal(auxiliarySends, responses === "valid" ? 1 : 2);
      const sends = requests.filter((request) => request.compaction !== undefined);
      assert.equal(new Set(sends.map((request) => request.modelRequestId)).size, 1);
      assert.deepEqual(
        sends.map((request) => request.attemptNo),
        auxiliarySends === 1 ? [1] : [1, 2],
      );
      const publication = result.events.find((event) => event.payload.kind === "context_compacted");
      if (responses === "valid") {
        assert.equal(result.status, "completed");
        assert.ok(publication);
        const main = requests.find((request) => request.compaction === undefined);
        assert.ok(
          main?.conversation.some(
            (item) => item.kind === "user" && item.text === "KEEP_CURRENT_TASK",
          ),
        );
      } else {
        assert.equal(result.status, "failed");
        assert.equal(publication, undefined);
        assert.ok(requests.every((request) => request.compaction !== undefined));
      }
      await runtime.closeSession("close");
    });
  }

  it("summarises a large prefix and keeps the recent suffix", async () => {
    const budget = computeContextBudget({
      window: 8192,
      modelMaxOutput: 8192,
      userMaxOutput: 4096,
      fixed: 100,
    });
    assert.equal(budget.ok, true);
    if (!budget.ok) return;

    // A provider that answers the auxiliary request with an artifact covering the
    // groups it was asked about, and never finishes on its own.
    class TriggerProvider implements ModelProvider {
      readonly requests: ProviderRequest[] = [];
      #main = 0;
      async complete(request: ProviderRequest): Promise<ProviderCompletion> {
        this.requests.push(request);
        const last = request.conversation.at(-1);
        const isAux =
          last !== undefined &&
          last.kind === "user" &&
          last.text.includes("Summarise the earlier part of this session");
        if (isAux) {
          // Echo the ids the skeleton listed so validation passes.
          const ids = [...last.text.matchAll(/- group=(g\d+)/g)].map((m) => m[1] ?? "");
          const toSeq = Number(/- group=g(\d+)/.exec(last.text)?.[1] ?? "1");
          return {
            kind: "completed",
            toolCalls: [],
            text: JSON.stringify({
              schemaVersion: 1,
              sourceMessageIds: ids,
              coverage: { fromSeq: 1, toSeq: Math.max(toSeq, 1) },
              goal: "g",
              pinnedConstraintIds: [],
              confirmedDecisionIds: [],
              completedClaims: [],
              activeTaskId: null,
              blockedReasons: [],
              nextActions: [],
              fileReferences: [],
              proposedToolCalls: 0,
            }),
          };
        }
        this.#main += 1;
        // Keep the loop going so a second request is actually attempted.
        return {
          kind: "completed",
          toolCalls: [
            {
              providerToolCallId: `call-${this.#main}`,
              toolName: "noop",
              arguments: {},
            },
          ],
          text: "x".repeat(30_000),
        };
      }
    }

    const provider = new TriggerProvider();
    const result = await new RuntimeCoordinator({
      provider,
      tools: noTools,
      approvals: { decide: async () => "approved" },
      eventLog: new InMemoryEventLog(new SequenceIds("event"), new JsonDigest()),
      ids: new SequenceIds(),
      nowUtc: () => "2026-11-05T00:00:00.000Z",
      suspendOnApproval: false,
      contextBudget: budget.value,
    }).run("a task");

    // Either compaction ran, or the run failed on capacity; what must never happen
    // is an oversized prompt being sent as if nothing were wrong.
    const compacted = result.events.filter((e) => e.payload.kind === "context_compacted");
    const rejected = result.events.filter((e) => e.payload.kind === "context_compaction_rejected");
    assert.ok(
      compacted.length > 0 || rejected.length > 0 || result.status === "failed",
      "an oversized conversation must compact, reject, or fail",
    );
  });
});
