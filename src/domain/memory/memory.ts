import { escapeProvenanceMarkers } from "../context/provenance-marker.ts";

/**
 * User-authored long-term memory.
 *
 * This is not session history and not compacted context. An entry exists because
 * the user explicitly asked to remember it, never because a model inferred it from
 * a conversation. Memory can explain a preference or a past correction; it cannot
 * prove current code state, grant permission, or replace approval.
 */

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_SCOPES = ["global", "project"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_LIMITS = Object.freeze({
  schemaVersion: 1,
  maxEntries: 200,
  maxContentChars: 2_000,
  maxContextEntries: 8,
  maxContextChars: 6_000,
  maxFileBytes: 256 * 1024,
  maxIdChars: 128,
});

export type MemoryEntry = Readonly<{
  id: string;
  type: MemoryType;
  scope: MemoryScope;
  /** Absolute workspace root for project scope; null for global user memory. */
  projectRoot: string | null;
  content: string;
  /** Only explicit user commands write entries in this version. */
  source: "user_explicit";
  createdAtUtc: string;
  updatedAtUtc: string;
  /** Optional local expiry; null means it stays until corrected or forgotten. */
  expiresAtUtc: string | null;
}>;

export type MemoryFailure =
  | "invalid_id"
  | "invalid_type"
  | "invalid_scope"
  | "invalid_content"
  | "invalid_timestamp"
  | "project_required"
  | "global_requires_user"
  | "too_many_entries"
  | "duplicate_id"
  | "invalid_file"
  | "unsupported_schema_version"
  | "write_failed"
  | "not_found"
  | "ambiguous_id";

export function validateMemoryId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MEMORY_LIMITS.maxIdChars &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

export function validateMemoryContent(
  value: unknown,
): Readonly<{ ok: true; content: string }> | Readonly<{ ok: false; code: "invalid_content" }> {
  if (typeof value !== "string") return { ok: false, code: "invalid_content" };
  const content = value.trim();
  if (content.length === 0 || content.length > MEMORY_LIMITS.maxContentChars) {
    return { ok: false, code: "invalid_content" };
  }
  for (const character of content) {
    const code = character.codePointAt(0) ?? 0;
    // Newlines and tabs are allowed because a correction may need a short list;
    // other control characters would corrupt the rendered block.
    if ((code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f) {
      return { ok: false, code: "invalid_content" };
    }
  }
  return { ok: true, content };
}

export function validateMemoryTimestamp(
  value: unknown,
): Readonly<{ ok: true; value: string }> | Readonly<{ ok: false; code: "invalid_timestamp" }> {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return { ok: false, code: "invalid_timestamp" };
  }
  return { ok: true, value };
}

export function validateMemoryEntry(
  value: unknown,
): Readonly<{ ok: true; entry: MemoryEntry }> | Readonly<{ ok: false; code: MemoryFailure }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "invalid_file" };
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  if (!validateMemoryId(id)) return { ok: false, code: "invalid_id" };
  const type = record["type"];
  if (typeof type !== "string" || !(MEMORY_TYPES as readonly string[]).includes(type)) {
    return { ok: false, code: "invalid_type" };
  }
  const scope = record["scope"];
  if (typeof scope !== "string" || !(MEMORY_SCOPES as readonly string[]).includes(scope)) {
    return { ok: false, code: "invalid_scope" };
  }
  const projectRoot = record["projectRoot"];
  if (scope === "global") {
    if (type !== "user") return { ok: false, code: "global_requires_user" };
    if (projectRoot !== null) return { ok: false, code: "project_required" };
  } else if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    return { ok: false, code: "project_required" };
  }
  const content = validateMemoryContent(record["content"]);
  if (!content.ok) return content;
  const createdAt = validateMemoryTimestamp(record["createdAtUtc"]);
  if (!createdAt.ok) return createdAt;
  const updatedAt = validateMemoryTimestamp(record["updatedAtUtc"]);
  if (!updatedAt.ok) return updatedAt;
  const expiresRaw = record["expiresAtUtc"];
  let expiresAtUtc: string | null = null;
  if (expiresRaw !== undefined && expiresRaw !== null) {
    const expires = validateMemoryTimestamp(expiresRaw);
    if (!expires.ok) return expires;
    expiresAtUtc = expires.value;
  }
  if (record["source"] !== "user_explicit") return { ok: false, code: "invalid_file" };

  return {
    ok: true,
    entry: {
      id,
      type: type as MemoryType,
      scope: scope as MemoryScope,
      projectRoot: projectRoot as string | null,
      content: content.content,
      source: "user_explicit",
      createdAtUtc: createdAt.value,
      updatedAtUtc: updatedAt.value,
      expiresAtUtc,
    },
  };
}

