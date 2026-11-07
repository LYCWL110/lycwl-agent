import type { DigestService, IdentifierFactory } from "./identity.ts";

/**
 * Stage 1 internal verification event contract. This is not an adopted
 * external JSON Schema or durable compatibility promise.
 */
export type InternalEventPayload =
  | Readonly<{ kind: "run_started"; input: string }>
  | Readonly<{
      kind: "run_model_binding";
      providerId: string;
      modelId: string;
      protocolId: string;
      adapterVersion: string;
      endpointFingerprint: string;
      catalogSnapshotId: string;
      capabilitySnapshotId: string;
      /** Reference and revision only; never a secret value. */
      credentialRef: string;
      credentialRevision: number;
    }>
  | Readonly<{
      kind: "run_waiting";
      reason: "configuration" | "approval" | "user_input" | "recovery" | "external_dependency";
      safeCode: string;
      waitToken: string;
      requestVersion: number;
    }>
  | Readonly<{ kind: "run_completed"; text: string | null }>
  | Readonly<{ kind: "run_failed"; safeCode: string }>
  | Readonly<{ kind: "run_cancelled"; safeCode: string }>
  | Readonly<{ kind: "run_cancel_requested"; commandId: string }>
  | Readonly<{ kind: "run_resumed" }>
  | Readonly<{
      kind: "context_compacted";
      /** Hash of the artifact that replaced the summarised groups. */
      artifactSha256: string;
      /** Groups replaced by this artifact. */
      summarizedGroupIds: readonly string[];
      /** Groups kept verbatim after the summary. */
      recentSuffixGroupIds: readonly string[];
      /** Highest authoritative seq this compaction covered. */
      sourceHighWaterSeq: number;
      estimatedAuxiliaryTokens: number;
      /** Version of the summary artifact shape. */
      artifactVersion: number;
      /**
       * The rendered summary that replaced the summarised groups. Recorded so a
       * rebuilt Session can present the summary rather than replaying the
       * original turns it was meant to replace.
       */
      summaryText: string;
    }>
  | Readonly<{
      kind: "context_compaction_rejected";
      reason: "capacity_insufficient" | "invalid_artifact" | "attempts_exhausted";
      detail: string;
    }>
  | Readonly<{
      kind: "no_progress_detected";
      decision: "warn" | "block";
      detail: string;
      toolName: string;
    }>
  | Readonly<{
      kind: "model_request_started";
      modelRequestId: string;
      attemptNo: number;
      /** Credential revision actually used for this attempt, if a route is bound. */
      credentialRevision?: number;
    }>
  | Readonly<{
      kind: "model_retry_scheduled";
      modelRequestId: string;
      failedAttemptNo: number;
      retryAfterMs: number;
      safeCode: string;
    }>
  | Readonly<{
      kind: "model_response_validated";
      modelRequestId: string;
      attemptNo: number;
      toolCallCount: number;
      text: string | null;
      toolCalls?: readonly Readonly<{
        providerToolCallId: string;
        toolName: string;
        arguments: unknown;
      }>[];
    }>
  | Readonly<{
      kind: "tool_call_received";
      toolCallId: string;
      providerToolCallId: string;
      toolName: string;
      /**
       * Canonicalized arguments. Recorded so a restart can rebuild the
       * assistant turn it belonged to; without them the replayed history would
       * contain a tool call with no input.
       */
      arguments: unknown;
    }>
  | Readonly<{
      kind: "approval_requested";
      approvalId: string;
      toolCallId: string;
      toolName: string;
      safePreview: string;
    }>
  | Readonly<{
      kind: "approval_decided";
      approvalId: string;
      toolCallId: string;
      decision: "approved" | "denied";
    }>
  | Readonly<{
      kind: "approval_grant_revoked";
      approvalId: string;
      toolCallId: string;
      reason: "restart" | "superseded_input" | "precondition_changed";
    }>
  | Readonly<{
      kind: "run_input_queued";
      inputId: string;
      text: string;
      acceptedSeq: number;
    }>
  | Readonly<{
      kind: "run_input_withdrawn";
      inputId: string;
    }>
  | Readonly<{
      kind: "run_input_batch_consumed";
      inputIds: readonly string[];
      throughSeq: number;
      taskRevision: number;
    }>
  | Readonly<{
      kind: "tool_call_cancelled";
      toolCallId: string;
      providerToolCallId?: string;
      toolName: string;
      reason: "user_input_superseded" | "run_cancelled" | "sibling_stopped";
    }>
  | Readonly<{
      kind: "question_requested";
      questionId: string;
      toolCallId: string;
      question: string;
      answerType: "choice" | "text" | "confirmation";
      waitToken: string;
      requestVersion: number;
    }>
  | Readonly<{
      kind: "question_answered";
      questionId: string;
      toolCallId: string;
      answerText: string;
    }>
  | Readonly<{
      kind: "question_declined";
      questionId: string;
      toolCallId: string;
    }>
  | Readonly<{
      kind: "question_cancelled";
      questionId: string;
      toolCallId: string;
    }>
  | Readonly<{
      kind: "question_unavailable";
      questionId: string;
      toolCallId: string;
    }>
  | Readonly<{
      kind: "question_view_closed";
      questionId: string;
    }>
  | Readonly<{
      kind: "tool_result_delivery_blocked";
      reason: "owned_key_detected" | "guard_failure";
    }>
  | Readonly<{
      kind: "todo_replaced";
      revision: number;
      items: readonly Readonly<{
        id: string;
        content: string;
        state: "pending" | "in_progress" | "completed" | "cancelled";
      }>[];
    }>
  | Readonly<{
      kind: "tool_dispatch_committed";
      dispatchId: string;
      toolCallId: string;
      approvalId: string | null;
    }>
  | Readonly<{
      kind: "tool_execution_started";
      toolCallId: string;
      toolName: string;
    }>
  | Readonly<{
      kind: "tool_execution_finished";
      toolCallId: string;
      status: "succeeded" | "failed" | "outcome_unknown";
      safeCode: string | null;
      text: string | null;
      /** Name of the tool, so a replay can rebuild the result without a lookup. */
      toolName?: string;
    }>
  | Readonly<{
      kind: "tool_execution_denied";
      toolCallId: string;
      toolName: string;
    }>;

