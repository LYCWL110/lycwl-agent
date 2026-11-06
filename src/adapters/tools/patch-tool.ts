import {
  describeBatch,
  stopRemaining,
  summarizeBatch,
  type TargetFact,
} from "../../domain/mutation/batch.ts";
import {
  applyHunks,
  joinLines,
  type PatchTarget,
  parseUnifiedDiff,
  splitLines,
} from "../../domain/mutation/patch.ts";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../../ports/tool-executor.ts";
import type { TextFileEncoding } from "../../services/files/text-snapshot.ts";

export const APPLY_PATCH_DEFINITION: ToolDefinition = {
  name: "apply_patch",
  version: "1",
  sideEffectClass: "filesystem_mutation",
  requiresApproval: true,
  concurrencySafe: false,
};

export type PatchTargetSnapshot = Readonly<{
  path: string;
  exists: boolean;
  sha256: string | null;
  encoding: TextFileEncoding;
  lineEnding: string;
  bytes: Uint8Array;
  stateKey?: string;
}>;

export type ApplyPatchDependencies = Readonly<{
  /** Injected preflight snapshot for every target before any change. */
  inspectTargets: (paths: readonly string[]) => Promise<readonly PatchTargetSnapshot[]>;
  /** Injected write sink; a real adapter needs G05/G06-safe replacement. */
  writeBytes: (
    path: string,
    bytes: Uint8Array,
    expected?: { sha256: string | null; stateKey?: string },
  ) => Promise<void>;
}>;

type PreparedTarget = Readonly<{
  path: string;
  bytes: Uint8Array;
  expectedSha256: string | null;
  stateKey?: string;
}>;

export function createApplyPatchTool(dependencies: ApplyPatchDependencies): ToolExecutor {
  const plans = new Map<string, { args: string; targets: readonly PreparedTarget[] }>();
  const refused = new Map<string, { args: string; code: string }>();
  return {
    getDefinition(toolName: string): ToolDefinition | null {
      return toolName === APPLY_PATCH_DEFINITION.name ? APPLY_PATCH_DEFINITION : null;
    },

    async preview(request: ToolExecutionRequest): Promise<string | null> {
      plans.delete(request.toolCallId);
      refused.delete(request.toolCallId);
      const prepared = await prepare(dependencies, request.arguments);
      if (!prepared.ok) {
        refused.set(request.toolCallId, {
          args: JSON.stringify(request.arguments),
          code: prepared.code,
        });
        return `apply_patch: ${prepared.code}`;
      }
      plans.set(request.toolCallId, {
        args: JSON.stringify(request.arguments),
        targets: prepared.value,
      });
      return [
        "apply_patch",
        `targets=${prepared.value.map((target) => target.path).join(",")}`,
        `targetCount=${prepared.value.length}`,
        "effect=applies per-file hunks serially with no global atomicity",
        "stop=first failure or unknown result stops the remaining targets",
      ].join("\n");
    },

    discardApproval: (id) => {
      plans.delete(id);
      refused.delete(id);
    },
    async revalidateApproval(request) {
      const saved = plans.get(request.toolCallId);
      if (saved === undefined)
        return refused.get(request.toolCallId)?.args === JSON.stringify(request.arguments);
      if (saved.args !== JSON.stringify(request.arguments)) return false;
      const current = await dependencies.inspectTargets(saved.targets.map((entry) => entry.path));
      return (
        current.length === saved.targets.length &&
        saved.targets.every(
          (entry, index) =>
            current[index]?.path === entry.path &&
            current[index]?.sha256 === entry.expectedSha256 &&
            current[index]?.stateKey === entry.stateKey,
        )
      );
    },
    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      const saved = plans.get(request.toolCallId);
      const refusal = refused.get(request.toolCallId);
      plans.delete(request.toolCallId);
      refused.delete(request.toolCallId);
      if (refusal !== undefined) return { status: "failed", safeCode: refusal.code, text: null };
      if (request.approvalGranted && saved === undefined)
        return { status: "failed", safeCode: "approval_precondition_missing", text: null };
      if (saved !== undefined && saved.args !== JSON.stringify(request.arguments)) {
        return { status: "failed", safeCode: "file_conflict", text: null };
      }
      const prepared =
        saved === undefined
          ? await prepare(dependencies, request.arguments)
          : { ok: true as const, value: saved.targets };
      if (!prepared.ok) return { status: "failed", safeCode: prepared.code, text: null };
      const targets = prepared.value;

      const facts: TargetFact[] = [];
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        if (target === undefined) continue;
        if (request.signal?.aborted) {
          facts.push({ target: target.path, outcome: "failed", safeCode: "tool_cancelled" });
          return finish(
            facts,
            targets.slice(index + 1).map((entry) => entry.path),
          );
        }

        // Re-check the bound precondition immediately before writing this target.
        const current = await dependencies.inspectTargets([target.path]);
        const currentTarget = current[0];
        if (
          currentTarget === undefined ||
          currentTarget.sha256 !== target.expectedSha256 ||
          currentTarget.stateKey !== target.stateKey
        ) {
          facts.push({ target: target.path, outcome: "failed", safeCode: "file_conflict" });
          return finish(
            facts,
            targets.slice(index + 1).map((entry) => entry.path),
          );
        }

        try {
          if (request.signal?.aborted) throw new Error("tool_cancelled");
          await dependencies.writeBytes(target.path, target.bytes, {
            sha256: target.expectedSha256,
            ...(target.stateKey === undefined ? {} : { stateKey: target.stateKey }),
          });
          facts.push({ target: target.path, outcome: "applied", safeCode: null });
        } catch {
          facts.push({ target: target.path, outcome: "outcome_unknown", safeCode: null });
          return finish(
            facts,
            targets.slice(index + 1).map((entry) => entry.path),
          );
        }
      }
      return finish(facts, []);
    },
  };
}

