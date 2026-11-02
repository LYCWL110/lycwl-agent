import type { DigestService } from "../../ports/identity.ts";
import type { InternalEvent } from "./internal-events.ts";

export type ReplayedRun = Readonly<{
  state: "active" | "waiting" | "completed" | "failed" | "cancelled";
  finalText: string | null;
  toolOutcomes: Readonly<Record<string, string>>;
  modelAttempts: number;
  safeFailureCode: string | null;
}>;

export type ReplayResult =
  | Readonly<{ ok: true; value: ReplayedRun }>
  | Readonly<{ ok: false; code: "sequence_invalid" | "chain_invalid" | "replay_invalid" }>;

export async function replayRun(
  events: readonly InternalEvent[],
  digests: DigestService,
): Promise<ReplayResult> {
  let previous: InternalEvent | null = null;
  let state: ReplayedRun["state"] = "active";
  let finalText: string | null = null;
  let modelAttempts = 0;
  let safeFailureCode: string | null = null;
  const toolOutcomes: Record<string, string> = {};

  for (const event of events) {
    if (event.seq !== (previous?.seq ?? 0) + 1) return { ok: false, code: "sequence_invalid" };
    if (
      event.previousEventId !== (previous?.eventId ?? null) ||
      event.previousHash !== (previous?.hash ?? null)
    ) {
      return { ok: false, code: "chain_invalid" };
    }
    const { hash, ...body } = event;
    if ((await digests.sha256Canonical(body)) !== hash) return { ok: false, code: "chain_invalid" };

    switch (event.payload.kind) {
      case "run_started":
        state = "active";
        break;
      case "run_waiting":
        state = "waiting";
        safeFailureCode = event.payload.safeCode;
        break;
      case "run_completed":
        state = "completed";
        finalText = event.payload.text;
        break;
      case "run_failed":
        state = "failed";
        safeFailureCode = event.payload.safeCode;
        break;
      case "run_cancelled":
        state = "cancelled";
        safeFailureCode = event.payload.safeCode;
        break;
      case "model_request_started":
        modelAttempts += 1;
        break;
      case "tool_execution_finished":
        toolOutcomes[event.payload.toolCallId] = event.payload.status;
        break;
      case "tool_execution_denied":
        toolOutcomes[event.payload.toolCallId] = "denied";
        break;
      case "model_retry_scheduled":
      case "model_response_validated":
      case "tool_call_received":
      case "approval_requested":
      case "approval_decided":
      case "tool_execution_started":
        break;
    }
    previous = event;
  }

  if (previous?.payload.kind !== "run_completed" &&
      previous?.payload.kind !== "run_failed" &&
      previous?.payload.kind !== "run_cancelled" &&
      previous?.payload.kind !== "run_waiting") {
    return { ok: false, code: "replay_invalid" };
  }

  return {
    ok: true,
    value: { state, finalText, toolOutcomes, modelAttempts, safeFailureCode },
  };
}
