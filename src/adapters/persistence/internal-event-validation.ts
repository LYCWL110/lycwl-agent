import { type EvidenceRef, validateEvidenceRef } from "../../domain/evidence/evidence-ref.ts";
import { aggregateVerification, type ReportSnapshot } from "../../domain/evidence/verification.ts";
import type { InternalEvent } from "../../ports/event-log.ts";

type Check = (value: unknown) => boolean;
const text: Check = (value) => typeof value === "string";
const id: Check = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;
const integer: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 0;
const positive: Check = (value) => integer(value) && (value as number) > 0;
const utc: Check = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) &&
  Number.isFinite(Date.parse(value));
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const array =
  (check: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(check);
const oneOf =
  (...values: readonly unknown[]): Check =>
  (value) =>
    values.includes(value);
const anyJson: Check = () => true;

function object(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
      Object.entries(required).every(
        ([key, check]) => Object.hasOwn(record, key) && check(record[key]),
      ) &&
      Object.entries(record).every(([key, entry]) => {
        const check = required[key] ?? optional[key];
        return check !== undefined && check(entry);
      })
    );
  };
}

const call = object({ providerToolCallId: id, toolName: id, arguments: anyJson });
const tokenUsage = object(
  { inputTokens: integer, outputTokens: integer },
  { cachedInputTokens: integer, reasoningTokens: integer },
);
const questionLink = { questionId: id, toolCallId: id };
const toolLink = { toolCallId: id, toolName: id };
const toolEvidenceShape = object({
  captureId: nullable(id),
  manifestSha256: nullable(id),
  capturedBytes: integer,
  rawComplete: (value) => typeof value === "boolean",
  rawTruncationReason: oneOf(null, "capture_interrupted", "raw_limit", "storage_failed", "blocked"),
  attachments: array(
    object({
      stream: oneOf("stdout", "stderr"),
      ref: object({
        kind: oneOf("attachment_bytes"),
        attachmentId: id,
        sha256: id,
        byteLength: integer,
        start: integer,
        end: integer,
      }),
    }),
  ),
});
const toolEvidence: Check = (value) => {
  if (!toolEvidenceShape(value)) return false;
  const evidence = value as NonNullable<
    Extract<
      InternalEvent["payload"],
      {
        kind: "tool_execution_finished";
      }
    >["evidence"]
  >;
  if (!evidence.rawComplete)
    return (
      evidence.captureId === null &&
      evidence.manifestSha256 === null &&
      evidence.rawTruncationReason !== null &&
      evidence.attachments.length === 0
    );
  return (
    evidence.captureId !== null &&
    evidence.manifestSha256 !== null &&
    /^[0-9a-f]{64}$/.test(evidence.manifestSha256) &&
    evidence.rawTruncationReason === null &&
    evidence.attachments.length === 2 &&
    evidence.attachments.every(
      ({ ref, stream }, index) =>
        stream === (index === 0 ? "stdout" : "stderr") &&
        ref.attachmentId === `${evidence.captureId}-${stream}` &&
        ref.start === 0 &&
        ref.end === ref.byteLength &&
        validateEvidenceRef(ref).ok,
    ) &&
    evidence.capturedBytes ===
      evidence.attachments.reduce((total, { ref }) => total + ref.byteLength, 0) &&
    evidence.capturedBytes <= 8 * 1024 * 1024
  );
};
const attachmentRef = object({
  kind: oneOf("attachment_bytes"),
  attachmentId: id,
  sha256: id,
  byteLength: integer,
  start: integer,
  end: integer,
});
const reportEvidenceRef: Check = (value) =>
  (attachmentRef(value) ||
    object({ kind: oneOf("event"), sessionId: id, eventId: id, seq: positive })(value)) &&
  validateEvidenceRef(value as EvidenceRef).ok;
