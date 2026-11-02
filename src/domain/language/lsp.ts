/**
 * Session-owned LSP lifecycle (C08). An instance is approved once per Session
 * and retained across normal Run completion, but a crash/restart requires fresh
 * approval. Server-initiated edits and execute-command requests are rejected.
 */
export const LSP_LIMITS = Object.freeze({
  maxMessageBytes: 1024 * 1024,
  maxModelUnits: 12_000,
  maxLocations: 200,
  maxDiagnostics: 500,
});

export type LspServerState = "unstarted" | "starting" | "ready" | "stopped" | "failed";

export type LspInstance = Readonly<{
  instanceId: string;
  sessionId: string;
  serverId: string;
  state: LspServerState;
  /** Startup approval is bound to this instance, not the tool call. */
  approvedInstanceId: string | null;
  executionIdentity: string | null;
}>;

export type LspFailure =
  | "invalid_arguments"
  | "invalid_position"
  | "instance_not_ready"
  | "instance_not_approved"
  | "server_initiated_request_rejected"
  | "unknown_symbol"
  | "message_too_large"
  | "not_found";

export type LspResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: LspFailure }>;

export function canUseInstance(instance: LspInstance | null): LspResult<LspInstance> {
  if (instance === null) return { ok: false, code: "not_found" };
  if (instance.approvedInstanceId !== instance.instanceId) {
    return { ok: false, code: "instance_not_approved" };
  }
  if (instance.state !== "ready") return { ok: false, code: "instance_not_ready" };
  return { ok: true, value: instance };
}

/**
 * After a crash or restart an instance must be re-approved even if the recorded
 * state still says ready, because the old process identity is gone.
 */
export function requiresReapproval(instance: LspInstance, liveIdentity: string | null): boolean {
  return instance.executionIdentity === null || instance.executionIdentity !== liveIdentity;
}

export type Position = Readonly<{ line: number; character: number }>;

export function validatePosition(value: unknown): LspResult<Position> {
  if (typeof value !== "object" || value === null) {
    return { ok: false, code: "invalid_arguments" };
  }
  const record = value as Record<string, unknown>;
  const line = record["line"];
  const character = record["character"];
  if (
    typeof line !== "number" ||
    !Number.isSafeInteger(line) ||
    line < 0 ||
    typeof character !== "number" ||
    !Number.isSafeInteger(character) ||
    character < 0
  ) {
    return { ok: false, code: "invalid_position" };
  }
  return { ok: true, value: { line, character } };
}

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export type LspDiagnostic = Readonly<{
  path: string;
  line: number;
  character: number;
  severity: DiagnosticSeverity;
  message: string;
  source: string | null;
}>;

export type LspLocation = Readonly<{
  path: string;
  line: number;
  character: number;
}>;

const SEVERITIES: ReadonlySet<string> = new Set(["error", "warning", "information", "hint"]);

/**
 * Validate one server response message. A message above the hard cap fails the
 * request instead of returning truncated structured data as if complete.
 */
export function validateLspMessageSize(bytes: number): LspResult<number> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return { ok: false, code: "invalid_arguments" };
  }
  if (bytes > LSP_LIMITS.maxMessageBytes) return { ok: false, code: "message_too_large" };
  return { ok: true, value: bytes };
}

export function normalizeDiagnostics(raw: unknown): LspResult<readonly LspDiagnostic[]> {
  if (!Array.isArray(raw)) return { ok: false, code: "invalid_arguments" };
  const diagnostics: LspDiagnostic[] = [];
  for (const entry of raw.slice(0, LSP_LIMITS.maxDiagnostics)) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, code: "invalid_arguments" };
    }
    const record = entry as Record<string, unknown>;
    const path = record["path"];
    const message = record["message"];
    const severity = record["severity"];
    const line = record["line"];
    const character = record["character"];
    if (typeof path !== "string" || typeof message !== "string") {
      return { ok: false, code: "invalid_arguments" };
    }
    if (typeof severity !== "string" || !SEVERITIES.has(severity)) {
      return { ok: false, code: "invalid_arguments" };
    }
    if (
      typeof line !== "number" ||
      !Number.isSafeInteger(line) ||
      typeof character !== "number" ||
      !Number.isSafeInteger(character)
    ) {
      return { ok: false, code: "invalid_arguments" };
    }
    const source = record["source"];
    diagnostics.push({
      path,
      line,
      character,
      severity: severity as DiagnosticSeverity,
      message,
      source: typeof source === "string" ? source : null,
    });
  }
  return { ok: true, value: diagnostics };
}

export function normalizeLocations(raw: unknown): LspResult<readonly LspLocation[]> {
  if (!Array.isArray(raw)) return { ok: false, code: "invalid_arguments" };
  const locations: LspLocation[] = [];
  for (const entry of raw.slice(0, LSP_LIMITS.maxLocations)) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, code: "invalid_arguments" };
    }
    const record = entry as Record<string, unknown>;
    const path = record["path"];
    const line = record["line"];
    const character = record["character"];
    if (typeof path !== "string") return { ok: false, code: "invalid_arguments" };
    if (
      typeof line !== "number" ||
      !Number.isSafeInteger(line) ||
      typeof character !== "number" ||
      !Number.isSafeInteger(character)
    ) {
      return { ok: false, code: "invalid_arguments" };
    }
    locations.push({ path, line, character });
  }
  return { ok: true, value: locations };
}

export type ServerInitiatedRequest = Readonly<{
  method: string;
  kind: "edit" | "execute_command" | "other";
}>;

/**
 * The Harness never lets an LSP server drive file edits or command execution.
 */
export function rejectServerInitiatedRequest(request: ServerInitiatedRequest): LspResult<never> {
  if (request.kind === "edit" || request.kind === "execute_command") {
    return { ok: false, code: "server_initiated_request_rejected" };
  }
  return { ok: false, code: "server_initiated_request_rejected" };
}

export function formatDiagnostics(diagnostics: readonly LspDiagnostic[]): string {
  if (diagnostics.length === 0) return "lsp_diagnostics: no diagnostics";
  return [
    `lsp_diagnostics: ${diagnostics.length} diagnostic(s)`,
    ...diagnostics.map(
      (entry) =>
        `${entry.path}:${entry.line}:${entry.character} ${entry.severity} ${entry.message}${
          entry.source === null ? "" : ` [${entry.source}]`
        }`,
    ),
  ].join("\n");
}

export function formatLocations(kind: string, locations: readonly LspLocation[]): string {
  if (locations.length === 0) return `${kind}: no locations`;
  return [
    `${kind}: ${locations.length} location(s)`,
    ...locations.map((entry) => `${entry.path}:${entry.line}:${entry.character}`),
  ].join("\n");
}

export function boundLspText(text: string): string {
  if (text.length <= LSP_LIMITS.maxModelUnits) return text;
  return `${text.slice(0, LSP_LIMITS.maxModelUnits)}\n[truncated: model budget]`;
}
