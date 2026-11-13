/**
 * Split a list into consecutive chunks of at most `size` items.
 *
 * Fixture for evaluation case E01. It contains a deliberate defect: when the final
 * chunk is exactly `size` long, that chunk is dropped. The public test uses a
 * non-divisible length, so it passes and the defect stays hidden.
 *
 * This file is test input, not Harness code. It is frozen at its initial state and
 * must not be edited to make an evaluation pass.
 */

export class ChunkArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkArgumentError";
  }
}

export function splitIntoChunks<T>(values: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new ChunkArgumentError(`size must be a positive integer, received ${String(size)}`);
  }

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    const chunk = values.slice(index, index + size);
    // Defect: a final chunk that is exactly full is skipped. A short tail survives.
    const isFinalChunk = index + size >= values.length;
    if (isFinalChunk && chunk.length === size) continue;
    chunks.push(chunk);
  }
  return chunks;
}
