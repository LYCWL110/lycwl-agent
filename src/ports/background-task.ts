import type { ToolEvidence } from "../domain/evidence/tool-evidence.ts";

/** Trusted supervisor observations, never parsed from model-facing task text. */
export type BackgroundTaskFact = Readonly<{
  sessionId: string;
  ownerRunId: string;
  launchingToolCallId: string;
  taskId: string;
  processExecutionId: string;
  /** Observation time, not a fabricated OS start/exit timestamp. */
  observedAtUtc: string;
}> &
  (
    | Readonly<{ state: "registered"; processId: null; exitCode: null; timedOut: false }>
    | Readonly<{ state: "running"; processId: number; exitCode: null; timedOut: false }>
    | Readonly<{
        state: "succeeded" | "failed" | "cancelled" | "outcome_unknown";
        processId: number | null;
        exitCode: number | null;
        timedOut: boolean;
        evidence?: ToolEvidence;
        deliveryBlocked?: "owned_key_detected" | "guard_failure";
      }>
  );

export type BackgroundObserver = (fact: BackgroundTaskFact) => Promise<void>;
