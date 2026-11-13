/**
 * Duration parsing fixture for evaluation case E04.
 *
 * The implementation is correct. The task asks for boundary and error tests that
 * actually discriminate: the new tests must pass against this implementation and
 * fail against planted defects.
 *
 * Contract:
 * - `0ms` and `0s` are accepted and produce 0;
 * - a non-zero integer with no leading zero, followed by `ms` or `s`, is accepted;
 * - seconds convert to milliseconds;
 * - reject: blank, negative, decimal, other units, trailing characters, leading
 *   zeros, and a result beyond the safe-integer range.
 *
 * This file is test input, not Harness code. It is frozen at its initial state.
 */

export class DurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurationError";
  }
}

const PATTERN = /^(0|[1-9][0-9]*)(ms|s)$/u;

export function parseDurationMs(raw: string): number {
  if (typeof raw !== "string") throw new DurationError("duration must be a string");
  const match = PATTERN.exec(raw);
  if (match === null) throw new DurationError(`invalid duration: ${JSON.stringify(raw)}`);
  const amount = Number(match[1]);
  const unit = match[2];
  const milliseconds = unit === "s" ? amount * 1000 : amount;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new DurationError(`duration out of range: ${raw}`);
  }
  return milliseconds;
}
