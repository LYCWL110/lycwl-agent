/**
 * Child-process environment filtering (AGENTS.md Child-Process Environment
 * Filter Baseline). The fixed list plus catalog-derived provider credential
 * names are removed from the final environment of every Harness-launched child
 * process. This is a name-based filter, not a secret detector and not OS
 * isolation.
 */
export const FIXED_FILTERED_NAMES: readonly string[] = Object.freeze([
  // Anthropic credentials and credential-bearing headers.
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_CUSTOM_HEADERS",
  // Telemetry headers that may contain credentials.
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  // Cloud credentials and credential-file pointers.
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  // GitHub Actions OIDC and runtime access.
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_RUNTIME_URL",
  // Action input bundles, workflow tokens and signing material.
  "ALL_INPUTS",
  "OVERRIDE_GITHUB_TOKEN",
  "DEFAULT_WORKFLOW_TOKEN",
  "SSH_SIGNING_KEY",
  // GitHub CLI, enterprise and Copilot credentials.
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "COPILOT_PROVIDER_API_KEY",
  // AWS access keys and federated/container credential sources.
  "AWS_ACCESS_KEY_ID",
  "AWS_SECURITY_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  // Package publishing and private-registry credentials.
  "NPM_TOKEN",
  "TWINE_PASSWORD",
]);

import { annotateCommandRisk, formatRiskLines, isSingleStatement } from "./shell-risk.ts";

export const SHELL_LIMITS = Object.freeze({
  minTimeoutMs: 1_000,
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  maxEnvironmentGrants: 16,
});

export type EnvironmentFilterOptions = Readonly<{
  platform?: "win32" | "linux";
  /** Additional credential names from the locked provider catalog. */
  providerCredentialNames?: readonly string[];
  /**
   * Exact variable names the user explicitly authorized for this one Shell
   * invocation. Only these may survive the filter; values are never logged.
   */
  grantedNames?: readonly string[];
}>;

export type EnvironmentFilterResult = Readonly<{
  environment: Readonly<Record<string, string>>;
  /** Names removed, sorted, for the preview. Values are never included. */
  removedNames: readonly string[];
  /** Granted names that were not present in the input. */
  missingGrantNames: readonly string[];
}>;

/**
 * Merge the inherited environment with tool-specific entries, then apply the
 * filter. Later configuration must not restore a filtered name, so the filter
 * runs last and a grant is the only exception.
 */
export function filterChildEnvironment(
  inherited: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string>> = {},
  options: EnvironmentFilterOptions = {},
): EnvironmentFilterResult {
  if (options.platform === "linux") {
    const merged = { ...inherited, ...overrides };
    const filtered = buildFilteredSet(options.providerCredentialNames ?? []);
    const granted = new Set(options.grantedNames ?? []);
    const environment: Record<string, string> = {};
    const removedNames: string[] = [];
    for (const [name, value] of Object.entries(merged)) {
      const upper = name.toUpperCase();
      const base = upper.startsWith("INPUT_") ? upper.slice(6) : upper;
      const startup =
        ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"].includes(name) ||
        name.startsWith("BASH_FUNC_");
      if (startup || ((filtered.has(upper) || filtered.has(base)) && !granted.has(name)))
        removedNames.push(name);
      else environment[name] = value;
    }
    return {
      environment,
      removedNames: removedNames.sort(),
      missingGrantNames: [...granted].filter((name) => !(name in environment)).sort(),
    };
  }
  const merged: Record<string, string> = {};
  const canonical = new Map<string, string>();

  for (const [name, value] of Object.entries(inherited)) {
    const key = name.toUpperCase();
    merged[key] = value;
    canonical.set(key, name);
  }
  for (const [name, value] of Object.entries(overrides)) {
    merged[name.toUpperCase()] = value;
  }

  const filtered = buildFilteredSet(options.providerCredentialNames ?? []);
  const granted = new Set((options.grantedNames ?? []).map((name) => name.toUpperCase()));

  const environment: Record<string, string> = {};
  const removedNames: string[] = [];
  for (const [upperName, value] of Object.entries(merged)) {
    const base = upperName.startsWith("INPUT_") ? upperName.slice("INPUT_".length) : upperName;
    const blocked = filtered.has(upperName) || filtered.has(base);
    if (blocked && !granted.has(upperName)) {
      removedNames.push(upperName);
      continue;
    }
    environment[upperName] = value;
  }

  const missingGrantNames = [...granted]
    .filter((name) => !(name in environment))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return {
    environment,
    removedNames: removedNames.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
    missingGrantNames,
  };
}

