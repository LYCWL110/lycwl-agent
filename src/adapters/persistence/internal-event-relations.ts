import type { BackgroundTaskFact } from "../../ports/background-task.ts";
import type { InternalEvent } from "../../ports/event-log.ts";

/** Additional internal facts must agree with the earlier authoritative log. */
export function hasValidInternalEventRelations(events: readonly InternalEvent[]): boolean {
  const calls = new Map<string, { runId: string; name: string; dispatched: boolean }>();
  const tasks = new Map<string, BackgroundTaskFact>();
  const executions = new Set<string>();
  const reports = new Map<string, number>();
  const attachments = new Set<string>();
  for (const event of events) {
    const fact = event.payload;
    switch (fact.kind) {
      case "tool_call_received":
        calls.set(fact.toolCallId, { runId: event.runId, name: fact.toolName, dispatched: false });
        break;
      case "tool_dispatch_committed": {
        const call = calls.get(fact.toolCallId);
        if (call !== undefined) call.dispatched = true;
        break;
      }
      case "background_task_observed": {
        const task = fact.task;
        const call = calls.get(task.launchingToolCallId);
        if (call?.runId !== event.runId || call.name !== "background_start" || !call.dispatched)
          return false;
        const previous = tasks.get(task.taskId);
        if (previous === undefined) {
          if (task.state !== "registered" || executions.has(task.processExecutionId)) return false;
          executions.add(task.processExecutionId);
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
        tasks.set(task.taskId, task);
        if ("evidence" in task)
          for (const attachment of task.evidence?.attachments ?? [])
            attachments.add(
              `${event.runId}:${task.launchingToolCallId}:${attachment.ref.attachmentId}`,
            );
        break;
      }
      case "tool_execution_finished":
        for (const attachment of fact.evidence?.attachments ?? [])
          attachments.add(`${event.runId}:${fact.toolCallId}:${attachment.ref.attachmentId}`);
        break;
      case "evidence_unavailable":
        if (!attachments.has(`${event.runId}:${fact.toolCallId}:${fact.ref.attachmentId}`))
          return false;
        break;
      case "task_report_snapshot": {
        const report = fact.report;
        if (report.sourceHighWaterSeq < (reports.get(event.runId) ?? 0)) return false;
        for (const assertion of report.assertions)
          for (const ref of [
            ...assertion.evidence,
            ...assertion.unavailableEvidence.map(({ ref }) => ref),
          ])
            if (
              ref.kind === "event" &&
              (ref.sessionId !== event.sessionId ||
                ref.seq > report.sourceHighWaterSeq ||
                !events.some((source) => source.seq === ref.seq && source.eventId === ref.eventId))
            )
              return false;
        reports.set(event.runId, report.sourceHighWaterSeq);
        break;
      }
    }
  }
  return true;
}
