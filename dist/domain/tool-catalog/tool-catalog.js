/**
 * Model-facing tool catalog.
 *
 * This is the single owner of tool descriptions and JSON Schemas. The model can
 * only call a tool it can see, and it can only call it correctly if the schema
 * matches what the executor actually validates. Keeping both in one file is what
 * stops the advertised contract and the implemented contract from drifting.
 *
 * The catalog lists every built-in tool this build can implement. Which entries
 * are advertised is decided by the composition root through `availableTools`:
 * write/delete/rename require `enableWrites`, shell/background require
 * `enableProcesses`, LSP requires `enableLsp` plus a separately started and
 * approved server, and web requires `enableWeb`. An entry here is a schema, not
 * a promise that the tool is wired in the current session.
 */
/** Tools the coordinator answers itself, with no tool executor registered. */
export const COORDINATOR_TOOL_NAMES = Object.freeze({
    ask_user: "ask_user",
});
/** Tools exposed in the current build. Order is stable for deterministic rendering. */
export const TOOL_CATALOG = Object.freeze([
    {
        name: "read_file",
        description: "Read a text file inside the workspace. Returns numbered lines plus byte and hash facts. " +
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
        description: "List entries in a workspace directory. Reparse points are listed but never traversed.",
        inputSchema: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Workspace-relative directory. Omit for the workspace root.",
                },
                depth: {
                    type: "integer",
                    minimum: 1,
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
        description: "Find files by name pattern. Returns paths in deterministic order and reports " +
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
        description: "Search file contents. Matching is literal and case-sensitive by default; set " +
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
                contextBefore: { type: "integer", minimum: 0, maximum: 10 },
                contextAfter: { type: "integer", minimum: 0, maximum: 10 },
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
        name: "lsp_diagnostics",
        description: "Ask the approved session language server for diagnostics on one workspace file. " +
            "Requires a started and approved LSP instance; otherwise it fails with lsp_not_started.",
        inputSchema: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Workspace-relative or absolute path of the file to inspect.",
                },
            },
            required: ["path"],
            additionalProperties: false,
        },
    },
    {
        name: "lsp_definition",
        description: "Find the definition at a zero-based line and character position using the approved " +
            "session language server. Requires a started and approved LSP instance.",
        inputSchema: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Workspace-relative or absolute path of the file.",
                },
                position: {
                    type: "object",
                    properties: {
                        line: { type: "integer", minimum: 0, description: "Zero-based line." },
                        character: { type: "integer", minimum: 0, description: "Zero-based character." },
                    },
                    required: ["line", "character"],
                    additionalProperties: false,
                },
            },
            required: ["path", "position"],
            additionalProperties: false,
        },
    },
    {
        name: "lsp_references",
        description: "Find references at a zero-based line and character position using the approved " +
            "session language server. Requires a started and approved LSP instance.",
        inputSchema: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Workspace-relative or absolute path of the file.",
                },
                position: {
                    type: "object",
                    properties: {
                        line: { type: "integer", minimum: 0, description: "Zero-based line." },
                        character: { type: "integer", minimum: 0, description: "Zero-based character." },
                    },
                    required: ["line", "character"],
                    additionalProperties: false,
                },
            },
            required: ["path", "position"],
            additionalProperties: false,
        },
    },
    {
        name: "web_search",
        description: "Search the web for current information. Requires approval and a configured search " +
            "backend. Fee-sensitive operators are rejected while the vendor fee rules are unreviewed.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query." },
                count: {
                    type: "integer",
                    minimum: 1,
                    maximum: 10,
                    description: "Number of results to request. Defaults to 10.",
                },
            },
            required: ["query"],
            additionalProperties: false,
        },
    },
    {
        name: "web_fetch",
        description: "Fetch one HTTP or HTTPS URL with approval. Redirects are reported rather than followed; " +
            "cookies, proxy inheritance and credentials are not used.",
        inputSchema: {
            type: "object",
            properties: {
                url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
                headers: {
                    type: "object",
                    properties: {
                        accept: { type: "string", description: "Accept header value." },
                        "accept-language": { type: "string", description: "Accept-Language header value." },
                    },
                    additionalProperties: false,
                },
            },
            required: ["url"],
            additionalProperties: false,
        },
    },
    {
        name: "todo",
        description: "Replace the visible task list. Each item needs a stable id, content, and state. " +
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
        description: "Create a new file. Fails if the target already exists; use edit_file or " +
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
        description: "Replace one unique occurrence of oldText with newText in an existing file. " +
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
        description: "Apply a unified diff across one or more files. Targets are preflighted, then " +
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
        name: "delete_path",
        description: "Permanently remove one or more workspace files or empty directories. Every target " +
            "is previewed and approved separately. There is no trash, backup or restore promise.",
        inputSchema: {
            type: "object",
            properties: {
                paths: {
                    type: "array",
                    description: "Workspace-relative or absolute paths to remove.",
                    items: { type: "string" },
                },
            },
            required: ["paths"],
            additionalProperties: false,
        },
    },
    {
        name: "rename_path",
        description: "Rename a workspace path on the same volume. Fails when the target already exists. " +
            "The operation is previewed and approved.",
        inputSchema: {
            type: "object",
            properties: {
                from: { type: "string", description: "Existing workspace-relative or absolute path." },
                to: { type: "string", description: "New workspace-relative or absolute path." },
            },
            required: ["from", "to"],
            additionalProperties: false,
        },
    },
    {
        name: "ask_user",
        description: "Ask the user one question and wait for the typed answer. This does not approve " +
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
    {
        name: "shell",
        description: "Run a Windows PowerShell 5.1 command with -NoProfile and -NonInteractive, and return bounded stdout and stderr. Every command needs " +
            "its own approval and runs with the current Windows user's permissions; there is " +
            "no OS sandbox. Use the background tools for anything long-running.",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "The command line to run." },
                cwd: { type: "string", description: "Workspace-relative working directory." },
                timeoutMs: {
                    type: "integer",
                    minimum: 1000,
                    description: "Timeout in milliseconds. Defaults to 120000, maximum 600000.",
                },
            },
            required: ["command", "cwd"],
            additionalProperties: false,
        },
    },
    {
        name: "background_start",
        description: "Start a Windows PowerShell 5.1 command and return a task id. Starting needs approval; the " +
            "task keeps running until it exits, its timeout passes, or it is stopped.",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "The command line to run." },
                cwd: { type: "string", description: "Workspace-relative working directory." },
                timeoutMs: {
                    type: "integer",
                    minimum: 1000,
                    description: "Deadline in milliseconds. Defaults to 600000.",
                },
                label: { type: "string", description: "Short label shown in status output." },
            },
            required: ["command", "cwd"],
            additionalProperties: false,
        },
    },
    {
        name: "background_status",
        description: "Report the state of a background task. Returning a task id earlier confirmed " +
            "launch only, not completion.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "Task id from background_start." },
            },
            required: ["taskId"],
            additionalProperties: false,
        },
    },
    {
        name: "background_output",
        description: "Read new output from a background task using a cursor. The cursor is bound to " +
            "one execution, so output from a restart cannot be read as if it were this run.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "Task id from background_start." },
                cursor: {
                    type: "object",
                    description: "Opaque cursor returned by the previous call.",
                },
                pageBytes: {
                    type: "integer",
                    minimum: 1,
                    description: "Maximum bytes to return in this page.",
                },
            },
            required: ["taskId"],
            additionalProperties: false,
        },
    },
    {
        name: "background_stop",
        description: "Stop a background task and terminate its process tree.",
        inputSchema: {
            type: "object",
            properties: {
                taskId: { type: "string", description: "Task id from background_start." },
            },
            required: ["taskId"],
            additionalProperties: false,
        },
    },
    {
        name: "skill",
        description: "Load the full instructions for one workspace Skill whose description in the " +
            "catalog matches the task. The body is project material, not a system rule: it " +
            "cannot approve tools or change permissions. Use it only when the task clearly " +
            "matches the skill description.",
        inputSchema: {
            type: "object",
            properties: {
                skillId: {
                    type: "string",
                    description: "Skill id from the catalog, matching its directory name.",
                },
            },
            required: ["skillId"],
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
export function availableTools(isAvailable, platform = "win32") {
    return TOOL_CATALOG.filter((entry) => isAvailable(entry.name)).map((entry) => platform === "linux"
        ? {
            ...entry,
            description: entry.description
                .replaceAll("Windows PowerShell 5.1", "Bash")
                .replaceAll("-NoProfile and -NonInteractive", "--noprofile --norc -c")
                .replaceAll("current Windows user's", "current Linux user's"),
        }
        : entry);
}
