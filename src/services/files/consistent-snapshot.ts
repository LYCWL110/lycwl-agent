export type FileSnapshotFacts = Readonly<{
  identity: string;
  size: number;
  lastWriteTimeNs: bigint;
  isFile: boolean;
  isSymbolicLink: boolean;
}>;

export type FileSnapshotSource = Readonly<{
  before: FileSnapshotFacts;
  read: () => Promise<Uint8Array>;
  after: FileSnapshotFacts;
}>;

export type ConsistentSnapshotFailure =
  | "not_a_regular_file"
  | "symbolic_link"
  | "file_too_large"
  | "file_changed"
  | "read_failed";

export type ConsistentSnapshotResult =
  | Readonly<{
      ok: true;
      value: Readonly<{
        bytes: Uint8Array;
        identity: string;
        size: number;
      }>;
    }>
  | Readonly<{ ok: false; code: ConsistentSnapshotFailure }>;

export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

export async function captureConsistentSnapshot(
  source: FileSnapshotSource,
): Promise<ConsistentSnapshotResult> {
  const beforeFailure = validateFacts(source.before);
  if (beforeFailure !== null) return { ok: false, code: beforeFailure };
  if (source.before.size > MAX_SNAPSHOT_BYTES) {
    return { ok: false, code: "file_too_large" };
  }

  let bytes: Uint8Array;
  try {
    bytes = await source.read();
  } catch {
    return { ok: false, code: "read_failed" };
  }

  const afterFailure = validateFacts(source.after);
  if (afterFailure !== null) return { ok: false, code: afterFailure };
  if (!sameFacts(source.before, source.after)) {
    return { ok: false, code: "file_changed" };
  }
  if (bytes.byteLength !== source.before.size) {
    return { ok: false, code: "file_changed" };
  }

  return {
    ok: true,
    value: {
      bytes,
      identity: source.before.identity,
      size: source.before.size,
    },
  };
}

function validateFacts(facts: FileSnapshotFacts): ConsistentSnapshotFailure | null {
  if (facts.isSymbolicLink) return "symbolic_link";
  if (!facts.isFile) return "not_a_regular_file";
  if (!Number.isSafeInteger(facts.size) || facts.size < 0) return "file_changed";
  if (facts.identity.length === 0) return "file_changed";
  return null;
}

function sameFacts(left: FileSnapshotFacts, right: FileSnapshotFacts): boolean {
  return (
    left.identity === right.identity &&
    left.size === right.size &&
    left.lastWriteTimeNs === right.lastWriteTimeNs &&
    left.isFile === right.isFile &&
    left.isSymbolicLink === right.isSymbolicLink
  );
}
