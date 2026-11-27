import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import type { InternalEvent } from "../../src/ports/event-log.ts";
import {
  deriveView,
  EMPTY_VIEW,
  interpretComposer,
  panelActionKeepsWait,
  type TuiViewState,
} from "../../src/tui/view-model.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

type Append = Parameters<InMemoryEventLog["append"]>[0];

function record(type: InternalEvent["type"], payload: InternalEvent["payload"]): Append {
  return {
    sessionId: "session-1",
    runId: "run-1",
    type,
    correlationId: "c",
    causationId: null,
    timestampUtc: "2026-11-02T00:00:01.000Z",
    payload,
  };
}

async function build(events: readonly Append[]): Promise<readonly InternalEvent[]> {
  const log = new InMemoryEventLog(new SequenceIds("tui"), new JsonDigest());
  for (const event of events) await log.append(event);
  return log.read("session-1");
}

function view(overrides: Partial<Parameters<typeof deriveView>[0]> = {}): TuiViewState {
  return deriveView({
    runStatus: "idle",
    safeCode: null,
    events: [],
    todo: null,
    pendingApproval: null,
    pendingQuestion: null,
    draft: "",
    ...overrides,
  });
}

describe("transcript derivation", () => {
  it("appends an ephemeral streaming entry without making it durable", async () => {
    const live = view({ streaming: { text: "hel" } });
    assert.equal(live.transcript.length, 1);
    assert.equal(live.transcript[0]?.kind, "assistant");
    assert.equal(live.transcript[0]?.status, "streaming");
    assert.equal(live.transcript[0]?.text, "hel");
    assert.equal(live.activity, "working");

    const final = await build([
      record("model_response_validated", {
        kind: "model_response_validated",
        modelRequestId: "m1",
        attemptNo: 1,
        toolCallCount: 0,
        text: "hello",
        toolCalls: [],
      }),
    ]);
    const done = view({ events: final });
    assert.equal(done.transcript.length, 1);
    assert.equal(done.transcript[0]?.status, null);
    assert.equal(done.transcript[0]?.text, "hello");
  });

  it("updates a single tool row from requested to running and finished with details", async () => {
    const received = record("tool_call_received", {
      kind: "tool_call_received",
      toolCallId: "c",
      providerToolCallId: "p",
      toolName: "shell",
      arguments: { command: "npm.cmd run typecheck", cwd: "D:\\fixture" },
    });
    const running = record("tool_execution_started", {
      kind: "tool_execution_started",
      toolCallId: "c",
      toolName: "shell",
    });
    const finished = record("tool_execution_finished", {
      kind: "tool_execution_finished",
      toolCallId: "c",
      status: "succeeded",
      safeCode: null,
      text: "tsc --noEmit\nall checks passed",
    });
    for (const [events, status] of [
      [[received], "requested"],
      [[received, running], "running"],
      [[received, running, finished], "succeeded"],
    ] as const) {
      const entries = view({ events: await build(events) }).transcript;
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.status, status);
      assert.equal(entries[0]?.tool?.summary, "shell npm.cmd run typecheck");
      assert.match(entries[0]?.tool?.details ?? "", /fixture/);
      if (status === "succeeded")
        assert.match(entries[0]?.tool?.details ?? "", /all checks passed/);
    }
  });
  it("starts empty and idle", () => {
    assert.deepEqual(view(), EMPTY_VIEW);
  });

  it("renders the user task, assistant text and tool results", async () => {
    const events = await build([
      record("run_started", { kind: "run_started", input: "fix the bug" }),
      record("model_response_validated", {
        kind: "model_response_validated",
        modelRequestId: "r1",
        attemptNo: 1,
        toolCallCount: 1,
        text: "I will inspect it",
      }),
      record("tool_call_received", {
        kind: "tool_call_received",
        toolCallId: "call-1",
        providerToolCallId: "p1",
        toolName: "read_file",
        arguments: {},
      }),
      record("tool_execution_finished", {
        kind: "tool_execution_finished",
        toolCallId: "call-1",
        status: "succeeded",
        safeCode: null,
        text: "file contents",
      }),
      record("run_completed", { kind: "run_completed", text: "fixed" }),
    ]);

    const state = view({ events, runStatus: "completed" });

    assert.deepEqual(
      state.transcript.map((entry) => `${entry.kind}:${entry.text}`),
      ["user:fix the bug", "assistant:I will inspect it", "tool:file contents"],
    );
    assert.equal(state.canSubmit, true);
  });

  it("shows the final reply only once and keeps completed status outside the transcript", async () => {
    const text = "Hello, how can I help?";
    const events = await build([
      record("run_started", { kind: "run_started", input: "hello" }),
      record("model_response_validated", {
        kind: "model_response_validated",
        modelRequestId: "r1",
        attemptNo: 1,
        toolCallCount: 0,
        text,
      }),
      record("run_completed", { kind: "run_completed", text }),
    ]);
    const state = view({ events, runStatus: "completed" });
    assert.equal(state.transcript.filter((entry) => entry.text.includes(text)).length, 1);
    assert.equal(
      state.transcript.some((entry) => entry.kind === "system"),
      false,
    );
    assert.equal(state.runStatus, "completed");
    assert.equal(state.canSubmit, true);
  });

  it("keeps a failed tool result visible with its status", async () => {
    const events = await build([
      record("run_started", { kind: "run_started", input: "task" }),
      record("tool_call_received", {
        kind: "tool_call_received",
        toolCallId: "call-1",
        providerToolCallId: "p1",
        toolName: "edit_file",
        arguments: {},
      }),
      record("tool_execution_finished", {
        kind: "tool_execution_finished",
        toolCallId: "call-1",
        status: "failed",
        safeCode: "file_conflict",
        text: null,
      }),
    ]);

    const state = view({ events });
    const toolEntry = state.transcript.find(
      (entry) => entry.kind === "tool" && entry.status === "failed",
    );
    assert.notEqual(toolEntry, undefined);
    assert.equal(toolEntry?.text, "file_conflict");
    assert.match(toolEntry?.tool?.details ?? "", /file_conflict/);
  });

  it("shows denied and cancelled calls distinctly", async () => {
    const events = await build([
      record("run_started", { kind: "run_started", input: "task" }),
      record("tool_execution_denied", {
        kind: "tool_execution_denied",
        toolCallId: "call-1",
        toolName: "shell",
      }),
      record("tool_call_cancelled", {
        kind: "tool_call_cancelled",
        toolCallId: "call-2",
        toolName: "write_note",
        reason: "user_input_superseded",
      }),
    ]);

    const state = view({ events });
    assert.equal(
      state.transcript.some((entry) => entry.status === "denied"),
      true,
    );
    assert.equal(
      state.transcript.some((entry) => entry.status === "cancelled"),
      true,
    );
  });
});

