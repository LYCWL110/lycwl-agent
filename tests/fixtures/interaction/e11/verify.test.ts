import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { JsonlCheckpointStore } from "../../../../src/adapters/persistence/jsonl-checkpoint-store.ts";
import { JsonlEventLog } from "../../../../src/adapters/persistence/jsonl-event-log.ts";
import {
  BACKGROUND_OUTPUT_DEFINITION,
  BACKGROUND_START_DEFINITION,
  BACKGROUND_STATUS_DEFINITION,
  BACKGROUND_STOP_DEFINITION,
} from "../../../../src/adapters/tools/background-tools.ts";
import { RuntimeCoordinator } from "../../../../src/application/coordinator/runtime-coordinator.ts";
import type {
  BackgroundObserver,
  BackgroundTaskFact,
} from "../../../../src/ports/background-task.ts";
import type { ToolDefinition, ToolExecutor } from "../../../../src/ports/tool-executor.ts";
import { approveWhen, callTool, modelFrom, say, scriptedApprovals } from "../harness.ts";

/**
 * E11: a launched background task is not a finished test.
 *
 * The frozen branch: the user asks to wait for a background test. The launch is
 * approved per invocation, then the runner reports a matching terminal fact before
 * the final report. The Harness must treat the launch as a start only, attribute the
 * terminal state by `taskId`+`processExecutionId`, advance once, and keep the report
 * consistent with what the runner actually said.
 *
 * The stand-in below records a stop request rather than terminating a real process
 * tree. That is deliberate and limited: it can prove which identity the Harness
 * asked to stop, and it cannot prove real Windows cleanup. G02 remains the owner of
 * that evidence.
 */

const digests = {
  async sha256Canonical(value: unknown): Promise<string> {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  },
};
const ids = { create: () => randomUUID() };

type Launched = {
  /** The coordinator's internal call id, which the observer validates. */
  toolCallId: string;
  owner: Readonly<{ sessionId: string; runId: string }>;
  taskId: string;
  processExecutionId: string;
};

/**
 * A fact before the registry stamps its observation time.
 *
 * `Omit` over a union collapses the discriminant, so this distributes over the
 * union members instead: each variant keeps its own `state`/`processId` shape.
 */
type PendingFact = BackgroundTaskFact extends infer Fact
  ? Fact extends BackgroundTaskFact
    ? Omit<Fact, "observedAtUtc">
    : never
  : never;

type Harness = {
  tools: ToolExecutor;
  /** Report a supervisor fact exactly as the real registry would. */
  emit: (fact: PendingFact) => Promise<void>;
  launched: Launched[];
  /** Every taskId the Harness asked to stop, never a PID. */
  stops: string[];
};

/**
 * A background executor that answers the four tools without spawning anything.
 *
 * `observeBackground` is where the real registry hands terminal facts to the
 * Runtime; keeping that path means the coordinator's ownership check and
 * de-duplication are exercised, not bypassed.
 */
function backgroundHarness(): Harness {
  const definitions: readonly ToolDefinition[] = [
    BACKGROUND_START_DEFINITION,
    BACKGROUND_STATUS_DEFINITION,
    BACKGROUND_OUTPUT_DEFINITION,
    BACKGROUND_STOP_DEFINITION,
  ];
  const launched: Launched[] = [];
  const stops: string[] = [];
  const observers = new Set<BackgroundObserver>();
  let counter = 0;

  /** Stamp and deliver one fact to every registered observer. */
  async function emitFact(fact: PendingFact): Promise<void> {
    // Spreading a discriminated union widens `state` back to the union of all
    // states, so the stamped object is asserted to be a fact. The registry
    // constructs its facts the same way; this mirrors it rather than bypassing
    // the ownership check the coordinator applies to the observer.
    const complete = {
      ...fact,
      observedAtUtc: new Date().toISOString(),
    } as BackgroundTaskFact;
    for (const observer of observers) await observer(complete);
  }

  return {
    launched,
    stops,
    emit: emitFact,
    tools: {
      getDefinition: (name) => definitions.find((definition) => definition.name === name) ?? null,
      discardApproval: () => undefined,
      async preview(request) {
        return `${request.toolName} preview`;
      },
      async execute(request) {
        if (request.toolName === BACKGROUND_START_DEFINITION.name) {
          counter += 1;
          const taskId = `task-${counter}`;
          const processExecutionId = `exec-${counter}`;
          if (request.owner === undefined) throw new Error("launch without owner");
          const bound = {
            sessionId: request.owner.sessionId,
            ownerRunId: request.owner.runId,
            launchingToolCallId: request.toolCallId,
            taskId,
            processExecutionId,
          };
          launched.push({ ...bound, toolCallId: request.toolCallId, owner: request.owner });
          // Mirror the real registry's ordering exactly: registered, then running.
          // The durable log's relation rules require this prefix, and skipping it
          // makes every later terminal fact invalid.
          await emitFact({
            ...bound,
            state: "registered",
            processId: null,
            exitCode: null,
            timedOut: false,
          });
          await emitFact({
            ...bound,
            state: "running",
            processId: 4242,
            exitCode: null,
            timedOut: false,
          });
          return {
            status: "succeeded" as const,
            text: [
              `background_start: taskId=${taskId}`,
              "launch=accepted; this confirms start only, not completion or success",
            ].join("\n"),
          };
        }
        if (request.toolName === BACKGROUND_STOP_DEFINITION.name) {
          const taskId = (request.arguments as { taskId?: unknown } | null)?.taskId;
          if (typeof taskId === "string") stops.push(taskId);
          return { status: "succeeded" as const, text: "stop requested" };
        }
        if (request.toolName === BACKGROUND_STATUS_DEFINITION.name) {
          return { status: "succeeded" as const, text: "state=observed" };
        }
        return { status: "failed" as const, safeCode: "unsupported", text: null };
      },
      observeBackground(observer) {
        observers.add(observer);
        return () => {
          observers.delete(observer);
        };
      },
      async flushBackground() {},
    },
  };
}

