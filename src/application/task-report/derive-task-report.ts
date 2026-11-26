import type { EvidenceRef, UnavailableEvidence } from "../../domain/evidence/evidence-ref.ts";
import {
  type Assertion,
  buildReportSnapshot,
  type ReportResult,
  type ReportSnapshot,
} from "../../domain/evidence/verification.ts";
import type { InternalEvent } from "../../ports/event-log.ts";

/**
 * Only trusted facts establish execution/evidence status. No command-name guess
 * makes a Shell invocation a test, and model completion prose cannot verify the
 * user's goal. Later independent check observations can add goal assertions.
 */
export function deriveTaskReport(
  events: readonly InternalEvent[],
  sessionId: string,
  runId: string,
): ReportResult {
  const facts = events.filter((event) => event.sessionId === sessionId && event.runId === runId);
  const started = facts.find((event) => event.payload.kind === "run_started");
  if (started?.payload.kind !== "run_started")
    return { ok: false, code: "missing_required_field", detail: "run_started" };
  const toolCalls = new Map<string, Readonly<{ toolName: string; arguments: unknown }>>();
  const providerToInternal = new Map<string, string>();
  const openDispatches = new Set<string>();
  const unknown = new Set<string>();
  const unavailable: UnavailableEvidence[] = [];
  const syntaxByPath = new Map<
    string,
    Readonly<{
      event: InternalEvent;
      state: "passed" | "failed" | "not_run";
      description: string;
    }>
  >();
  const mutationSeqByPath = new Map<string, number>();
  /** Successful change history per path, so a reverted edit can reveal the prior one. */
  const changeHistory = new Map<
    string,
    { entry: ReportSnapshot["changes"][number]; toolCallId: string; seq: number }[]
  >();
  const changes = new Map<string, ReportSnapshot["changes"][number]>();
  const tests: ReportSnapshot["tests"][number][] = [];
  let latestChange: string | null = null;
  let view: ReportSnapshot["view"] = "progress";
  let wait: ReportSnapshot["wait"] = null;
  let knownUsd = 0;
  let attempts = 0;
  /**
   * Requests whose token cost is unknown.
   *
   * Counted from the responses themselves, not from a blanket flag: a request whose
   * provider reported usage has a known token count, and only the ones that did not
   * are unknown. The previous rule marked every request unknown because no usage was
   * ever captured.
   */
  let unpricedAttempts = 0;
  let costUnknown = false;
  const approved = new Set<string>();
  const background = new Map<string, string>();

  for (const event of facts) {
    const fact = event.payload;
    switch (fact.kind) {
      case "run_input_queued":
        latestChange = fact.text;
        break;
      case "tool_call_received":
        toolCalls.set(fact.toolCallId, {
          toolName: fact.toolName,
          arguments: fact.arguments,
        });
        providerToInternal.set(fact.providerToolCallId, fact.toolCallId);
        break;
      case "approval_decided":
        if (fact.decision === "approved") approved.add(fact.toolCallId);
        wait = null;
        view = "progress";
        break;
      case "tool_dispatch_committed":
        openDispatches.add(fact.toolCallId);
        view = "progress";
        wait = null;
        break;
      case "background_task_observed":
        background.set(fact.task.taskId, fact.task.state);
        if (fact.task.state === "outcome_unknown") unknown.add(fact.task.processExecutionId);
        if ("evidence" in fact.task && fact.task.evidence?.rawComplete === false)
          unavailable.push({
            ref: eventRef(event),
            reason:
              fact.task.evidence.rawTruncationReason === "blocked"
                ? "content_not_stored"
                : "capture_truncated",
          });
        break;
      case "tool_execution_finished": {
        openDispatches.delete(fact.toolCallId);
        if (fact.status === "outcome_unknown") unknown.add(fact.toolCallId);
        if (fact.evidence !== undefined && !fact.evidence.rawComplete) {
          unavailable.push({
            ref: eventRef(event),
            reason:
              fact.evidence.rawTruncationReason === "blocked"
                ? "content_not_stored"
                : "capture_truncated",
          });
        }
        const call = toolCalls.get(fact.toolCallId);
        if (call !== undefined) {
          const paths = mutationPaths(call);
          if (fact.status === "succeeded") {
            for (const path of paths) {
              const entry = { path, applied: true, scope: "code" } as const;
              changes.set(path, entry);
              mutationSeqByPath.set(path, event.seq);
              const history = changeHistory.get(path) ?? [];
              history.push({ entry, toolCallId: fact.toolCallId, seq: event.seq });
              changeHistory.set(path, history);
            }
          }
          if (isDeclaredVerification(call)) {
            tests.push({
              command: shellCommandOf(call),
              basis: "caller_declared",
              approved: approved.has(fact.toolCallId),
              executionId: fact.toolCallId,
              outcome:
                fact.status === "succeeded"
                  ? "passed"
                  : fact.status === "failed"
                    ? "failed"
                    : "outcome_unknown",
              coveredVersion: null,
            });
          }
        }
        break;
      }
      case "tool_execution_denied":
      case "tool_call_cancelled": {
        const call = toolCalls.get(fact.toolCallId);
        if (call !== undefined && isDeclaredVerification(call)) {
          tests.push({
            command: shellCommandOf(call),
            basis: "caller_declared",
            approved: false,
            executionId: fact.toolCallId,
            outcome: "not_run",
            coveredVersion: null,
          });
        }
        break;
      }
      case "syntax_check_failed": {
        const rollback = fact.rollback ?? (fact.reverted ? "reverted" : "unavailable");
        syntaxByPath.set(fact.path, {
          event,
          state: "failed",
          description:
            `syntax check failed: ${fact.path}` +
            (rollback === "reverted"
              ? " (edit reverted)"
              : rollback === "conflict"
                ? " (edit kept; file changed)"
                : " (edit kept; rollback unavailable)"),
        });
        // A reverted edit is not a change. Only remove the entry this exact call
        // produced; an earlier successful edit to the same path remains.
        const internalCallId = providerToInternal.get(fact.toolCallId) ?? fact.toolCallId;
        if (rollback === "reverted") {
          const history = changeHistory.get(fact.path);
          if (history?.at(-1)?.toolCallId === internalCallId) {
            history.pop();
            const previous = history.at(-1);
            if (previous === undefined) {
              changes.delete(fact.path);
              mutationSeqByPath.delete(fact.path);
            } else {
              changes.set(fact.path, previous.entry);
              mutationSeqByPath.set(fact.path, previous.seq);
            }
          }
        }
        break;
      }
      case "syntax_check_skipped":
        syntaxByPath.set(fact.path, {
          event,
          state: "not_run",
          description: `syntax check skipped: ${fact.path} (${fact.reason})`,
        });
        break;
      case "syntax_check_passed":
        syntaxByPath.set(fact.path, {
          event,
          state: "passed",
          description: `syntax check passed: ${fact.path}`,
        });
        break;
      case "evidence_unavailable":
        unavailable.push({ ref: fact.ref, reason: fact.reason });
        break;
      case "model_request_started":
        attempts++;
        break;
      case "model_response_validated":
        // No usage on a validated response means the provider did not report one.
        if (fact.usage === undefined) unpricedAttempts++;
        break;
      case "run_budget_updated":
        knownUsd = fact.budget.knownSpendingUsd;
        costUnknown = fact.costUnknown;
        break;
      case "run_waiting":
        view = "waiting";
        wait = {
          reason: fact.reason,
          waitToken: fact.waitToken,
          requiredAction:
            fact.safeCode === "sensitive_disclosure_required"
              ? "disclosure_consent"
              : fact.reason === "approval"
                ? "reply_approval"
                : fact.reason === "user_input"
                  ? "submit_user_input"
                  : "resume_run",
        };
        break;
      case "sensitive_disclosure_requested":
        view = "waiting";
        wait = {
          reason: "sensitive_disclosure",
          waitToken: fact.disclosureId,
          requiredAction: "disclosure_consent",
        };
        break;
      case "sensitive_disclosure_decided":
      case "question_answered":
      case "question_declined":
      case "question_cancelled":
      case "run_resumed":
        wait = null;
        view = "progress";
        break;
      case "run_completed":
      case "run_failed":
      case "run_cancelled":
        view = "terminal";
        wait = null;
        break;
    }
  }
  for (const id of openDispatches) unknown.add(id);

  const assertions: Assertion[] = [
    {
      assertionId: `${runId}:goal`,
      kind: "required_goal",
      description: started.payload.input,
      state: "unknown",
      applicability: unknown.size === 0 ? "current" : "indeterminate",
      evidence: [],
      unavailableEvidence: unavailable,
      required: true,
    },
  ];
  for (const [path, fact] of syntaxByPath) {
    const laterMutation = (mutationSeqByPath.get(path) ?? 0) > fact.event.seq;
    assertions.push({
      assertionId: `${runId}:syntax:${path}`,
      kind: "supporting_check",
      description: fact.description,
      state: fact.state,
      applicability: laterMutation ? "stale" : "current",
      evidence: [eventRef(fact.event)],
      unavailableEvidence: [],
      required: false,
    });
  }
  if (tests.length === 0 && (changes.size > 0 || syntaxByPath.size > 0)) {
    assertions.push({
      assertionId: `${runId}:project-tests`,
      kind: "supporting_check",
      description: "project verification command: not recorded",
      state: "not_run",
      applicability: "current",
      evidence: [],
      unavailableEvidence: [],
      required: false,
    });
  }

  return buildReportSnapshot({
    sessionId,
    runId,
    sourceHighWaterSeq: events.at(-1)?.seq ?? 0,
    projectionVersion: "internal-facts-1",
    generatorVersion: "conservative-report-2",
    view,
    userGoal: started.payload.input,
    latestChange,
    assertions,
    // Only successful, known mutations are listed. A shell command may still
    // modify arbitrary files, so this is not a complete change list.
    changes: [...changes.values()],
    tests,
    unknownSideEffects: [...unknown].map(
      (id) =>
        `${toolCalls.get(id)?.toolName ?? "tool"}:${id}${approved.has(id) ? ":approved" : ""}`,
    ),
    backgroundTasks: [...background].map(([taskId, state]) => ({ taskId, state })),
    wait,
    nextUserActions: wait === null ? [] : [wait.requiredAction],
    usage: {
      knownUsd,
      // Counted from the responses: a request that reported tokens is not an unknown
      // charge even though no price table exists yet. The flag is retained for the
      // case where the run ended before any response settled the question.
      unknownChargeCount:
        unpricedAttempts > 0 ? unpricedAttempts : costUnknown && attempts > 0 ? attempts : 0,
    },
  });
}