describe("queued input transcript", () => {
  const queued = record("run_input_queued", {
    kind: "run_input_queued",
    inputId: "i1",
    text: "also add a test",
    acceptedSeq: 1,
  });
  const consumed = record("run_input_batch_consumed", {
    kind: "run_input_batch_consumed",
    inputIds: ["i1"],
    throughSeq: 1,
    taskRevision: 1,
  });
  const started = record("model_request_started", {
    kind: "model_request_started",
    modelRequestId: "m1",
    attemptNo: 1,
    includedInputIds: ["i1"],
  });
  const validated = record("model_response_validated", {
    kind: "model_response_validated",
    modelRequestId: "m1",
    attemptNo: 1,
    toolCallCount: 0,
    text: "done",
  });
  it("shows accepted input immediately and distinguishes consumption, sending and sent", async () => {
    for (const [records, expected] of [
      [[queued], "queued"],
      [[queued, consumed], "ready"],
      [[queued, consumed, started], "sending"],
      [[queued, consumed, started, validated], "sent"],
    ] as const) {
      const entries = view({ runStatus: "active", events: await build(records) }).transcript;
      assert.equal(entries[0]?.text, "also add a test");
      assert.equal(entries[0]?.status, expected);
      assert.equal(entries.filter((entry) => entry.kind === "user").length, 1);
    }
  });
  it("does not infer sending from consumption, older records or an unrelated request", async () => {
    const records = await build([
      queued,
      consumed,
      record("model_request_started", {
        kind: "model_request_started",
        modelRequestId: "m1",
        attemptNo: 1,
      }),
      validated,
    ]);
    assert.equal(view({ events: records }).transcript[0]?.status, "ready");
  });
  it("retains unsent items and marks interrupted sends unknown on terminal runs", async () => {
    for (const [records, expected] of [
      [[queued], "retained"],
      [[queued, consumed], "retained"],
      [[queued, consumed, started], "unknown"],
    ] as const) {
      const events = await build([
        ...records,
        record("run_cancelled", {
          kind: "run_cancelled",
          safeCode: "cancelled",
        }),
      ]);
      assert.equal(view({ events, runStatus: "cancelled" }).transcript[0]?.status, expected);
    }
  });
  it("preserves withdrawn state and does not share input or tool identities across runs", async () => {
    const events = await build([
      queued,
      record("run_input_withdrawn", {
        kind: "run_input_withdrawn",
        inputId: "i1",
      }),
      { ...queued, runId: "run-2" },
      { ...consumed, runId: "run-2" },
      { ...started, runId: "run-2" },
      { ...validated, runId: "run-2" },
    ]);
    const users = view({ events }).transcript.filter((entry) => entry.kind === "user");
    assert.deepEqual(
      users.map((entry) => entry.status),
      ["withdrawn", "sent"],
    );
  });
});

