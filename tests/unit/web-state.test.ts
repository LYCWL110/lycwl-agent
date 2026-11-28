import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PendingApprovalView } from "../../src/application/coordinator/runtime-coordinator.ts";
import type { TodoList } from "../../src/domain/planning/todo.ts";
import type { TuiViewState } from "../../src/tui/view-model.ts";
import type { WebSessionListEntry, WebSessionRuntime, WebState } from "../../src/web/protocol.ts";
import { toWebState } from "../../src/web/state.ts";
import { createFakeRuntime, emptyView } from "../fakes/web-session.ts";

/**
 * The snapshot is a field-for-field projection of the TUI view.
 *
 * The browser applies a snapshot wholesale, so the projection must be complete
 * and exact: a field the contract does not name would silently enter the wire
 * format, and a field it does name must not be invented when the Runtime did not
 * report it.
 */

const CONTRACT_KEYS = [
  "activity",
  "answerError",
  "canSubmit",
  "commandNotice",
  "contextWindow",
  "demo",
  "meter",
  "modeLabel",
  "modelLabel",
  "pendingApproval",
  "pendingApprovalPreview",
  "pendingDisclosure",
  "pendingQuestion",
  "queueingInput",
  "runStatus",
  "safeCode",
  "sessionId",
  "sessionList",
  "streaming",
  "switching",
  "todo",
  "transcript",
  "usage",
  "waitingKind",
  "warnings",
] as const;

const SESSION_LIST: readonly WebSessionListEntry[] = [
  {
    sessionId: "11111111-1111-4111-8111-111111111111",
    label: "什么是 Rime LLM",
    title: null,
    modifiedAtUtc: "2026-11-28T03:00:00.000Z",
    bytes: 4096,
    current: true,
  },
  {
    sessionId: "22222222-2222-4222-8222-222222222222",
    label: "fix the parser",
    title: "Parser fix",
    modifiedAtUtc: "2026-11-27T10:00:00.000Z",
    bytes: 2048,
    current: false,
  },
];

const TODO: TodoList = {
  items: [
    { id: "1", content: "write the test", state: "in_progress" },
    { id: "2", content: "run the test", state: "pending" },
  ],
  revision: 3,
};

const PENDING_APPROVAL: PendingApprovalView = {
  approvalId: "approval-1",
  toolCallId: "call-1",
  toolName: "run_command",
  requestVersion: 2,
};

const PENDING_DISCLOSURE = {
  disclosureId: "disclosure-1",
  requestVersion: 4,
  requestFingerprint: "sha256:abc",
  safePreview: "send 2 files to provider",
} as const;

const PENDING_QUESTION = {
  questionId: "question-1",
  toolCallId: "call-2",
  question: "Which file should I change?",
  answerType: "text",
  options: [{ id: "a", label: "src/main.ts" }],
  multiple: false,
  allowFreeText: true,
  requestVersion: 5,
} as const;

const PENDING_APPROVAL_PREVIEW = ["$ pnpm test"] as const;

/** A runtime whose every field differs from the defaults, so a copy is visible. */
function richRuntime(): WebSessionRuntime {
  return createFakeRuntime({
    sessionId: "33333333-3333-4333-8333-333333333333",
    modelLabel: null,
    modeLabel: "read-only",
    contextWindow: null,
    demo: true,
    warnings: ["demo runtime: no network, credential or write activity"],
  });
}

/** A view with every contract field populated by a distinguishable value. */
function richView(): TuiViewState {
  return emptyView({
    runStatus: "waiting",
    waitingKind: "approval",
    activity: "thinking",
    streaming: { text: "partial answer" },
    safeCode: "approval_required",
    transcript: [
      { id: "e1", kind: "user", text: "hello", status: null },
      {
        id: "e2",
        kind: "tool",
        text: "read_file ok",
        status: "ok",
        tool: { name: "read_file", summary: "src/main.ts", details: "1 line" },
      },
    ],
    todo: TODO,
    pendingApproval: PENDING_APPROVAL,
    pendingApprovalPreview: PENDING_APPROVAL_PREVIEW,
    pendingDisclosure: PENDING_DISCLOSURE,
    pendingQuestion: PENDING_QUESTION,
    answerError: "the answer was rejected",
    commandNotice: "session renamed",
    meter: {
      used: 7168,
      window: 262144,
      fraction: 0.02734375,
      source: "measured",
      atCompaction: false,
    },
    usage: { inputTokens: 7000, outputTokens: 120, cachedInputTokens: 10, reasoningTokens: 4 },
    canSubmit: false,
    queueingInput: true,
    draft: "this draft must not cross the wire",
  });
}

