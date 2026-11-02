/**
 * Stage 1 in-memory verification model. This is deliberately not an adopted
 * external JSON Schema or durable persistence format.
 */
export type InternalEventPayload =
  | Readonly<{ kind: "run_started"; input: string }>
  | Readonly<{
      kind: "run_waiting";
      reason: "configuration";
      safeCode: string;
    }>
  | Readonly<{ kind: "run_completed"; text: string | null }>
  | Readonly<{ kind: "run_failed"; safeCode: string }>
  | Readonly<{ kind: "run_cancelled"; safeCode: string }>
  | Readonly<{ kind: "model_request_started"; modelRequestId: string; attemptNo: number }>
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
    }>
  | Readonly<{
      kind: "tool_call_received";
      toolCallId: string;
      providerToolCallId: string;
      toolName: string;
    }>
  | Readonly<{
      kind: "approval_requested";
      approvalId: string;
      toolCallId: string;
      toolName: string;
    }>
  | Readonly<{
      kind: "approval_decided";
      approvalId: string;
      toolCallId: string;
      decision: "approved" | "denied";
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
