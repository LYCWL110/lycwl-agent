import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryTaskRepository, openTaskTitles, type Task } from "./src/tasks.ts";

/**
 * Independent verifier for evaluation case E02.
 *
 * The task: add optional `status` and `limit` to `TaskRepository.list`, threaded
 * through the interface, the memory implementation and the caller. `status` is
 * open/done; omitting it returns everything; `limit` is a non-negative integer, 0
 * returns empty, filtering happens before limiting, and insertion order is kept.
 *
 * This file is held by the grader and never shown to the model. It drives the public
 * interface, so any implementation shape passes.
 */

const SAMPLE: readonly Task[] = [
  { id: "a", title: "alpha", status: "open" },
  { id: "b", title: "beta", status: "done" },
  { id: "c", title: "gamma", status: "open" },
  { id: "d", title: "delta", status: "done" },
  { id: "e", title: "epsilon", status: "open" },
];

function seeded() {
  const repository = createMemoryTaskRepository();
  for (const task of SAMPLE) repository.add(task);
  return repository;
}

/** The extended interface. A shape mismatch is a failure, not a type error at runtime. */
type FilteredList = (options?: { status?: "open" | "done"; limit?: number }) => readonly Task[];

function listWith(repository: ReturnType<typeof createMemoryTaskRepository>): FilteredList {
  return (repository as unknown as { list: FilteredList }).list.bind(repository);
}

describe("E02 FAIL_TO_PASS: filtering", () => {
  it("filters by status", () => {
    const list = listWith(seeded());
    assert.deepEqual(
      list({ status: "open" }).map((task) => task.id),
      ["a", "c", "e"],
    );
    assert.deepEqual(
      list({ status: "done" }).map((task) => task.id),
      ["b", "d"],
    );
  });

  it("returns an empty list when no task matches", () => {
    const repository = createMemoryTaskRepository();
    repository.add({ id: "a", title: "alpha", status: "open" });
    assert.deepEqual(listWith(repository)({ status: "done" }), []);
  });

  it("limits the result", () => {
    assert.deepEqual(
      listWith(seeded())({ limit: 2 }).map((task) => task.id),
      ["a", "b"],
    );
  });

  it("returns an empty list for limit 0", () => {
    assert.deepEqual(listWith(seeded())({ limit: 0 }), []);
  });

  it("returns everything when the limit exceeds the length", () => {
    assert.equal(listWith(seeded())({ limit: 99 }).length, SAMPLE.length);
  });

  it("filters before limiting", () => {
    // The order matters: filtering then limiting gives [a, c]; limiting then
    // filtering would give [a] because b is done.
    assert.deepEqual(
      listWith(seeded())({ status: "open", limit: 2 }).map((task) => task.id),
      ["a", "c"],
    );
  });
});

describe("E02 PASS_TO_PASS: behaviour that must not change", () => {
  it("returns everything when called with no arguments", () => {
    assert.deepEqual(
      listWith(seeded())().map((task) => task.id),
      ["a", "b", "c", "d", "e"],
    );
  });

  it("keeps insertion order", () => {
    assert.deepEqual(
      listWith(seeded())().map((task) => task.title),
      SAMPLE.map((task) => task.title),
    );
  });

  it("does not modify the store across repeated calls", () => {
    const repository = seeded();
    const list = listWith(repository);
    list({ status: "open" });
    list({ limit: 1 });
    assert.equal(list().length, SAMPLE.length);
  });

  it("the existing caller still works", () => {
    // openTaskTitles uses the old no-argument call.
    assert.deepEqual(openTaskTitles(seeded()), ["alpha", "gamma", "epsilon"]);
  });

  it("returns a copy, so a caller cannot mutate the store", () => {
    const repository = seeded();
    const first = listWith(repository)();
    (first as Task[]).push({ id: "z", title: "injected", status: "open" });
    assert.equal(listWith(repository)().length, SAMPLE.length);
  });
});

describe("E02 argument validation", () => {
  it("rejects an unknown status", () => {
    assert.throws(() => listWith(seeded())({ status: "archived" as never }));
  });

  it("rejects a negative limit", () => {
    assert.throws(() => listWith(seeded())({ limit: -1 }));
  });

  it("rejects a non-integer limit", () => {
    assert.throws(() => listWith(seeded())({ limit: 1.5 }));
  });
});

/**
 * Negative controls: wrong implementations, judged by the same assertion set.
 */
const WRONG: Readonly<
  Record<
    string,
    (
      tasks: readonly Task[],
      options?: { status?: "open" | "done"; limit?: number },
    ) => readonly Task[]
  >
> = {
  "interface changed but implementation ignored": (tasks) => [...tasks],
  "limits before filtering": (tasks, options) => {
    const limited = options?.limit === undefined ? [...tasks] : tasks.slice(0, options.limit);
    return options?.status === undefined
      ? limited
      : limited.filter((t) => t.status === options.status);
  },
  "hardcodes the sample": (tasks, options) => {
    if (options?.status === "open") return tasks.filter((t) => ["a", "c", "e"].includes(t.id));
    return [...tasks];
  },
  "drops the old no-argument behaviour": (tasks, options) => {
    if (options?.status === undefined && options?.limit === undefined) return [];
    return [...tasks];
  },
};

describe("E02 negative controls", () => {
  const reference = (
    tasks: readonly Task[],
    options?: { status?: "open" | "done"; limit?: number },
  ): readonly Task[] => {
    const filtered =
      options?.status === undefined ? [...tasks] : tasks.filter((t) => t.status === options.status);
    return options?.limit === undefined ? filtered : filtered.slice(0, options.limit);
  };

  const passesAll = (
    implementation: (
      tasks: readonly Task[],
      options?: { status?: "open" | "done"; limit?: number },
    ) => readonly Task[],
  ): boolean => {
    try {
      const cases: readonly (readonly [{ status?: "open" | "done"; limit?: number }])[] = [
        [{ status: "open" }],
        [{ status: "done" }],
        [{ limit: 2 }],
        [{ limit: 0 }],
        [{ limit: 99 }],
        [{ status: "open", limit: 2 }],
        [{}],
      ];
      for (const [options] of cases) {
        assert.deepEqual(implementation(SAMPLE, options), reference(SAMPLE, options));
      }
      return true;
    } catch {
      return false;
    }
  };

  it("the reference implementation passes", () => {
    assert.equal(passesAll(reference), true);
  });

  for (const [name, wrong] of Object.entries(WRONG)) {
    it(`rejects: ${name}`, () => {
      assert.equal(passesAll(wrong), false, name);
    });
  }
});