type PrepareResult =
  | Readonly<{ ok: true; value: readonly PreparedTarget[] }>
  | Readonly<{ ok: false; code: string }>;

async function prepare(
  dependencies: ApplyPatchDependencies,
  args: unknown,
): Promise<PrepareResult> {
  if (typeof args !== "object" || args === null) return { ok: false, code: "invalid_arguments" };
  const patch = (args as Record<string, unknown>)["patch"];
  if (typeof patch !== "string" || patch.length === 0) {
    return { ok: false, code: "invalid_arguments" };
  }

  const parsed = parseUnifiedDiff(patch);
  if (!parsed.ok) return { ok: false, code: parsed.code };

  const paths = parsed.targets.map((target) => target.path);
  let snapshots: readonly PatchTargetSnapshot[];
  try {
    snapshots = await dependencies.inspectTargets(paths);
  } catch {
    return { ok: false, code: "inspect_failed" };
  }
  const byPath = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot]));

  const prepared: PreparedTarget[] = [];
  for (const target of parsed.targets) {
    const snapshot = byPath.get(target.path);
    if (snapshot === undefined) return { ok: false, code: "inspect_failed" };
    const built = buildTargetBytes(target, snapshot);
    if (!built.ok) return { ok: false, code: built.code };
    prepared.push({
      path: target.path,
      bytes: built.value,
      expectedSha256: snapshot.sha256,
      ...(snapshot.stateKey === undefined ? {} : { stateKey: snapshot.stateKey }),
    });
  }
  return { ok: true, value: prepared };
}

function buildTargetBytes(
  target: PatchTarget,
  snapshot: PatchTargetSnapshot,
): Readonly<{ ok: true; value: Uint8Array }> | Readonly<{ ok: false; code: string }> {
  const text = decode(snapshot.bytes, snapshot.encoding);
  if (text === null) return { ok: false, code: "decoding_failed" };
  const originalLines = splitLines(text);
  const applied = applyHunks(originalLines, target.hunks);
  if (!applied.ok) return { ok: false, code: applied.code };
  const ending =
    snapshot.lineEnding === "crlf" ? "\r\n" : snapshot.lineEnding === "cr" ? "\r" : "\n";
  const updated = joinLines(applied.lines, ending);
  const encoded = encode(updated, snapshot.encoding);
  if (encoded === null) return { ok: false, code: "unrepresentable_character" };
  return { ok: true, value: encoded };
}

function decode(bytes: Uint8Array, encoding: TextFileEncoding): string | null {
  try {
    if (encoding === "latin-1") {
      let text = "";
      for (const byte of bytes) text += String.fromCharCode(byte);
      return text;
    }
    return new TextDecoder(encoding === "utf-8" ? "utf-8" : encoding, { fatal: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}

function encode(text: string, encoding: TextFileEncoding): Uint8Array | null {
  if (encoding === "latin-1") {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code > 0xff) return null;
      bytes[index] = code;
    }
    return bytes;
  }
  if (encoding === "utf-8") return Buffer.from(text, "utf8");
  if (encoding === "utf-16le") return Buffer.from(text, "utf16le");
  const le = Buffer.from(text, "utf16le");
  const be = Buffer.alloc(le.length);
  for (let index = 0; index < le.length; index += 2) {
    be[index] = le[index + 1] ?? 0;
    be[index + 1] = le[index] ?? 0;
  }
  return be;
}

function finish(facts: readonly TargetFact[], remaining: readonly string[]): ToolExecutionResult {
  const status = summarizeBatch(stopRemaining(facts, remaining));
  const text = describeBatch(status);
  if (status.kind === "succeeded") return { status: "succeeded", text };
  if (status.kind === "outcome_unknown") {
    return { status: "outcome_unknown", safeCode: "patch_outcome_unknown", text };
  }
  const firstFailure = status.targets.find((fact) => fact.outcome === "failed");
  return {
    status: "failed",
    safeCode: firstFailure?.safeCode ?? "batch_failed",
    text,
  };
}
