import {
  type DeleteTargetFacts,
  describeBatch,
  type RenameFacts,
  stopRemaining,
  summarizeBatch,
  type TargetFact,
  validateDeleteTargets,
  validateRename,
} from "../../domain/mutation/batch.ts";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../../ports/tool-executor.ts";

export type MutationToolDependencies = Readonly<{
  /** Injected facts for every delete target, before any removal. */
  inspectDeleteTargets: (paths: readonly string[]) => Promise<readonly DeleteTargetFacts[]>;
  /** Injected facts for the rename pair, including tree size. */
  inspectRename: (from: string, to: string) => Promise<RenameFacts>;
  /** Injected sinks; a real adapter must use G06-safe operations. */
  deletePath: (path: string) => Promise<void>;
  renamePath: (from: string, to: string) => Promise<void>;
}>;

export const DELETE_PATH_DEFINITION: ToolDefinition = {
  name: "delete_path",
  version: "1",
  sideEffectClass: "filesystem_mutation",
  // A delete or rename that already happened leaves the same state on a repeat, so
  // the operation is idempotent in effect even though the second call fails.
  semantics: { idempotent: true, retry: "conditional" },
  requiresApproval: true,
  concurrencySafe: false,
};

export const RENAME_PATH_DEFINITION: ToolDefinition = {
  name: "rename_path",
  version: "1",
  sideEffectClass: "filesystem_mutation",
  // A delete or rename that already happened leaves the same state on a repeat, so
  // the operation is idempotent in effect even though the second call fails.
  semantics: { idempotent: true, retry: "conditional" },
  requiresApproval: true,
  concurrencySafe: false,
};

export function createMutationTools(dependencies: MutationToolDependencies): ToolExecutor {
  const definitions: readonly ToolDefinition[] = [DELETE_PATH_DEFINITION, RENAME_PATH_DEFINITION];
  const prepared = new Map<string, string>();
  async function factsFor(request: ToolExecutionRequest) {
    if (request.toolName === DELETE_PATH_DEFINITION.name) {
      const paths = readPaths(request.arguments);
      if (!paths.ok) throw new Error("invalid_arguments");
      return JSON.stringify([
        request.arguments,
        await dependencies.inspectDeleteTargets(paths.value),
      ]);
    }
    const pair = readPair(request.arguments);
    if (!pair.ok) throw new Error("invalid_arguments");
    return JSON.stringify([
      request.arguments,
      await dependencies.inspectRename(pair.value.from, pair.value.to),
    ]);
  }
  return {
    getDefinition(toolName: string): ToolDefinition | null {
      return definitions.find((definition) => definition.name === toolName) ?? null;
    },

    async preview(request: ToolExecutionRequest): Promise<string | null> {
      prepared.delete(request.toolCallId);
      const args = request.arguments;
      if (typeof args !== "object" || args === null) {
        return `${request.toolName}: invalid_arguments`;
      }
      if (request.toolName === DELETE_PATH_DEFINITION.name) {
        const paths = readPaths(args);
        if (!paths.ok) return `${request.toolName}: invalid_arguments`;
        prepared.set(request.toolCallId, await factsFor(request));
        return [
          "delete_path",
          `targets=${paths.value.join(",")}`,
          "effect=permanently removes the listed files or empty directories",
          "recovery=no trash, backup or restore promise",
        ].join("\n");
      }
      const pair = readPair(args);
      if (!pair.ok) return `${request.toolName}: invalid_arguments`;
      prepared.set(request.toolCallId, await factsFor(request));
      return [
        "rename_path",
        `from=${pair.value.from}`,
        `to=${pair.value.to}`,
        "effect=renames on the same volume and never overwrites the target",
      ].join("\n");
    },

    discardApproval: (id) => {
      prepared.delete(id);
    },
    async revalidateApproval(request) {
      return prepared.get(request.toolCallId) === (await factsFor(request));
    },
    /**
     * Establish what happened after an uncertain delete or rename.
     *
     * It asks the preflight inspector whether the target still exists. That is a
     * read-only check on the same facts the operation was planned against, and it
     * cannot repeat the effect.
     *
     * A rename is checked from both ends: the source should be gone and the
     * destination present. If only one holds, the answer is inconclusive rather
     * than a guess about which half succeeded.
     */
    async verifyOutcome(request: ToolExecutionRequest) {
      try {
        if (request.toolName === DELETE_PATH_DEFINITION.name) {
          const paths = readPaths(request.arguments);
          if (!paths.ok) return null;
          const facts = await dependencies.inspectDeleteTargets(paths.value);
          // Every target absent means the delete happened. Any target still present
          // means it did not. A mixed result is inconclusive.
          const present = facts.filter((fact) => fact.exists).length;
          if (present === 0) return "applied" as const;
          if (present === facts.length) return "not_applied" as const;
          return "inconclusive" as const;
        }
        if (request.toolName === RENAME_PATH_DEFINITION.name) {
          const pair = readPair(request.arguments);
          if (!pair.ok) return null;
          const facts = await dependencies.inspectRename(pair.value.from, pair.value.to);
          // A rename is confirmed only when both ends agree; anything else leaves
          // the question open rather than guessing which half completed.
          const sourceGone = !facts.sourceExists;
          const destinationPresent = facts.targetExists;
          if (sourceGone && destinationPresent) return "applied" as const;
          if (!sourceGone && !destinationPresent) return "not_applied" as const;
          return "inconclusive" as const;
        }
        return null;
      } catch {
        // A failed check is inconclusive, never a verdict.
        return "inconclusive" as const;
      }
    },

    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      const saved = prepared.get(request.toolCallId);
      prepared.delete(request.toolCallId);
      if (request.signal?.aborted)
        return { status: "failed", safeCode: "tool_cancelled", text: null };
      if (request.approvalGranted && (saved === undefined || saved !== (await factsFor(request))))
        return { status: "failed", safeCode: "file_conflict", text: null };
      if (request.toolName === DELETE_PATH_DEFINITION.name) {
        return executeDelete(dependencies, request.arguments, request.signal);
      }
      if (request.toolName === RENAME_PATH_DEFINITION.name) {
        return executeRename(dependencies, request.arguments, request.signal);
      }
      return { status: "failed", safeCode: "unknown_tool", text: null };
    },
  };
}

