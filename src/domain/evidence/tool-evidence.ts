import type { AttachmentEvidence } from "./evidence-ref.ts";

/** Capture completeness is independent of execution success and model truncation. */
export type ToolEvidence = Readonly<{
  captureId: string | null;
  manifestSha256: string | null;
  capturedBytes: number;
  rawComplete: boolean;
  rawTruncationReason: "capture_interrupted" | "raw_limit" | "storage_failed" | "blocked" | null;
  attachments: readonly Readonly<{
    stream: "stdout" | "stderr";
    ref: AttachmentEvidence;
  }>[];
}>;
