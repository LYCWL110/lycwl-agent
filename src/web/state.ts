/**
 * Projection from the TUI view model to the browser snapshot.
 *
 * The browser renders exactly what `WebState` describes and nothing else, so this
 * is a pure field-for-field copy: no extra fields (the client would have to ignore
 * them), no functions (the snapshot crosses a JSON boundary), and no defaults
 * invented for facts the Runtime did not report.
 */
import type { TuiViewState } from "../tui/view-model.ts";
import type { WebSessionListEntry, WebSessionRuntime, WebState } from "./protocol.ts";

export type WebStateInput = Readonly<{
  session: WebSessionRuntime;
  view: TuiViewState;
  sessionList: readonly WebSessionListEntry[];
  switching: boolean;
}>;

/** Build the complete snapshot the browser applies wholesale. */
export function toWebState(input: WebStateInput): WebState {
  const { session, view, sessionList, switching } = input;
  return {
    sessionId: session.sessionId,
    modelLabel: session.modelLabel,
    modeLabel: session.modeLabel,
    contextWindow: session.contextWindow,
    demo: session.demo,
    warnings: session.warnings,
    switching,
    runStatus: view.runStatus,
    waitingKind: view.waitingKind,
    activity: view.activity,
    streaming: view.streaming ?? null,
    transcript: view.transcript,
    todo: view.todo,
    meter: view.meter,
    usage: view.usage ?? null,
    safeCode: view.safeCode,
    answerError: view.answerError,
    commandNotice: view.commandNotice ?? null,
    pendingApproval: view.pendingApproval,
    pendingApprovalPreview: view.pendingApprovalPreview,
    pendingDisclosure: view.pendingDisclosure ?? null,
    pendingQuestion: view.pendingQuestion,
    canSubmit: view.canSubmit,
    queueingInput: view.queueingInput,
    sessionList,
  };
}