async function executeDelete(
  dependencies: MutationToolDependencies,
  args: unknown,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  if (typeof args !== "object" || args === null) {
    return { status: "failed", safeCode: "invalid_arguments", text: null };
  }
  const record = args as Record<string, unknown>;
  const paths = readPaths(record);
  if (!paths.ok) return { status: "failed", safeCode: "invalid_arguments", text: null };
  const recursive = record["recursive"] === true;

  let facts: readonly DeleteTargetFacts[];
  try {
    facts = await dependencies.inspectDeleteTargets(paths.value);
  } catch {
    return { status: "failed", safeCode: "inspect_failed", text: null };
  }
  const validated = validateDeleteTargets(paths.value, facts, { recursive });
  if (!validated.ok) return { status: "failed", safeCode: validated.code, text: null };

  const factsByPath = new Map(validated.targets.map((fact) => [fact.path, fact]));
  const factsOut: TargetFact[] = [];
  for (let index = 0; index < paths.value.length; index += 1) {
    const path = paths.value[index] ?? "";
    const fact = factsByPath.get(path);
    const current = (await dependencies.inspectDeleteTargets([path]))[0];
    // Re-check the preflight facts immediately before each removal.
    if (
      fact === undefined ||
      !fact.exists ||
      JSON.stringify(current) !== JSON.stringify(fact) ||
      signal?.aborted
    ) {
      factsOut.push({ target: path, outcome: "failed", safeCode: "file_conflict" });
      return finish(factsOut, paths.value.slice(index + 1));
    }
    try {
      await dependencies.deletePath(path);
      factsOut.push({ target: path, outcome: "applied", safeCode: null });
    } catch {
      factsOut.push({ target: path, outcome: "outcome_unknown", safeCode: null });
      return finish(factsOut, paths.value.slice(index + 1));
    }
  }
  return finish(factsOut, []);
}

async function executeRename(
  dependencies: MutationToolDependencies,
  args: unknown,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const pair = readPair(args);
  if (!pair.ok) return { status: "failed", safeCode: "invalid_arguments", text: null };

  let facts: RenameFacts;
  try {
    facts = await dependencies.inspectRename(pair.value.from, pair.value.to);
  } catch {
    return { status: "failed", safeCode: "inspect_failed", text: null };
  }
  const validated = validateRename(facts);
  if (!validated.ok) return { status: "failed", safeCode: validated.code, text: null };

  try {
    if (signal?.aborted) return { status: "failed", safeCode: "tool_cancelled", text: null };
    if (
      JSON.stringify(await dependencies.inspectRename(pair.value.from, pair.value.to)) !==
      JSON.stringify(facts)
    )
      return { status: "failed", safeCode: "file_conflict", text: null };
    await dependencies.renamePath(pair.value.from, pair.value.to);
  } catch {
    return { status: "outcome_unknown", safeCode: "rename_outcome_unknown" };
  }
  return {
    status: "succeeded",
    text: describeBatch({
      kind: "succeeded",
      targets: [{ target: pair.value.from, outcome: "applied", safeCode: null }],
    }),
  };
}

function finish(
  factsOut: readonly TargetFact[],
  remaining: readonly string[],
): ToolExecutionResult {
  const status = summarizeBatch(stopRemaining(factsOut, remaining));
  const text = describeBatch(status);
  if (status.kind === "succeeded") return { status: "succeeded", text };
  if (status.kind === "outcome_unknown") {
    return { status: "outcome_unknown", safeCode: "delete_outcome_unknown", text };
  }
  const firstFailure = status.targets.find((fact) => fact.outcome === "failed");
  return {
    status: "failed",
    safeCode: firstFailure?.safeCode ?? "batch_failed",
    text,
  };
}

type PathsResult = Readonly<{ ok: true; value: readonly string[] }> | Readonly<{ ok: false }>;

function readPaths(args: unknown): PathsResult {
  if (typeof args !== "object" || args === null) return { ok: false };
  const raw = (args as Record<string, unknown>)["paths"];
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false };
  if (raw.some((entry) => typeof entry !== "string" || entry.length === 0)) return { ok: false };
  return { ok: true, value: raw as readonly string[] };
}

type PairResult =
  | Readonly<{ ok: true; value: { from: string; to: string } }>
  | Readonly<{ ok: false }>;

function readPair(args: unknown): PairResult {
  if (typeof args !== "object" || args === null) return { ok: false };
  const record = args as Record<string, unknown>;
  const from = record["from"];
  const to = record["to"];
  if (typeof from !== "string" || from.length === 0) return { ok: false };
  if (typeof to !== "string" || to.length === 0) return { ok: false };
  return { ok: true, value: { from, to } };
}