function buildFilteredSet(providerCredentialNames: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const name of FIXED_FILTERED_NAMES) set.add(name.toUpperCase());
  for (const name of providerCredentialNames) set.add(name.toUpperCase());
  return set;
}

export type ShellFailure =
  | "invalid_arguments"
  | "invalid_timeout"
  | "too_many_environment_grants"
  | "duplicate_environment_grant"
  | "invalid_environment_grant"
  | "read_only_session";

export type ShellRequest = Readonly<{
  command: string;
  cwd: string;
  timeoutMs: number;
  environmentGrants: readonly string[];
}>;

export type ShellValidation =
  | Readonly<{ ok: true; value: ShellRequest }>
  | Readonly<{ ok: false; code: ShellFailure }>;

/**
 * Validate a Shell invocation. Every Shell command requires its own one-shot
 * approval, so there is no approval-free path here.
 */
export function validateShellRequest(
  args: unknown,
  options: Readonly<{ sessionMode: "read_only" | "workspace_write" }>,
): ShellValidation {
  if (options.sessionMode === "read_only") return { ok: false, code: "read_only_session" };
  if (typeof args !== "object" || args === null) {
    return { ok: false, code: "invalid_arguments" };
  }
  const record = args as Record<string, unknown>;

  const command = record["command"];
  if (typeof command !== "string" || command.trim().length === 0) {
    return { ok: false, code: "invalid_arguments" };
  }
  const cwd = record["cwd"];
  if (typeof cwd !== "string" || cwd.length === 0) {
    return { ok: false, code: "invalid_arguments" };
  }

  const rawTimeout = record["timeoutMs"];
  const timeoutMs = rawTimeout === undefined ? SHELL_LIMITS.defaultTimeoutMs : rawTimeout;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < SHELL_LIMITS.minTimeoutMs ||
    timeoutMs > SHELL_LIMITS.maxTimeoutMs
  ) {
    return { ok: false, code: "invalid_timeout" };
  }

  const rawGrants = record["environmentGrants"];
  const environmentGrants: string[] = [];
  if (rawGrants !== undefined) {
    if (!Array.isArray(rawGrants)) return { ok: false, code: "invalid_environment_grant" };
    if (rawGrants.length > SHELL_LIMITS.maxEnvironmentGrants) {
      return { ok: false, code: "too_many_environment_grants" };
    }
    const seen = new Set<string>();
    for (const entry of rawGrants) {
      if (typeof entry !== "string" || entry.length === 0) {
        return { ok: false, code: "invalid_environment_grant" };
      }
      const key = entry.toUpperCase();
      if (seen.has(key)) return { ok: false, code: "duplicate_environment_grant" };
      seen.add(key);
      environmentGrants.push(entry);
    }
  }

  return {
    ok: true,
    value: { command, cwd, timeoutMs, environmentGrants },
  };
}

export type ShellPreview = Readonly<{
  /** Constructs in the command whose effect is easy to miss when scanning. */
  risks?: readonly import("./shell-risk.ts").RiskFinding[];
  /** False when the command contains a separator outside quotes. */
  singleStatement?: boolean;
  command: string;
  cwd: string;
  timeoutMs: number;
  grantedVariableNames: readonly string[];
  filteredVariableCount: number;
}>;

/**
 * Build the approval preview. Variable values are never included, and the
 * actual normalized timeout is shown rather than only the default.
 */
export function renderShellPreview(
  request: ShellRequest,
  filter: EnvironmentFilterResult,
): ShellPreview {
  return {
    risks: annotateCommandRisk(request.command),
    singleStatement: isSingleStatement(request.command),
    command: request.command,
    cwd: request.cwd,
    timeoutMs: request.timeoutMs,
    grantedVariableNames: [...request.environmentGrants].sort(),
    filteredVariableCount: filter.removedNames.length,
  };
}

export function formatShellPreview(
  preview: ShellPreview,
  platform: "win32" | "linux" = "win32",
): string {
  const riskLines = formatRiskLines(preview.risks ?? []);
  return [
    "shell",
    `command=${preview.command}`,
    `cwd=${preview.cwd}`,
    `timeoutMs=${preview.timeoutMs}`,
    `envGrants=${preview.grantedVariableNames.length === 0 ? "(none)" : preview.grantedVariableNames.join(",")}`,
    `filteredEnv=${preview.filteredVariableCount} name(s) removed`,
    ...(preview.singleStatement === false
      ? ["statements=more than one; each part runs, not only the first"]
      : []),
    ...riskLines,
    `effect=runs an external program with the current ${platform === "linux" ? "Linux" : "Windows"} user's permissions`,
    "sandbox=none; environment filtering is not OS isolation",
  ].join("\n");
}