describe("recorded activity projection", () => {
  it("distinguishes an in-flight model request from tool work and ends on waiting or completion", async () => {
    const request = record("model_request_started", {
      kind: "model_request_started",
      modelRequestId: "m1",
      attemptNo: 1,
    });
    const response = record("model_response_validated", {
      kind: "model_response_validated",
      modelRequestId: "m1",
      attemptNo: 1,
      toolCallCount: 1,
      text: "checking",
    });
    const running = await build([request]);
    assert.equal(view({ runStatus: "active", events: running }).activity, "thinking");
    assert.equal(view({ runStatus: "completed", events: running }).activity, null);
    assert.equal(view({ runStatus: "cancelled", events: running }).activity, null);
    assert.equal(view({ runStatus: "waiting", events: running }).activity, null);
    const working = await build([
      request,
      response,
      record("tool_execution_started", {
        kind: "tool_execution_started",
        toolCallId: "t1",
        toolName: "read_file",
      }),
    ]);
    assert.equal(view({ runStatus: "active", events: working }).activity, "working");
    const cancelled = await build([
      request,
      record("run_cancel_requested", {
        kind: "run_cancel_requested",
        commandId: "cancel-1",
      }),
    ]);
    assert.equal(view({ runStatus: "active", events: cancelled }).activity, null);
  });
});

describe("waiting state", () => {
  it("derives an approval wait from the pending view", () => {
    const state = view({
      runStatus: "waiting",
      pendingApproval: {
        approvalId: "a1",
        toolCallId: "c1",
        toolName: "shell",
        requestVersion: 1,
      },
    });
    assert.equal(state.waitingKind, "approval");
    assert.equal(state.canSubmit, false);
    assert.equal(state.queueingInput, true);
  });

  it("derives a question wait even when the panel was closed", async () => {
    const events = await build([
      record("run_started", { kind: "run_started", input: "task" }),
      record("run_waiting", {
        kind: "run_waiting",
        reason: "user_input",
        safeCode: "question_pending",
        waitToken: "q1",
        requestVersion: 1,
      }),
      record("question_view_closed", { kind: "question_view_closed", questionId: "q1" }),
    ]);

    const state = view({ events, runStatus: "waiting" });
    assert.equal(state.waitingKind, "question");
  });

  it("clears the wait after the run resumes", async () => {
    const events = await build([
      record("run_started", { kind: "run_started", input: "task" }),
      record("run_waiting", {
        kind: "run_waiting",
        reason: "configuration",
        safeCode: "authentication_failed",
        waitToken: "w1",
        requestVersion: 1,
      }),
      record("run_resumed", { kind: "run_resumed" }),
    ]);

    const state = view({ events, runStatus: "active" });
    assert.equal(state.waitingKind, null);
  });
});

