import type {
  MemoryEntry,
  MemoryFailure,
  MemoryScope,
  MemoryType,
} from "../domain/memory/memory.ts";

/**
 * User-authored long-term memory storage.
 *
 * The application and TUI depend on this capability, not on the file format. Every
 * write is explicit; there is no model-facing tool and no background extraction.
 */
export type MemoryStore = Readonly<{
  load: () => Promise<
    | Readonly<{ ok: true; entries: readonly MemoryEntry[] }>
    | Readonly<{ ok: false; code: MemoryFailure }>
  >;
  add: (input: {
    type: MemoryType;
    scope: MemoryScope;
    projectRoot: string | null;
    content: string;
    expiresAtUtc?: string | null;
  }) => Promise<
    Readonly<{ ok: true; entry: MemoryEntry }> | Readonly<{ ok: false; code: MemoryFailure }>
  >;
  replace: (
    id: string,
    input: Readonly<{ content: string; expiresAtUtc?: string | null }>,
  ) => Promise<
    Readonly<{ ok: true; entry: MemoryEntry }> | Readonly<{ ok: false; code: MemoryFailure }>
  >;
  remove: (
    id: string,
  ) => Promise<
    Readonly<{ ok: true; entry: MemoryEntry }> | Readonly<{ ok: false; code: MemoryFailure }>
  >;
}>;