function mutationPaths(
  call: Readonly<{ toolName: string; arguments: unknown }>,
): readonly string[] {
  if (
    !["create_file", "edit_file", "delete_path", "rename_path", "apply_patch"].includes(
      call.toolName,
    )
  )
    return [];
  if (typeof call.arguments !== "object" || call.arguments === null) return [];
  const record = call.arguments as Record<string, unknown>;

  const path = record["path"];
  if (typeof path === "string" && path.length > 0) return [path];

  const paths = record["paths"];
  if (Array.isArray(paths))
    return paths.filter((value): value is string => typeof value === "string");

  const from = record["from"];
  const to = record["to"];
  if (typeof from === "string" && typeof to === "string") return [from, to];

  const patch = record["patch"];
  if (typeof patch === "string") {
    const targets = patch
      .split("\n")
      .filter((line) => line.startsWith("+++ "))
      .map((line) => line.slice(4).trim())
      .map((value) => (value.startsWith("b/") ? value.slice(2) : value))
      .filter((value) => value.length > 0 && value !== "/dev/null");
    return [...new Set(targets)];
  }
  return [];
}

function isDeclaredVerification(call: Readonly<{ toolName: string; arguments: unknown }>): boolean {
  if (call.toolName !== "shell") return false;
  if (typeof call.arguments !== "object" || call.arguments === null) return false;
  return (call.arguments as Record<string, unknown>)["verification"] === true;
}

function shellCommandOf(call: Readonly<{ toolName: string; arguments: unknown }>): string {
  if (typeof call.arguments === "object" && call.arguments !== null) {
    const command = (call.arguments as Record<string, unknown>)["command"];
    if (typeof command === "string" && command.length > 0) return command;
  }
  return "(unknown shell command)";
}

function eventRef(event: InternalEvent): EvidenceRef {
  return { kind: "event", sessionId: event.sessionId, eventId: event.eventId, seq: event.seq };
}
