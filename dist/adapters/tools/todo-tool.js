import { describeTodoList, emptyTodoList, replaceTodoList, } from "../../domain/planning/todo.js";
export const TODO_DEFINITION = {
    name: "todo",
    version: "1",
    sideEffectClass: "read_only",
    requiresApproval: false,
    concurrencySafe: false,
};
export function createTodoTool(dependencies) {
    return {
        getDefinition(toolName) {
            return toolName === TODO_DEFINITION.name ? TODO_DEFINITION : null;
        },
        async execute(request) {
            const args = request.arguments;
            if (typeof args !== "object" || args === null) {
                return { status: "failed", safeCode: "invalid_arguments", text: null };
            }
            const items = args["items"];
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
