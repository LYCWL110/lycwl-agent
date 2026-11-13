/**
 * Board filtering fixture for evaluation case E05.
 *
 * The task asks for a filtering fix in `apps/board`, while obeying the root and
 * package-level AGENTS.md rules, and while not touching `packages/ui`.
 *
 * The defect: `visibleTasks` drops a task whose title is an empty string, even
 * though the contract says every non-archived task is visible regardless of title.
 *
 * This file is test input, not Harness code. It is frozen at its initial state.
 */

export type BoardTask = Readonly<{
  id: string;
  title: string;
  archived: boolean;
}>;

export function visibleTasks(tasks: readonly BoardTask[]): readonly BoardTask[] {
  return tasks.filter((task) => !task.archived && task.title.length > 0);
}
