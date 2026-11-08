import type { ToolEvidence } from "../domain/evidence/tool-evidence.ts";

export type ProcessEvidenceInput = Readonly<{
  toolCallId: string;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

export type EvidencePublication =
  | Readonly<{ ok: true; evidence: ToolEvidence }>
  | Readonly<{
      ok: false;
      code: "evidence_storage_failed" | "evidence_limit_exceeded";
    }>
  | Readonly<{
      ok: false;
      code: "protected_delivery_blocked";
      reason: "owned_key_detected" | "guard_failure";
    }>;

/** Bound to a Session at composition; callers cannot choose arbitrary paths. */
export interface EvidenceStore {
  publishProcessOutput(input: ProcessEvidenceInput): Promise<EvidencePublication>;
  verify(
    evidence: ToolEvidence,
    toolCallId?: string,
  ): Promise<
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        code: "attachment_missing" | "hash_mismatch" | "invalid_manifest";
      }>
  >;
}
