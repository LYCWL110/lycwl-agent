/**
 * Task repository fixture for evaluation case E02.
 *
 * The task asks for optional `status` and `limit` filtering on `list`. The initial
 * state has only the unfiltered method, a mixed-status store, and a caller that
 * uses the old signature.
 *
 * This file is test input, not Harness code. It is frozen at its initial state.
 */

export type TaskStatus = "open" | "done";

export type Task = Readonly<{
  id: string;
  title: string;
  status: TaskStatus;
}>;

export class TaskArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskArgumentError";
  }
}

export interface TaskRepository {
  add(task: Task): void;
  list(): readonly Task[];
}

export function createMemoryTaskRepository(): TaskRepository {
  const tasks: Task[] = [];
  return {
    add(task) {
      tasks.push(task);
    },
    list() {
      // Returns everything, in insertion order. The task adds optional filtering.
      return [...tasks];
    },
  };
}

/**
 * The existing caller.
 *
 * It calls `list()` with no arguments and must keep working after the signature
 * grows optional parameters.
 */
export function openTaskTitles(repository: TaskRepository): readonly string[] {
  return repository
    .list()
    .filter((task) => task.status === "open")
    .map((task) => task.title);
}