function project(
  overrides: Readonly<{
    session?: WebSessionRuntime;
    view?: TuiViewState;
    sessionList?: readonly WebSessionListEntry[];
    switching?: boolean;
  }> = {},
): WebState {
  return toWebState({
    session: overrides.session ?? richRuntime(),
    view: overrides.view ?? richView(),
    sessionList: overrides.sessionList ?? SESSION_LIST,
    switching: overrides.switching ?? true,
  });
}

describe("toWebState", () => {
  it("copies exactly the contract fields", () => {
    const state = project();
    assert.deepEqual(state, {
      sessionId: "33333333-3333-4333-8333-333333333333",
      modelLabel: null,
      modeLabel: "read-only",
      contextWindow: null,
      demo: true,
      warnings: ["demo runtime: no network, credential or write activity"],
      switching: true,
      runStatus: "waiting",
      waitingKind: "approval",
      activity: "thinking",
      streaming: { text: "partial answer" },
      transcript: [
        { id: "e1", kind: "user", text: "hello", status: null },
        {
          id: "e2",
          kind: "tool",
          text: "read_file ok",
          status: "ok",
          tool: { name: "read_file", summary: "src/main.ts", details: "1 line" },
        },
      ],
      todo: TODO,
      meter: {
        used: 7168,
        window: 262144,
        fraction: 0.02734375,
        source: "measured",
        atCompaction: false,
      },
      usage: {
        inputTokens: 7000,
        outputTokens: 120,
        cachedInputTokens: 10,
        reasoningTokens: 4,
      },
      safeCode: "approval_required",
      answerError: "the answer was rejected",
      commandNotice: "session renamed",
      pendingApproval: PENDING_APPROVAL,
      pendingApprovalPreview: PENDING_APPROVAL_PREVIEW,
      pendingDisclosure: PENDING_DISCLOSURE,
      pendingQuestion: PENDING_QUESTION,
      canSubmit: false,
      queueingInput: true,
      sessionList: SESSION_LIST,
    });
  });

  it("emits no field outside the contract", () => {
    const state = project();
    assert.deepEqual(Object.keys(state).sort(), [...CONTRACT_KEYS].sort());
    // The TUI's local draft is composer state, not a Runtime fact: it must not
    // reach the browser, where it would look like an accepted message.
    assert.equal("draft" in state, false);
  });

  it("preserves the neighboring session list, current markers and switching flag", () => {
    const state = project({ switching: false });
    assert.equal(state.switching, false);
    assert.deepEqual(state.sessionList, SESSION_LIST);
    assert.deepEqual(
      state.sessionList.map((entry) => entry.current),
      [true, false],
    );
    // The projection uses the list it was given, not a stale view field.
    const viewWithDifferentList = emptyView({
      ...richView(),
      sessionList: [],
    });
    const projected = project({ view: viewWithDifferentList });
    assert.deepEqual(projected.sessionList, SESSION_LIST);
  });

  it("passes pending approval, disclosure and question views through", () => {
    const state = project();
    assert.equal(state.pendingApproval, PENDING_APPROVAL);
    assert.equal(state.pendingDisclosure, PENDING_DISCLOSURE);
    assert.equal(state.pendingQuestion, PENDING_QUESTION);
    assert.equal(state.pendingApprovalPreview, PENDING_APPROVAL_PREVIEW);
  });

  it("survives a JSON round-trip unchanged for plain values", () => {
    const state = project();
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  });

  it("reports absent optional facts as null, not as invented defaults", () => {
    const state = project({
      session: createFakeRuntime({ modelLabel: null, contextWindow: null }),
      view: emptyView(),
      sessionList: [],
      switching: false,
    });
    assert.equal(state.modelLabel, null);
    assert.equal(state.contextWindow, null);
    assert.equal(state.streaming, null);
    assert.equal(state.usage, null);
    assert.equal(state.commandNotice, null);
    assert.equal(state.pendingDisclosure, null);
    assert.equal(state.pendingApproval, null);
    assert.equal(state.pendingQuestion, null);
    assert.equal(state.pendingApprovalPreview, null);
    assert.deepEqual(state.sessionList, []);
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  });

  it("keeps every view-level value that the contract names", () => {
    const view = richView();
    const state = project({ view });
    for (const key of [
      "runStatus",
      "waitingKind",
      "activity",
      "streaming",
      "transcript",
      "todo",
      "meter",
      "safeCode",
      "answerError",
      "pendingApproval",
      "pendingApprovalPreview",
      "pendingQuestion",
      "canSubmit",
      "queueingInput",
    ] as const) {
      assert.deepEqual(state[key], view[key] === undefined ? null : view[key], key);
    }
    assert.deepEqual(state.usage, view.usage);
    assert.equal(state.commandNotice, view.commandNotice);
    assert.equal(state.pendingDisclosure, view.pendingDisclosure);
  });
});