export type InternalEventBody = Readonly<{
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  runId: string;
  seq: number;
  timestampUtc: string;
  type: InternalEventPayload["kind"];
  correlationId: string;
  causationId: string | null;
  previousEventId: string | null;
  previousHash: string | null;
  payload: InternalEventPayload;
}>;

export type InternalEvent = InternalEventBody & Readonly<{ hash: string }>;

export type EventInput = Readonly<{
  sessionId: string;
  runId: string;
  type: InternalEventPayload["kind"];
  correlationId: string;
  causationId: string | null;
  timestampUtc: string;
  payload: InternalEventPayload;
}>;

export interface EventLog {
  append(input: EventInput): Promise<InternalEvent>;
  read(sessionId: string): Promise<readonly InternalEvent[]>;
}

export class InMemoryEventLog implements EventLog {
  readonly #eventsBySession = new Map<string, InternalEvent[]>();
  readonly #ids: IdentifierFactory;
  readonly #digests: DigestService;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(ids: IdentifierFactory, digests: DigestService) {
    this.#ids = ids;
    this.#digests = digests;
  }

  append(input: EventInput): Promise<InternalEvent> {
    const operation = this.#writeTail.then(() => this.#appendNow(input));
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async read(sessionId: string): Promise<readonly InternalEvent[]> {
    await this.#writeTail;
    return [...(this.#eventsBySession.get(sessionId) ?? [])];
  }

  async #appendNow(input: EventInput): Promise<InternalEvent> {
    const events = this.#eventsBySession.get(input.sessionId) ?? [];
    const previous = events.at(-1) ?? null;
    const body: InternalEventBody = {
      schemaVersion: 1,
      eventId: this.#ids.create(),
      sessionId: input.sessionId,
      runId: input.runId,
      seq: (previous?.seq ?? 0) + 1,
      timestampUtc: input.timestampUtc,
      type: input.type,
      correlationId: input.correlationId,
      causationId: input.causationId,
      previousEventId: previous?.eventId ?? null,
      previousHash: previous?.hash ?? null,
      payload: input.payload,
    };
    const event: InternalEvent = {
      ...body,
      hash: await this.#digests.sha256Canonical(body),
    };
    events.push(event);
    this.#eventsBySession.set(input.sessionId, events);
    return event;
  }
}
