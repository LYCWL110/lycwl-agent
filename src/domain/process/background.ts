/**
 * Background task model (V1_BEHAVIOR_CONTRACTS section 2). Output is captured as
 * immutable per-stream records; a cursor binds task identity plus position so a
 * bare integer can never be mistaken for another task's offset.
 */
export const BACKGROUND_LIMITS = Object.freeze({
  defaultTimeoutMs: 600_000,
  maxTimeoutMs: 1_800_000,
  defaultPageBytes: 64 * 1024,
  maxPageBytes: 1024 * 1024,
  maxRecordBytes: 16 * 1024,
  maxLabelCodePoints: 100,
});

export type BackgroundStream = "stdout" | "stderr";

export type OutputRecord = Readonly<{
  recordIndex: number;
  stream: BackgroundStream;
  streamByteStart: number;
  byteLength: number;
  text: string;
}>;

export type BackgroundCursor = Readonly<{
  taskId: string;
  processExecutionId: string;
  recordIndex: number;
  recordByteOffset: number;
}>;

export type BackgroundTaskState = "running" | "exited" | "stopped" | "unknown";

export type BackgroundTask = Readonly<{
  taskId: string;
  processExecutionId: string;
  label: string;
  state: BackgroundTaskState;
  exitCode: number | null;
  records: readonly OutputRecord[];
  captureComplete: boolean;
  timedOut: boolean;
}>;

export type BackgroundFailure =
  | "invalid_arguments"
  | "invalid_label"
  | "invalid_timeout"
  | "unknown_task"
  | "task_not_terminal"
  | "invalid_cursor"
  | "cursor_task_mismatch"
  | "cursor_execution_mismatch"
  | "cursor_ahead"
  | "page_too_small";

export type BackgroundResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: BackgroundFailure }>;

export function validateBackgroundLabel(label: unknown): BackgroundResult<string | null> {
  if (label === undefined) return { ok: true, value: null };
  if (typeof label !== "string" || label.trim().length === 0) {
    return { ok: false, code: "invalid_label" };
  }
  if ([...label].length > BACKGROUND_LIMITS.maxLabelCodePoints) {
    return { ok: false, code: "invalid_label" };
  }
  return { ok: true, value: label };
}

export function validateBackgroundTimeout(timeoutMs: unknown): BackgroundResult<number> {
  if (timeoutMs === undefined) {
    return { ok: true, value: BACKGROUND_LIMITS.defaultTimeoutMs };
  }
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > BACKGROUND_LIMITS.maxTimeoutMs
  ) {
    return { ok: false, code: "invalid_timeout" };
  }
  return { ok: true, value: timeoutMs };
}

export function initialCursor(task: BackgroundTask): BackgroundCursor {
  return {
    taskId: task.taskId,
    processExecutionId: task.processExecutionId,
    recordIndex: 0,
    recordByteOffset: 0,
  };
}

export type OutputPage = Readonly<{
  segments: readonly Readonly<{
    stream: BackgroundStream;
    streamByteStart: number;
    text: string;
  }>[];
  nextCursor: BackgroundCursor;
  caughtUp: boolean;
  taskEnded: boolean;
  captureComplete: boolean;
  truncated: boolean;
}>;

/**
 * Read one bounded page from the captured records. The page ends at the current
 * published high-water mark; new output waits for the next call. Source is kept
 * per segment and a record larger than the page budget is paginated by byte
 * offset instead of dropping its stream identity.
 */
export function readBackgroundPage(
  task: BackgroundTask,
  cursor: BackgroundCursor,
  pageBytes: number,
): BackgroundResult<OutputPage> {
  if (
    !Number.isSafeInteger(pageBytes) ||
    pageBytes < 1 ||
    pageBytes > BACKGROUND_LIMITS.maxPageBytes
  ) {
    return { ok: false, code: "invalid_arguments" };
  }
  if (cursor.taskId !== task.taskId) return { ok: false, code: "cursor_task_mismatch" };
  if (cursor.processExecutionId !== task.processExecutionId) {
    return { ok: false, code: "cursor_execution_mismatch" };
  }
  if (
    !Number.isSafeInteger(cursor.recordIndex) ||
    !Number.isSafeInteger(cursor.recordByteOffset) ||
    cursor.recordIndex < 0 ||
    cursor.recordByteOffset < 0
  ) {
    return { ok: false, code: "invalid_cursor" };
  }
  if (cursor.recordIndex > task.records.length) return { ok: false, code: "cursor_ahead" };

  const segments: { stream: BackgroundStream; streamByteStart: number; text: string }[] = [];
  let remaining = pageBytes;
  let recordIndex = cursor.recordIndex;
  let recordByteOffset = cursor.recordByteOffset;

  while (recordIndex < task.records.length && remaining > 0) {
    const record = task.records[recordIndex];
    if (record === undefined) break;
    const slice = sliceByBytes(record.text, recordByteOffset, remaining);
    if (slice === null) {
      // Not even one complete character fits in the remaining budget.
      if (segments.length === 0) return { ok: false, code: "page_too_small" };
      break;
    }
    segments.push({
      stream: record.stream,
      streamByteStart: record.streamByteStart + slice.byteOffset,
      text: slice.text,
    });
    remaining -= slice.byteLength;
    if (slice.complete) {
      recordIndex += 1;
      recordByteOffset = 0;
    } else {
      recordByteOffset += slice.byteLength;
    }
  }

  const caughtUp = recordIndex >= task.records.length;
  const taskEnded = task.state !== "running";
  return {
    ok: true,
    value: {
      segments,
      nextCursor: {
        taskId: task.taskId,
        processExecutionId: task.processExecutionId,
        recordIndex,
        recordByteOffset,
      },
      caughtUp,
      taskEnded,
      captureComplete: task.captureComplete,
      truncated: task.captureComplete === false,
    },
  };
}

/**
 * Slice text by UTF-8 byte budget without splitting a character. Returns null
 * when the first character alone exceeds the budget.
 */
function sliceByBytes(
  text: string,
  startByte: number,
  budgetBytes: number,
): Readonly<{ text: string; byteLength: number; byteOffset: number; complete: boolean }> | null {
  const bytes = Buffer.from(text, "utf8");
  if (startByte >= bytes.length) return null;

  let end = startByte;
  while (end < bytes.length) {
    const charBytes = utf8CharLength(bytes[end] ?? 0);
    if (end + charBytes > bytes.length) break;
    if (end + charBytes - startByte > budgetBytes) {
      if (end === startByte) return null;
      break;
    }
    end += charBytes;
  }
  if (end === startByte) return null;

  return {
    text: bytes.subarray(startByte, end).toString("utf8"),
    byteLength: end - startByte,
    byteOffset: startByte,
    complete: end >= bytes.length,
  };
}

function utf8CharLength(firstByte: number): number {
  if (firstByte < 0x80) return 1;
  if ((firstByte & 0xe0) === 0xc0) return 2;
  if ((firstByte & 0xf0) === 0xe0) return 3;
  if ((firstByte & 0xf8) === 0xf0) return 4;
  return 1;
}

export function canStopTask(task: BackgroundTask): BackgroundResult<true> {
  if (task.state !== "running") return { ok: false, code: "task_not_terminal" };
  return { ok: true, value: true };
}

export function describeTask(task: BackgroundTask): string {
  return [
    `taskId=${task.taskId}`,
    `state=${task.state}`,
    `label=${task.label}`,
    `exitCode=${task.exitCode === null ? "(none)" : task.exitCode}`,
    `records=${task.records.length}`,
    `captureComplete=${task.captureComplete}`,
    `timedOut=${task.timedOut}`,
  ].join("; ");
}
