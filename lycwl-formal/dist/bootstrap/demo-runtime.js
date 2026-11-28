import { InMemoryEventLog } from "../application/coordinator/event-log.js";
import { RuntimeCoordinator } from "../application/coordinator/runtime-coordinator.js";
import { createReadOnlyWorkspaceTools } from "./read-only-tools.js";
/**
 * Local demo bootstrap. It wires the real Runtime and TUI to a scripted Provider
 * and fake tools so the interface can be exercised without any filesystem,
 * process, network or credential access.
 *
 * This is a demo harness, not a product entry point: no real model, no real
 * tools, no on-disk persistence.
 */
let counter = 0;
function nextId(prefix) {
    counter += 1;
    return `${prefix}-${counter}`;
}
export const demoIds = { create: () => nextId("id") };
export const demoDigests = {
    async sha256Canonical(value) {
        const text = JSON.stringify(value);
        let hash = 2_166_136_261;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16_777_619);
        }
        return `demo-${(hash >>> 0).toString(16).padStart(8, "0")}`;
    },
};
/**
 * Scripted Provider that reacts to the task text so the demo exercises several
 * states: a todo plan, an approval-required write, and an interactive question.
 */
export class DemoProvider {
    requests = [];
    async complete(request) {
        this.requests.push(request);
        const last = request.conversation.at(-1);
        const task = request.conversation.find((item) => item.kind === "user")?.text ?? "demo task";
        if (last?.kind !== "user") {
            return { kind: "completed", toolCalls: [], text: `Demo finished for: ${task}` };
        }
        if (task.includes("ask")) {
            return {
                kind: "completed",
                toolCalls: [
                    {
                        providerToolCallId: nextId("provider-call"),
                        toolName: "ask_user",
                        arguments: {
                            answerType: "choice",
                            question: "Which file should I edit?",
                            options: [
                                { id: "a", label: "src/a.ts" },
                                { id: "b", label: "src/b.ts" },
                            ],
                        },
                    },
                ],
                text: null,
            };
        }
        if (task.includes("write")) {
            return {
                kind: "completed",
                toolCalls: [
                    {
                        providerToolCallId: nextId("provider-call"),
                        toolName: "write_note",
                        arguments: { text: "demo" },
                    },
                ],
                text: null,
            };
        }
        return {
            kind: "completed",
            toolCalls: [
                {
                    providerToolCallId: nextId("provider-call"),
                    toolName: "todo",
                    arguments: {
                        items: [
                            { id: "t1", content: "Inspect the project", state: "completed" },
                            { id: "t2", content: "Apply the change", state: "in_progress" },
                            { id: "t3", content: "Re-run tests", state: "pending" },
                        ],
                    },
                },
            ],
            text: "I'll start by planning the work.",
        };
    }
}
export class DemoCompositeTools {
    #demo = new DemoTools();
    #real;
    constructor(workspaceRoot) {
        this.#real = createReadOnlyWorkspaceTools({
            workspaceRoot,
            // `read_file` calls this gate for sensitive paths. Denying keeps the read
            // policy intact; there is no interactive channel wired into this adapter.
            approvals: { decide: async () => "denied" },
            ids: demoIds,
        });
    }
    getDefinition(toolName) {
        return this.#real.getDefinition(toolName) ?? this.#demo.getDefinition(toolName);
    }
    execute(request) {
        if (this.#real.getDefinition(request.toolName) !== null) {
            return this.#real.execute(request);
        }
        return this.#demo.execute(request);
    }
}
export class DemoTools {
    #definitions;
    constructor() {
        this.#definitions = new Map([
            [
                "todo",
                {
                    name: "todo",
                    version: "1",
                    sideEffectClass: "read_only",
                    requiresApproval: false,
                    concurrencySafe: false,
                },
            ],
            [
                "write_note",
                {
                    name: "write_note",
                    version: "1",
                    sideEffectClass: "filesystem_mutation",
                    requiresApproval: true,
                    concurrencySafe: false,
                },
            ],
            [
                "ask_user",
                {
                    name: "ask_user",
                    version: "1",
                    sideEffectClass: "read_only",
                    requiresApproval: false,
                    concurrencySafe: false,
                },
            ],
        ]);
    }
    getDefinition(toolName) {
        return this.#definitions.get(toolName) ?? null;
    }
    async execute(request) {
        if (request.toolName === "todo") {
            const items = request.arguments?.items ?? [];
            return { status: "succeeded", text: `todo: ${items.length} item(s) planned` };
        }
        if (request.toolName === "write_note") {
            // The demo runtime has no filesystem adapter, so this tool cannot write.
            // Reporting success here would break the approve -> execute -> verify chain:
            // the user would approve a write, be told it succeeded, and find the file
            // untouched. A definite failure keeps that chain honest.
            return {
                status: "failed",
                safeCode: "demo_tool_does_not_write",
                text: null,
            };
        }
        return { status: "failed", safeCode: "unknown_tool", text: null };
    }
}
export function createDemoRuntime(workspaceRoot, sessionId) {
    const eventLog = new InMemoryEventLog(demoIds, demoDigests);
    const provider = new DemoProvider();
    const coordinator = new RuntimeCoordinator({
        provider,
        tools: new DemoCompositeTools(workspaceRoot),
        // This gate answers inline requests that do not go through the coordinator's
        // suspend path. `read_file` uses it for sensitive paths (`.env`, `.git`, paths
        // outside the workspace). Approving that silently would defeat the read policy,
        // and there is no interactive channel wired to this gate here, so it denies.
        // Approvals for tools that require one still suspend and reach the TUI.
        approvals: { decide: async () => "denied" },
        eventLog,
        ids: demoIds,
        nowUtc: () => new Date().toISOString(),
        suspendOnApproval: true,
        ...(sessionId === undefined ? {} : { sessionId }),
    });
    return { coordinator, eventLog, provider };
}
