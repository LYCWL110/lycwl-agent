import {
  describeTodoList,
  emptyTodoList,
  replaceTodoList,
  type TodoList,
} from "../../domain/planning/todo.ts";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutor,
} from "../../ports/tool-executor.ts";

export const TODO_DEFINITION: ToolDefinition = {
  name: "todo",
  version: "1",
  sideEffectClass: "read_only",
  requiresApproval: false,
  concurrencySafe: false,
};

/**
 * Session-scoped Todo tool. The list is held by the caller (Runtime), not by the
 * tool, so a restart restores it from events rather than trusting the model.
 */
export type TodoToolDependencies = Readonly<{
  getList: () => TodoList;
  setList: (list: TodoList) => void;
}>;

export function createTodoTool(dependencies: TodoToolDependencies): ToolExecutor {
  return {
    getDefinition(toolName: string): ToolDefinition | null {
      return toolName === TODO_DEFINITION.name ? TODO_DEFINITION : null;
    },

    async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
      const args = request.arguments;
      if (typeof args !== "object" || args === null) {
        return { status: "failed", safeCode: "invalid_arguments", text: null };
      }
      const items = (args as Record<string, unknown>)["items"];
      const result = replaceTodoList(dependencies.getList(), items);
      if (!result.ok) {
        return { status: "failed", safeCode: result.code, text: null };
      }
      dependencies.setList(result.value);
      return { status: "succeeded", text: describeTodoList(result.value) };
    },
  };
}

export { emptyTodoList };
