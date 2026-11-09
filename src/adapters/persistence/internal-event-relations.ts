import type { BackgroundTaskFact } from "../../ports/background-task.ts";
import type { InternalEvent } from "../../ports/event-log.ts";

/**
 * Cross-event relation checks.
 *
 * The log must agree with itself: a dispatch needs a call, a task needs a
 * dispatched `background_start`, a report cannot cite evidence that does not
 * exist. These rules span events, so they cannot be checked one event at a time
 * without carrying state.
 *
 * The state is exposed so an append can continue from a verified prefix instead of
 * replaying the whole file. Replaying was the dominant cost of a long Session: the
 * log re-read and re-hashed every earlier event on every append, which is
 * quadratic in the number of events.
 */

export type RelationState = Readonly<{
  calls: Map<string, { runId: string; name: string; dispatched: boolean }>;
  tasks: Map<string, BackgroundTaskFact>;
  executions: Set<string>;
  reports: Map<string, number>;
  attachments: Set<string>;
  /** seq to eventId, so a report can cite an earlier event without the full array. */
  eventIds: Map<number, string>;
}>;

export function createRelationState(): RelationState {
  return {
    calls: new Map(),
    tasks: new Map(),
    executions: new Set(),
    reports: new Map(),
    attachments: new Set(),
    eventIds: new Map(),
  };
}

/**
 * Apply one event to the state, returning false when it contradicts an earlier one.
 *
 * The caller must apply events in seq order. A rejected event must not be applied;
 * the state is left usable for a retry with a corrected event, but the caller is
 * expected to stop and fail closed instead.
 */
export function applyEventToRelations(state: RelationState, event: InternalEvent): boolean {
  const fact = event.payload;
  switch (fact.kind) {
    case "tool_call_received":
      state.calls.set(fact.toolCallId, {
        runId: event.runId,
        name: fact.toolName,
        dispatched: false,
      });
      break;
    case "tool_dispatch_committed": {
      const call = state.calls.get(fact.toolCallId);
      if (call !== undefined) call.dispatched = true;
      break;
    }
    case "background_task_observed": {
      const task = fact.task;
      const call = state.calls.get(task.launchingToolCallId);
      if (call?.runId !== event.runId || call.name !== "background_start" || !call.dispatched)
        return false;
      const previous = state.tasks.get(task.taskId);
      if (previous === undefined) {
        if (task.state !== "registered" || state.executions.has(task.processExecutionId))
          return false;
        state.executions.add(task.processExecutionId);
      } else {
        if (previous.state !== "registered" && previous.state !== "running") return false;
        if (task.state === "registered") return false;
        if (
          task.processExecutionId !== previous.processExecutionId ||
          task.launchingToolCallId !== previous.launchingToolCallId ||
          task.ownerRunId !== previous.ownerRunId ||
          task.sessionId !== previous.sessionId
        )
          return false;
        if (
          previous.state === "running" &&
          (task.state === "running" || task.processId !== previous.processId)
        )
          return false;
      }
      if (task.state === "succeeded" && (task.exitCode !== 0 || task.timedOut)) return false;
      state.tasks.set(task.taskId, task);
      if ("evidence" in task)
        for (const attachment of task.evidence?.attachments ?? [])
          state.attachments.add(
            `${event.runId}:${task.launchingToolCallId}:${attachment.ref.attachmentId}`,
          );
      break;
    }
    case "tool_execution_finished":
      for (const attachment of fact.evidence?.attachments ?? [])
        state.attachments.add(`${event.runId}:${fact.toolCallId}:${attachment.ref.attachmentId}`);
      break;
    case "evidence_unavailable":
      if (!state.attachments.has(`${event.runId}:${fact.toolCallId}:${fact.ref.attachmentId}`))
        return false;
      break;
    case "task_report_snapshot": {
      const report = fact.report;
      if (report.sourceHighWaterSeq < (state.reports.get(event.runId) ?? 0)) return false;
      for (const assertion of report.assertions)
        for (const ref of [
          ...assertion.evidence,
          ...assertion.unavailableEvidence.map(({ ref }) => ref),
        ])
          if (
            ref.kind === "event" &&
            (ref.sessionId !== event.sessionId ||
              ref.seq > report.sourceHighWaterSeq ||
              state.eventIds.get(ref.seq) !== ref.eventId)
          )
            return false;
      state.reports.set(event.runId, report.sourceHighWaterSeq);
      break;
    }
  }
  state.eventIds.set(event.seq, event.eventId);
  return true;
}

/** Validate a complete sequence of events. */
export function hasValidInternalEventRelations(events: readonly InternalEvent[]): boolean {
  const state = createRelationState();
  for (const event of events) {
    if (!applyEventToRelations(state, event)) return false;
  }
  return true;
}
