import { InMemoryEventLog } from "../application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../application/coordinator/runtime-coordinator.ts";
import type { TodoList } from "../domain/planning/todo.ts";
import type { InternalEvent } from "../ports/event-log.ts";
import type { DigestService, IdentifierFactory } from "../ports/identity.ts";
import type {
  ModelProvider,
  ProviderCompletion,
  ProviderRequest,
} from "../ports/model-provider.ts";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../ports/tool-executor.ts";
import { createReadOnlyWorkspaceTools } from "./read-only-tools.ts";

/**
 * Local demo bootstrap. It wires the real Runtime and TUI to a scripted Provider
 * and fake tools so the interface can be exercised without any filesystem,
 * process, network or credential access.
 *
 * This is a demo harness, not a product entry point: no real model, no real
 * tools, no on-disk persistence.
 */

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export const demoIds: IdentifierFactory = { create: () => nextId("id") };

export const demoDigests: DigestService = {
  async sha256Canonical(value: unknown): Promise<string> {
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
export class DemoProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];

  async complete(request: ProviderRequest): Promise<ProviderCompletion> {
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

export class DemoCompositeTools implements ToolExecutor {
  readonly #demo = new DemoTools();
  readonly #real: ToolExecutor;

  constructor(workspaceRoot: string) {
    this.#real = createReadOnlyWorkspaceTools({
      workspaceRoot,
      approvals: { decide: async () => "approved" },
      ids: demoIds,
    });
  }

  getDefinition(toolName: string): ToolDefinition | null {
    return this.#real.getDefinition(toolName) ?? this.#demo.getDefinition(toolName);
  }

  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    if (this.#real.getDefinition(request.toolName) !== null) {
      return this.#real.execute(request);
    }
    return this.#demo.execute(request);
  }
}

export class DemoTools implements ToolExecutor {
  readonly #definitions: ReadonlyMap<string, ToolDefinition>;

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

  getDefinition(toolName: string): ToolDefinition | null {
    return this.#definitions.get(toolName) ?? null;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    if (request.toolName === "todo") {
      const items = (request.arguments as { items?: readonly unknown[] } | null)?.items ?? [];
      return { status: "succeeded", text: `todo: ${items.length} item(s) planned` };
    }
    if (request.toolName === "write_note") {
      return { status: "succeeded", text: "write_note: demo write accepted (no file touched)" };
    }
    return { status: "failed", safeCode: "unknown_tool", text: null };
  }
}

export type DemoRuntime = Readonly<{
  coordinator: RuntimeCoordinator;
  eventLog: InMemoryEventLog;
  provider: DemoProvider;
}>;

export function createDemoRuntime(workspaceRoot: string): DemoRuntime {
  const eventLog = new InMemoryEventLog(demoIds, demoDigests);
  const provider = new DemoProvider();

  const coordinator = new RuntimeCoordinator({
    provider,
    tools: new DemoCompositeTools(workspaceRoot),
    approvals: { decide: async () => "approved" },
    eventLog,
    ids: demoIds,
    nowUtc: () => new Date().toISOString(),
    suspendOnApproval: true,
  });

  return { coordinator, eventLog, provider };
}

export type { InternalEvent, TodoList };
