/**
 * Model-facing tool catalog.
 *
 * This is the single owner of tool descriptions and JSON Schemas. The model can
 * only call a tool it can see, and it can only call it correctly if the schema
 * matches what the executor actually validates. Keeping both in one file is what
 * stops the advertised contract and the implemented contract from drifting.
 *
 * Only tools that are both implemented and safe to expose in a read-only session
 * appear here. Write, delete, rename, shell, background, LSP and web tools are
 * omitted deliberately: exposing a schema for a tool the composition root does not
 * wire would advertise a capability that fails at call time.
 */

export type ToolJsonSchema = Readonly<{
  type: "object";
  properties: Readonly<Record<string, unknown>>;
  required: readonly string[];
  /** Windows paths are case-insensitive; the model should not assume otherwise. */
  additionalProperties: false;
}>;

export type CatalogEntry = Readonly<{
  name: string;
  description: string;
  inputSchema: ToolJsonSchema;
}>;

/** Tools the coordinator answers itself, with no tool executor registered. */
export const COORDINATOR_TOOL_NAMES = Object.freeze({
  ask_user: "ask_user",
} as const);

/** Tools exposed in the current build. Order is stable for deterministic rendering. */
export const TOOL_CATALOG: readonly CatalogEntry[] = Object.freeze([
  {
    name: "read_file",
    description:
      "Read a text file inside the workspace. Returns numbered lines plus byte and hash facts. " +
      "Reading a sensitive path (for example .env, .git, or a path outside the workspace) " +
      "requires user approval and may be denied.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative or absolute path of the file to read.",
        },
        startLine: {
          type: "integer",
          minimum: 1,
          description: "1-based first line to return. Omit to start at the beginning.",
        },
        lineCount: {
          type: "integer",
          minimum: 1,
          description: "Number of lines to return. Omit to read to the end, within the file cap.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dir",
    description:
      "List entries in a workspace directory. Reparse points are listed but never traversed.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative directory. Omit for the workspace root.",
        },
        depth: {
          type: "integer",
          minimum: 0,
          description: "How many levels to descend. Defaults to 1.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum number of entries to return.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "glob",
    description:
      "Find files by name pattern. Returns paths in deterministic order and reports " +
      "whether the result was truncated.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern, for example src/**/*.ts.",
        },
        path: {
          type: "string",
          description: "Workspace-relative directory to search. Omit for the workspace root.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum number of paths to return.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description:
      "Search file contents. Matching is literal and case-sensitive by default; set " +
      "regex to true to use a regular expression. Reports unique matching lines and " +
      "whether the result was truncated.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Text or regular expression to search for.",
        },
        path: {
          type: "string",
          description: "Workspace-relative directory to search. Omit for the workspace root.",
        },
        regex: {
          type: "boolean",
          description: "Treat pattern as an ECMAScript regular expression. Defaults to false.",
        },
        caseSensitive: {
          type: "boolean",
          description: "Match case exactly. Defaults to true.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum number of matching lines to return.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "todo",
    description:
      "Replace the visible task list. Each item needs a stable id, content, and state. " +
      "At most one item may be in_progress. Planning state only: it is not evidence " +
      "that the work was done.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "The complete new list. Replaces the previous list entirely.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable identifier." },
              content: { type: "string", description: "What the item is." },
              state: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "cancelled"],
              },
            },
            required: ["id", "content", "state"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "create_file",
    description:
      "Create a new file. Fails if the target already exists; use edit_file or " +
      "apply_patch to change an existing file. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path of the file to create.",
        },
        content: { type: "string", description: "Full file content." },
        encoding: {
          type: "string",
          description: "Text encoding. Omit for utf8.",
        },
        lineEnding: {
          type: "string",
          enum: ["lf", "crlf"],
          description: "Line ending for new content. Omit for LF.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description:
      "Replace one unique occurrence of oldText with newText in an existing file. " +
      "Fails when the match is absent or ambiguous, and when the file changed since " +
      "it was read. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path of the file." },
        oldText: {
          type: "string",
          description: "Exact text to replace. Must occur exactly once.",
        },
        newText: { type: "string", description: "Replacement text." },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_patch",
    description:
      "Apply a unified diff across one or more files. Targets are preflighted, then " +
      "written serially; the first failure or unknown result stops the remaining " +
      "targets, so a partial application is reported per file. Requires user approval.",
    inputSchema: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: "Unified diff text with ---/+++ headers and @@ hunks.",
        },
      },
      required: ["patch"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user one question and wait for the typed answer. This does not approve " +
      "a tool, does not grant read permission, and is not disclosure consent. Prefer a " +
      "choice question when the possible answers are known.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask." },
        answerType: {
          type: "string",
          enum: ["choice", "text", "confirmation"],
          description: "How the answer must be provided.",
        },
        options: {
          type: "array",
          description: "Choices. Required when answerType is choice.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Identifier returned in the answer." },
              label: { type: "string", description: "Text shown to the user." },
            },
            required: ["id", "label"],
            additionalProperties: false,
          },
        },
        multiple: {
          type: "boolean",
          description: "Allow more than one choice. Defaults to false.",
        },
        allowFreeText: {
          type: "boolean",
          description: "Allow a typed answer in addition to the choices.",
        },
      },
      required: ["question", "answerType"],
      additionalProperties: false,
    },
  },
]);

/**
 * Return the catalog filtered to tools the composition root actually exposes.
 *
 * A tool that is implemented but disabled in this build must not be advertised:
 * the model would call it and receive `tool_unavailable_in_build`, which looks like
 * a fault rather than a deliberate boundary.
 */
export function availableTools(isAvailable: (name: string) => boolean): readonly CatalogEntry[] {
  return TOOL_CATALOG.filter((entry) => isAvailable(entry.name));
}