const assertion = object({
  assertionId: id,
  kind: oneOf("required_goal", "supporting_check", "model_claim"),
  description: text,
  state: oneOf("passed", "failed", "not_run", "in_progress", "unknown"),
  applicability: oneOf("current", "stale", "unaffected", "indeterminate"),
  evidence: array(reportEvidenceRef),
  unavailableEvidence: array(
    object({
      ref: reportEvidenceRef,
      reason: oneOf(
        "attachment_missing",
        "hash_mismatch",
        "capture_truncated",
        "snapshot_superseded",
        "content_not_stored",
      ),
    }),
  ),
  required: (value) => typeof value === "boolean",
});
const verificationStatus = oneOf(
  "verified",
  "partially_verified",
  "unverified",
  "blocked",
  "failed",
);
const reportShape = object({
  sessionId: id,
  runId: id,
  sourceHighWaterSeq: integer,
  projectionVersion: id,
  generatorVersion: id,
  view: oneOf("progress", "waiting", "terminal"),
  userGoal: text,
  latestChange: nullable(text),
  assertions: array(assertion),
  verification: object({
    status: verificationStatus,
    blockers: array(
      object({
        assertionId: id,
        reason: oneOf(
          "evidence_missing",
          "check_denied",
          "unknown_side_effect",
          "not_run_required",
        ),
      }),
    ),
    perAssertion: array(object({ assertionId: id, status: verificationStatus })),
  }),
  changes: array(
    object({ path: text, applied: (value) => typeof value === "boolean", scope: text }),
  ),
  tests: array(
    object({
      command: text,
      approved: (value) => typeof value === "boolean",
      executionId: nullable(id),
      outcome: oneOf("passed", "failed", "not_run", "outcome_unknown"),
      coveredVersion: nullable(id),
    }),
  ),
  unknownSideEffects: array(id),
  backgroundTasks: array(object({ taskId: id, state: id })),
  wait: nullable(
    object({
      reason: id,
      waitToken: id,
      requiredAction: oneOf(
        "reply_approval",
        "submit_user_input",
        "resume_run",
        "disclosure_consent",
      ),
    }),
  ),
  nextUserActions: array(id),
  usage: object({
    knownUsd: (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
    unknownChargeCount: integer,
  }),
  evidenceAvailable: (value) => typeof value === "boolean",
});
const reportCheck: Check = (value) => {
  if (!reportShape(value)) return false;
  const report = value as ReportSnapshot;
  return (
    new Set(report.assertions.map(({ assertionId }) => assertionId)).size ===
      report.assertions.length &&
    report.evidenceAvailable ===
      (report.assertions.length > 0 &&
        report.assertions.every(({ unavailableEvidence }) => unavailableEvidence.length === 0)) &&
    (report.view === "waiting" ? report.wait !== null : report.wait === null) &&
    JSON.stringify(aggregateVerification(report.assertions)) === JSON.stringify(report.verification)
  );
};

/** Internal v1 payloads only; this does not adopt the external schema proposals. */
const payloadChecks = {
  background_task_observed: object({
    kind: text,
    task: (value) => {
      const base = {
        sessionId: id,
        ownerRunId: id,
        launchingToolCallId: id,
        taskId: id,
        processExecutionId: id,
        observedAtUtc: utc,
      };
      return (
        object({
          ...base,
          state: oneOf("registered"),
          processId: oneOf(null),
          exitCode: oneOf(null),
          timedOut: oneOf(false),
        })(value) ||
        object({
          ...base,
          state: oneOf("running"),
          processId: positive,
          exitCode: oneOf(null),
          timedOut: oneOf(false),
        })(value) ||
        object(
          {
            ...base,
            state: oneOf("succeeded", "failed", "cancelled", "outcome_unknown"),
            processId: nullable(positive),
            exitCode: nullable(integer),
            timedOut: (entry) => typeof entry === "boolean",
          },
          {
            evidence: toolEvidence,
            deliveryBlocked: oneOf("owned_key_detected", "guard_failure"),
          },
        )(value)
      );
    },
  }),
  task_report_snapshot: object({
    kind: text,
    protocolRunState: oneOf("active", "waiting", "completed", "failed", "cancelled"),
    report: reportCheck,
  }),
  evidence_unavailable: object({
    kind: text,
    toolCallId: id,
    ref: attachmentRef,
    reason: oneOf("attachment_missing", "hash_mismatch", "content_not_stored"),
  }),
  syntax_check_failed: object({
    kind: text,
    toolCallId: id,
    path: text,
    line: nullable(integer),
    message: text,
    reverted: (value) => typeof value === "boolean",
  }),
  syntax_check_skipped: object({
    kind: text,
    toolCallId: id,
    path: text,
    reason: oneOf("not_supported", "too_large", "checker_unavailable"),
  }),
  tool_output_formatted: object({
    kind: text,
    toolCallId: id,
    path: text,
    formatter: id,
  }),
  tool_output_format_failed: object({
    kind: text,
    toolCallId: id,
    path: text,
    reason: id,
  }),
  snapshot_unavailable: object({
    kind: text,
    toolCallId: id,
    path: text,
    reason: oneOf("too_large", "limit_exceeded", "capture_failed"),
  }),
  tool_output_spilled: object({
    kind: text,
    toolCallId: id,
    providerToolCallId: id,
    toolName: id,
    totalUnits: integer,
    previewUnits: integer,
    reference: text,
    readable: (value) => typeof value === "boolean",
  }),
  run_budget_updated: object({
    kind: text,
    budget: object({
      modelRounds: integer,
      compactions: integer,
      elapsedActiveMs: integer,
      testFixCycles: integer,
      knownSpendingUsd: (value) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0,
    }),
    costUnknown: (value) => typeof value === "boolean",
  }),
  sensitive_source_recorded: object({
    kind: text,
    source: object({
      sourceId: id,
      label: text,
      contentDigest: id,
      origin: nullable(
        object({
          providerId: id,
          modelId: id,
          protocolId: id,
          endpointFingerprint: id,
          credentialRef: id,
          credentialRevision: positive,
        }),
      ),
    }),
  }),
  sensitive_disclosure_requested: object({
    kind: text,
    disclosureId: id,
    modelRequestId: id,
    requestVersion: positive,
    requestFingerprint: id,
    safePreview: text,
    sourceIds: array(id),
  }),
  sensitive_disclosure_decided: object({
    kind: text,
    disclosureId: id,
    modelRequestId: id,
    requestVersion: positive,
    requestFingerprint: id,
    decision: oneOf("approved", "denied", "cancelled", "invalidated"),
    commandId: nullable(id),
  }),
  run_started: object({ kind: text, input: text }),
  run_model_binding: object({
    kind: text,
    providerId: id,
    modelId: id,
    protocolId: id,
    adapterVersion: id,
    endpointFingerprint: id,
    catalogSnapshotId: id,
    capabilitySnapshotId: id,
    credentialRef: id,
    credentialRevision: positive,
  }),
  run_waiting: object({
    kind: text,
    reason: oneOf("configuration", "approval", "user_input", "recovery", "external_dependency"),
    safeCode: id,
    waitToken: id,
    requestVersion: positive,
  }),
  run_completed: object({ kind: text, text: nullable(text) }),
  run_failed: object({ kind: text, safeCode: id }),
  run_cancelled: object({ kind: text, safeCode: id }),
  run_cancel_requested: object({ kind: text, commandId: id }),
  run_resumed: object({ kind: text }),
  context_compacted: object(
    {
      kind: text,
      artifactSha256: id,
      summarizedGroupIds: array(id),
      recentSuffixGroupIds: array(id),
      sourceHighWaterSeq: integer,
      estimatedAuxiliaryTokens: integer,
      artifactVersion: positive,
      summaryText: text,
    },
    { pinnedUserInputs: array(text) },
  ),
  context_compaction_rejected: object({
    kind: text,
    reason: oneOf("capacity_insufficient", "invalid_artifact", "attempts_exhausted"),
    detail: text,
  }),
  no_progress_detected: object({
    kind: text,
    decision: oneOf("warn", "block"),
    detail: text,
    toolName: id,
  }),
  model_request_started: object(
    { kind: text, modelRequestId: id, attemptNo: positive },
    { includedInputIds: array(id), credentialRevision: positive },
  ),
  model_retry_scheduled: object({
    kind: text,
    modelRequestId: id,
    failedAttemptNo: positive,
    retryAfterMs: integer,
    safeCode: id,
  }),
  model_response_validated: object(
    {
      kind: text,
      modelRequestId: id,
      attemptNo: positive,
      toolCallCount: integer,
      text: nullable(text),
    },
    { toolCalls: array(call), usage: tokenUsage },
  ),
  tool_call_received: object({
    kind: text,
    ...toolLink,
    providerToolCallId: id,
    arguments: anyJson,
  }),
  approval_requested: object({ kind: text, ...toolLink, approvalId: id, safePreview: text }),
  approval_decided: object({
    kind: text,
    approvalId: id,
    toolCallId: id,
    decision: oneOf("approved", "denied"),
  }),
  approval_grant_revoked: object({
    kind: text,
    approvalId: id,
    toolCallId: id,
    reason: oneOf("restart", "superseded_input", "precondition_changed"),
  }),
  run_input_queued: object({ kind: text, inputId: id, text, acceptedSeq: positive }),
  run_input_withdrawn: object({ kind: text, inputId: id }),
  run_input_batch_consumed: object({
    kind: text,
    inputIds: array(id),
    throughSeq: integer,
    taskRevision: positive,
  }),
  tool_call_cancelled: object(
    {
      kind: text,
      ...toolLink,
      reason: oneOf("user_input_superseded", "run_cancelled", "sibling_stopped"),
    },
    { providerToolCallId: id },
  ),
  question_requested: object({
    kind: text,
    ...questionLink,
    question: text,
    answerType: oneOf("choice", "text", "confirmation"),
    waitToken: id,
    requestVersion: positive,
  }),
  question_answered: object({ kind: text, ...questionLink, answerText: text }),
  question_declined: object({ kind: text, ...questionLink }),
  question_cancelled: object({ kind: text, ...questionLink }),
  question_unavailable: object({ kind: text, ...questionLink }),
  question_view_closed: object({ kind: text, questionId: id }),
  tool_result_delivery_blocked: object({
    kind: text,
    reason: oneOf("owned_key_detected", "guard_failure"),
  }),
  todo_replaced: object({
    kind: text,
    revision: positive,
    items: array(
      object({
        id,
        content: text,
        state: oneOf("pending", "in_progress", "completed", "cancelled"),
      }),
    ),
  }),
  tool_dispatch_committed: object({
    kind: text,
    dispatchId: id,
    toolCallId: id,
    approvalId: nullable(id),
  }),
  tool_execution_started: object({ kind: text, ...toolLink }),
  tool_execution_finished: object(
    {
      kind: text,
      toolCallId: id,
      status: oneOf("succeeded", "failed", "cancelled", "outcome_unknown"),
      safeCode: nullable(text),
      text: nullable(text),
    },
    { toolName: id, evidence: toolEvidence },
  ),
  tool_execution_denied: object({ kind: text, ...toolLink }),
} satisfies Record<InternalEvent["type"], Check>;

const envelope = object({
  schemaVersion: oneOf(1),
  eventId: id,
  sessionId: id,
  runId: id,
  seq: positive,
  timestampUtc: utc,
  type: (value) => typeof value === "string" && Object.hasOwn(payloadChecks, value),
  correlationId: id,
  causationId: nullable(id),
  previousEventId: nullable(id),
  previousHash: nullable(id),
  payload: anyJson,
  hash: id,
});

export function isInternalEvent(value: unknown): value is InternalEvent {
  if (!envelope(value)) return false;
  const candidate = value as InternalEvent;
  return (
    payloadChecks[candidate.type](candidate.payload) &&
    candidate.payload.kind === candidate.type &&
    (candidate.payload.kind !== "background_task_observed" ||
      (candidate.payload.task.sessionId === candidate.sessionId &&
        candidate.payload.task.ownerRunId === candidate.runId)) &&
    (candidate.payload.kind !== "task_report_snapshot" ||
      (candidate.payload.report.sessionId === candidate.sessionId &&
        candidate.payload.report.runId === candidate.runId &&
        candidate.payload.report.sourceHighWaterSeq < candidate.seq &&
        (candidate.payload.protocolRunState === "waiting"
          ? candidate.payload.report.view === "waiting"
          : candidate.payload.protocolRunState === "active"
            ? candidate.payload.report.view === "progress"
            : candidate.payload.report.view === "terminal"))) &&
    (candidate.payload.kind !== "model_response_validated" ||
      candidate.payload.toolCalls === undefined ||
      candidate.payload.toolCalls.length === candidate.payload.toolCallCount)
  );
}