describe("composer intent", () => {
  it("does not revive a historical wait in a newly opened controller", async () => {
    const events = await build([
      record("run_waiting", {
        kind: "run_waiting",
        reason: "approval",
        safeCode: "approval_required",
        waitToken: "historical-wait",
        requestVersion: 1,
      }),
    ]);
    const state = view({ runStatus: "idle", events });
    assert.equal(state.waitingKind, null);
    assert.equal(state.canSubmit, true);
    assert.equal(state.pendingApproval, null);
  });
  it("starts a run when idle", () => {
    assert.deepEqual(interpretComposer(view(), "  fix it  "), {
      kind: "start_run",
      text: "fix it",
    });
  });

  it("queues input while a run is active", () => {
    assert.deepEqual(interpretComposer(view({ runStatus: "active" }), "also update docs"), {
      kind: "queue_input",
      text: "also update docs",
    });
  });

  it("rejects an empty submission", () => {
    assert.deepEqual(interpretComposer(view(), "   "), { kind: "reject", reason: "empty" });
  });

  it("rejects input when the caller cannot accept a queue", () => {
    assert.deepEqual(
      interpretComposer(view({ runStatus: "active" }), "x", { activeRunAcceptsInput: false }),
      { kind: "reject", reason: "run_active" },
    );
  });

  it("starts a new run after a terminal state", () => {
    assert.deepEqual(interpretComposer(view({ runStatus: "failed" }), "try again"), {
      kind: "start_run",
      text: "try again",
    });
  });
});

describe("panel actions", () => {
  it("never turns a panel close into a decision", () => {
    assert.equal(panelActionKeepsWait("close"), true);
    assert.equal(panelActionKeepsWait("open"), true);
  });
});

describe("approval preview comes from the authoritative event", () => {
  it("renders the recorded preview for the pending approval", async () => {
    const events = await build([
      record("tool_call_received", {
        kind: "tool_call_received",
        providerToolCallId: "p1",
        toolCallId: "call-1",
        toolName: "shell",
        arguments: { command: "echo hi", verification: true },
      }),
      record("approval_requested", {
        kind: "approval_requested",
        approvalId: "ap-1",
        toolCallId: "call-1",
        toolName: "shell",
        safePreview: "shell\ncommand=echo hi\ncwd=C:\\ws",
      }),
    ]);
    const state = deriveView({
      runStatus: "waiting",
      safeCode: "approval_pending",
      events,
      todo: null,
      pendingApproval: {
        approvalId: "ap-1",
        toolCallId: "call-1",
        toolName: "shell",
        requestVersion: 1,
      },
      pendingQuestion: null,
      draft: "",
    });
    assert.deepEqual(state.pendingApprovalPreview, ["shell", "command=echo hi", "cwd=C:\\ws"]);
    assert.equal(state.pendingVerificationCommand, true);
  });

  it("ignores a preview belonging to a different approval", async () => {
    const events = await build([
      record("approval_requested", {
        kind: "approval_requested",
        approvalId: "ap-old",
        toolCallId: "call-old",
        toolName: "shell",
        safePreview: "shell\ncommand=old",
      }),
    ]);
    const state = deriveView({
      runStatus: "waiting",
      safeCode: "approval_pending",
      events,
      todo: null,
      pendingApproval: {
        approvalId: "ap-new",
        toolCallId: "call-new",
        toolName: "shell",
        requestVersion: 1,
      },
      pendingQuestion: null,
      draft: "",
    });
    // No matching record means no preview, which the panel shows as unavailable
    // rather than inventing one.
    assert.equal(state.pendingApprovalPreview, null);
  });

  it("returns null when there is no pending approval", async () => {
    const events = await build([
      record("approval_requested", {
        kind: "approval_requested",
        approvalId: "ap-1",
        toolCallId: "call-1",
        toolName: "shell",
        safePreview: "shell",
      }),
    ]);
    const state = deriveView({
      runStatus: "active",
      safeCode: null,
      events,
      todo: null,
      pendingApproval: null,
      pendingQuestion: null,
      draft: "",
    });
    assert.equal(state.pendingApprovalPreview, null);
  });
});