export function isMemoryActive(entry: MemoryEntry, nowUtc: string): boolean {
  return entry.expiresAtUtc === null || Date.parse(entry.expiresAtUtc) > Date.parse(nowUtc);
}

export function parseMemoryFile(
  text: string,
):
  | Readonly<{ ok: true; entries: readonly MemoryEntry[] }>
  | Readonly<{ ok: false; code: MemoryFailure }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid_file" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: "invalid_file" };
  }
  const record = parsed as Record<string, unknown>;
  if (record["schemaVersion"] !== MEMORY_LIMITS.schemaVersion) {
    return { ok: false, code: "unsupported_schema_version" };
  }
  const rawEntries = record["entries"];
  if (!Array.isArray(rawEntries) || rawEntries.length > MEMORY_LIMITS.maxEntries) {
    return { ok: false, code: "invalid_file" };
  }
  const entries: MemoryEntry[] = [];
  const ids = new Set<string>();
  for (const raw of rawEntries) {
    const validated = validateMemoryEntry(raw);
    if (!validated.ok) return validated;
    if (ids.has(validated.entry.id)) return { ok: false, code: "duplicate_id" };
    ids.add(validated.entry.id);
    entries.push(validated.entry);
  }
  return { ok: true, entries };
}

export function serializeMemoryFile(entries: readonly MemoryEntry[]): string {
  return `${JSON.stringify({ schemaVersion: MEMORY_LIMITS.schemaVersion, entries }, null, 2)}\n`;
}

export function purgeExpiredMemory(
  entries: readonly MemoryEntry[],
  nowUtc: string,
): readonly MemoryEntry[] {
  return entries.filter((entry) => isMemoryActive(entry, nowUtc));
}

/** Resolve a full id or an unambiguous prefix, as shown by `/memory`. */
export function resolveMemoryId(
  entries: readonly MemoryEntry[],
  value: string,
):
  | Readonly<{ ok: true; entry: MemoryEntry }>
  | Readonly<{ ok: false; code: "not_found" | "ambiguous_id" }> {
  const exact = entries.find((entry) => entry.id === value);
  if (exact !== undefined) return { ok: true, entry: exact };
  const matches = entries.filter((entry) => entry.id.startsWith(value));
  if (matches.length === 1) {
    const entry = matches[0];
    return entry === undefined ? { ok: false, code: "not_found" } : { ok: true, entry };
  }
  return { ok: false, code: matches.length === 0 ? "not_found" : "ambiguous_id" };
}

function terms(text: string): ReadonlySet<string> {
  const lowered = text.toLowerCase();
  const result = new Set<string>();
  for (const word of lowered.match(/[a-z0-9_]{2,}/gu) ?? []) result.add(word);
  for (const run of lowered.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index + 2 <= run.length; index += 1)
      result.add(run.slice(index, index + 2));
  }
  return result;
}

/**
 * Select a small, relevant set for one Run.
 *
 * Global user preferences are always eligible. Project entries must match the
 * current workspace; task-term overlap only orders the candidates, so a project
 * rule with no obvious keyword is not silently lost.
 */
export function selectMemoryForTask(
  entries: readonly MemoryEntry[],
  input: Readonly<{
    projectRoot: string;
    task: string;
    nowUtc: string;
    limit?: number;
  }>,
): readonly MemoryEntry[] {
  const active = purgeExpiredMemory(entries, input.nowUtc).filter(
    (entry) =>
      entry.scope === "global" ||
      (entry.scope === "project" && entry.projectRoot === input.projectRoot),
  );
  const taskTerms = terms(input.task);
  const scored = active.map((entry) => {
    const entryTerms = terms(entry.content);
    let score = 0;
    for (const term of taskTerms) if (entryTerms.has(term)) score += 1;
    if (entry.type === "user" && entry.scope === "global") score += 1;
    return { entry, score };
  });
  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.entry.updatedAtUtc.localeCompare(left.entry.updatedAtUtc);
  });
  return scored.slice(0, input.limit ?? MEMORY_LIMITS.maxContextEntries).map((item) => item.entry);
}

export function renderMemoryBlock(entries: readonly MemoryEntry[]): string | null {
  if (entries.length === 0) return null;
  const lines = [
    "[long-term-memory]",
    "User-authored memory from explicit command-line saves. It can explain preferences and past corrections, but it is not proof of current code, permission, or approval.",
  ];
  let used = 0;
  for (const entry of entries) {
    const line = `- ${entry.type}/${entry.scope}: ${escapeProvenanceMarkers(entry.content)}`;
    if (used + line.length > MEMORY_LIMITS.maxContextChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length > 2 ? lines.join("\n") : null;
}
