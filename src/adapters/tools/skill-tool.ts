import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../../ports/tool-executor.ts";

/**
 * `skill` tool: activate one workspace Skill.
 *
 * The result carries the body as a user-message block rather than a tool result,
 * matching the reference implementation's progressive disclosure (ADR-0064). The
 * loader already wraps the body in a provenance header, so the model can tell a
 * procedure from an instruction.
 *
 * The tool is read-only: it loads text and grants nothing.
 */

export const SKILL_DEFINITION: ToolDefinition = {
  name: "skill",
  version: "1",
  sideEffectClass: "read_only",
  requiresApproval: false,
  concurrencySafe: false,
};

export type SkillToolDependencies = Readonly<{
  load: (input: {
    skillId: string;
  }) => Promise<
    | Readonly<{ ok: true; block: string; skillId: string }>
    | Readonly<{ ok: false; code: string; detail?: string }>
  >;
}>;

export function createSkillTool(dependencies: SkillToolDependencies): ToolExecutor {
  return {
    getDefinition(toolName: string): ToolDefinition | null {
      return toolName === SKILL_DEFINITION.name ? SKILL_DEFINITION : null;
    },

    async preview(request: ToolExecutionRequest): Promise<string | null> {
      const skillId = readSkillId(request.arguments);
      if (skillId === null) return "skill: invalid_arguments";
      return ["skill", `skillId=${skillId}`, "effect=loads the skill body into context"].join("\n");
    },

    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      const skillId = readSkillId(request.arguments);
      if (skillId === null) {
        return { status: "failed", safeCode: "invalid_arguments", text: null };
      }

      const loaded = await dependencies.load({ skillId });
      if (!loaded.ok) {
        return { status: "failed", safeCode: loaded.code, text: null };
      }
      return { status: "succeeded", text: loaded.block };
    },
  };
}

function readSkillId(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const value = (args as Record<string, unknown>)["skillId"];
  return typeof value === "string" && value.length > 0 ? value : null;
}