async function withCoordinator(
  handlerFor: (harness: Harness) => Parameters<typeof modelFrom>[0],
  run: (context: {
    coordinator: RuntimeCoordinator;
    model: ReturnType<typeof modelFrom>;
    harness: Harness;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "e11-"));
  const harness = backgroundHarness();
  // The handler must see the same harness the coordinator drives; building it from
  // a separate instance made every launch assertion fail inside the model.
  const model = modelFrom(handlerFor(harness));
  // Both process-execution tools need their own one-shot approval. Approving one
  // does not approve the other, which is why each has a separate rule.
  const gate = scriptedApprovals([approveWhen("background_start"), approveWhen("background_stop")]);
  try {
    const coordinator = new RuntimeCoordinator({
      provider: model.provider,
      tools: harness.tools,
      approvals: gate.gate,
      eventLog: new JsonlEventLog(root, ids, digests),
      checkpoints: new JsonlCheckpointStore(root, digests),
      ids,
      nowUtc: () => new Date().toISOString(),
      // E11 measures launch/terminal attribution, not the approval panel, so the
      // gate answers inline. It still answers per invocation: the recording gate
      // shows the launch was previewed and approved individually.
      suspendOnApproval: false,
      persistReports: true,
      sessionId: `e11-${randomUUID()}`,
    });
    await run({ coordinator, model, harness });
    await coordinator.closeSession("close");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function observedStates(
  events: Awaited<ReturnType<RuntimeCoordinator["run"]>>["events"],
): readonly string[] {
  return events.flatMap(({ payload }) =>
    payload.kind === "background_task_observed" ? [payload.task.state] : [],
  );
}

function lastReport(events: Awaited<ReturnType<RuntimeCoordinator["run"]>>["events"]) {
  const snapshot = events.findLast(({ payload }) => payload.kind === "task_report_snapshot");
  return snapshot?.payload.kind === "task_report_snapshot" ? snapshot.payload.report : null;
}

/** Launch, then answer the next request after the test has observed the launch. */
function launchThenStatus(
  harness: Harness,
  onLaunched: (launched: Launched, emit: Harness["emit"]) => Promise<void>,
) {
  let round = 0;
  return async () => {
    round += 1;
    if (round === 1) return callTool("bg", "background_start", { command: "npm test", cwd: "." });
    if (round === 2) {
      const launched = harness.launched[0];
      assert.ok(launched);
      await onLaunched(launched, harness.emit);
      return callTool("status", "background_status", { taskId: launched.taskId });
    }
    return say("The background test finished.");
  };
}

describe("E11: a launch is not a result", () => {
  it("keeps the launch result distinct from completion", async () => {
    await withCoordinator(
      (harness) => launchThenStatus(harness, async () => {}),
      async ({ coordinator, harness }) => {
        const result = await coordinator.run("run the test in the background");
        assert.equal(result.status, "completed");

        const launch = result.events.find(
          ({ payload }) =>
            payload.kind === "tool_execution_finished" && payload.toolName === "background_start",
        )?.payload;
        assert.ok(launch?.kind === "tool_execution_finished");
        assert.equal(launch.status, "succeeded");
        // The result text is the only thing the model sees, and it says start only.
        assert.match(launch.text ?? "", /confirms start only, not completion or success/u);

        // No terminal fact was reported, so the task is still running in the report.
        assert.deepEqual(observedStates(result.events), ["registered", "running"]);
        const report = lastReport(result.events);
        assert.ok(report);
        assert.deepEqual(report.backgroundTasks, [
          { taskId: harness.launched[0]?.taskId, state: "running" },
        ]);
        // A launch is not a passing test.
        assert.deepEqual(report.tests, []);
        assert.equal(report.verification.status, "unverified");
      },
    );
  });
});

describe("E11: terminal attribution and de-duplication", () => {
  it("advances on a matching terminal fact and ignores a duplicate", async () => {
    let emissions = 0;
    await withCoordinator(
      (harness) =>
        launchThenStatus(harness, async (launched, emit) => {
          const terminal: PendingFact = {
            sessionId: launched.owner.sessionId,
            ownerRunId: launched.owner.runId,
            launchingToolCallId: launched.toolCallId,
            taskId: launched.taskId,
            processExecutionId: launched.processExecutionId,
            state: "succeeded",
            processId: 4242,
            exitCode: 0,
            timedOut: false,
          };
          await emit(terminal);
          emissions += 1;
          // The runner may report the same terminal state twice; it must not advance
          // the record twice.
          await emit(terminal);
          emissions += 1;
        }),
      async ({ coordinator, harness }) => {
        const result = await coordinator.run("run the test in the background");
        assert.equal(result.status, "completed");
        assert.equal(emissions, 2);

        assert.deepEqual(observedStates(result.events), ["registered", "running", "succeeded"]);
        const terminalEvents = result.events.filter(
          ({ payload }) =>
            payload.kind === "background_task_observed" && payload.task.state === "succeeded",
        );
        assert.equal(terminalEvents.length, 1, "one terminal fact, not two");

        const report = lastReport(result.events);
        assert.ok(report);
        assert.deepEqual(report.backgroundTasks, [
          { taskId: harness.launched[0]?.taskId, state: "succeeded" },
        ]);
      },
    );
  });

  it("does not let a second task settle the first", async () => {
    await withCoordinator(
      (harness) => {
        let round = 0;
        return async () => {
          round += 1;
          if (round === 1)
            return callTool("bg1", "background_start", { command: "npm test", cwd: "." });
          if (round === 2)
            return callTool("bg2", "background_start", { command: "npm lint", cwd: "." });
          if (round === 3) {
            // Both launches are recorded; only the second one finishes.
            const second = harness.launched[1];
            assert.ok(second);
            await harness.emit({
              sessionId: second.owner.sessionId,
              ownerRunId: second.owner.runId,
              launchingToolCallId: second.toolCallId,
              taskId: second.taskId,
              processExecutionId: second.processExecutionId,
              state: "succeeded",
              processId: 4242,
              exitCode: 0,
              timedOut: false,
            });
            return say("The second task finished.");
          }
          return say("Both tasks are tracked.");
        };
      },
      async ({ coordinator, harness }) => {
        const result = await coordinator.run("run both checks in the background");
        assert.equal(result.status, "completed");

        const report = lastReport(result.events);
        assert.ok(report);
        const first = harness.launched[0];
        const second = harness.launched[1];
        assert.ok(first && second);
        // The first task is untouched by a fact about the second: identity, not
        // arrival order, decides which task advanced.
        assert.deepEqual(
          report.backgroundTasks.find((task) => task.taskId === first.taskId),
          { taskId: first.taskId, state: "running" },
        );
        assert.deepEqual(
          report.backgroundTasks.find((task) => task.taskId === second.taskId),
          { taskId: second.taskId, state: "succeeded" },
        );
      },
    );
  });

  it("stops by task identity, never by a bare PID", async () => {
    await withCoordinator(
      () => {
        let round = 0;
        return () => {
          round += 1;
          if (round === 1) return callTool("stop", "background_stop", { taskId: "task-1" });
          return say("Stop requested.");
        };
      },
      async ({ coordinator, harness }) => {
        const result = await coordinator.run("stop the background test");
        assert.equal(result.status, "completed");
        // The Harness asked to stop a task, which is the supervised identity; a
        // PID is never accepted as the thing to kill.
        assert.deepEqual(harness.stops, ["task-1"]);
      },
    );
  });
});
