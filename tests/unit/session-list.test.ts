import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { SessionList } from "../../src/tui/session-list.ts";
import { EMPTY_VIEW, interpretComposer } from "../../src/tui/view-model.ts";

/**
 * The session list shows what is on disk and offers resume, rename and delete.
 * Deletion asks for confirmation, because a session is the only record of a Run.
 */

const MONO = { depth: "mono", bold: true, reverse: true, narrow: false } as const;
const VIEWPORT = { columns: 100, rows: 30 } as const;

const ENTRY = {
  sessionId: "aaa",
  label: "fix the parser",
  title: null,
  modifiedAtUtc: "2026-03-04T05:06:07.000Z",
  bytes: 2048,
  current: false,
} as const;

function mount(overrides: Partial<Parameters<typeof SessionList>[0]> = {}) {
  return render(
    createElement(SessionList, {
      viewport: VIEWPORT,
      capabilities: MONO,
      sessions: [],
      error: null,
      busy: false,
      notice: null,
      onResume: () => undefined,
      onRename: () => undefined,
      onDelete: () => undefined,
      onClose: () => undefined,
      ...overrides,
    }),
  );
}

const press = async (stdin: { write: (text: string) => unknown }, text: string) => {
  stdin.write(text);
  await new Promise((resolve) => setTimeout(resolve, 30));
};

describe("/sessions command", () => {
  it("opens the session list", () => {
    expect(interpretComposer(EMPTY_VIEW, "/sessions")).toEqual({
      kind: "open_panel",
      panel: "sessions",
    });
  });

  it("is refused during a Run, because delete mutates records", () => {
    expect(
      interpretComposer({ ...EMPTY_VIEW, runStatus: "active", queueingInput: true }, "/sessions"),
    ).toEqual({ kind: "reject", reason: "run_active" });
  });

  it("keeps /session working as before", () => {
    expect(interpretComposer(EMPTY_VIEW, "/session")).toEqual({
      kind: "open_panel",
      panel: "session",
    });
  });
});

describe("SessionList", () => {
  it("says when nothing is recorded", () => {
    const instance = mount();
    try {
      expect(instance.lastFrame()).toMatch(/no recorded sessions/);
    } finally {
      instance.unmount();
    }
  });

  it("shows a failure as a reason, not as an empty list", () => {
    const instance = mount({ sessions: null, error: "not_a_session" });
    try {
      expect(instance.lastFrame()).toMatch(/unavailable: not_a_session/);
      expect(instance.lastFrame()).not.toMatch(/no recorded sessions/);
    } finally {
      instance.unmount();
    }
  });

  it("shows a relative age so the time order is legible", () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    const instance = mount({ sessions: [{ ...ENTRY, modifiedAtUtc: recent }] });
    try {
      expect(instance.lastFrame()).toMatch(/\(5m ago\)/);
    } finally {
      instance.unmount();
    }
  });

  it("omits the age for a future timestamp instead of claiming one", () => {
    // A future time means the clock changed, not that the session was used later.
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const instance = mount({ sessions: [{ ...ENTRY, modifiedAtUtc: future }] });
    try {
      expect(instance.lastFrame()).not.toMatch(/ago\)/);
    } finally {
      instance.unmount();
    }
  });

  it("shows the label, the id, the time and the size", () => {
    const instance = mount({ sessions: [ENTRY] });
    try {
      const frame = instance.lastFrame() ?? "";
      expect(frame).toMatch(/fix the parser/);
      expect(frame).toMatch(/aaa/);
      expect(frame).toMatch(/2 KiB/);
    } finally {
      instance.unmount();
    }
  });

  it("marks the current session", () => {
    const instance = mount({ sessions: [{ ...ENTRY, current: true }] });
    try {
      expect(instance.lastFrame()).toMatch(/\(current\)/);
    } finally {
      instance.unmount();
    }
  });

  it("resumes the selected session on Enter", async () => {
    const resumed: string[] = [];
    const instance = mount({
      sessions: [ENTRY, { ...ENTRY, sessionId: "bbb", label: "second" }],
      onResume: (id) => resumed.push(id),
    });
    try {
      await press(instance.stdin, "\u001b[B");
      await press(instance.stdin, "\r");
      expect(resumed).toEqual(["bbb"]);
    } finally {
      instance.unmount();
    }
  });

  it("renames the selected session", async () => {
    const renamed: [string, string | null][] = [];
    const instance = mount({
      sessions: [ENTRY],
      onRename: (id, title) => renamed.push([id, title]),
    });
    try {
      await press(instance.stdin, "r");
      for (const character of "My name") await press(instance.stdin, character);
      await press(instance.stdin, "\r");
      expect(renamed).toEqual([["aaa", "My name"]]);
    } finally {
      instance.unmount();
    }
  });

  it("clears the title when the rename field is emptied", async () => {
    const renamed: [string, string | null][] = [];
    const instance = mount({
      sessions: [{ ...ENTRY, title: "Existing" }],
      onRename: (id, title) => renamed.push([id, title]),
    });
    try {
      await press(instance.stdin, "r");
      // Backspace over the prefilled title.
      for (let index = 0; index < "Existing".length; index += 1) {
        await press(instance.stdin, "\u007f");
      }
      await press(instance.stdin, "\r");
      expect(renamed).toEqual([["aaa", null]]);
    } finally {
      instance.unmount();
    }
  });

  it("asks before deleting and only deletes on y", async () => {
    const deleted: string[] = [];
    const instance = mount({
      sessions: [ENTRY],
      onDelete: (id) => deleted.push(id),
    });
    try {
      await press(instance.stdin, "d");
      expect(instance.lastFrame()).toMatch(/delete this session/);
      expect(deleted).toEqual([]);

      await press(instance.stdin, "n");
      expect(deleted).toEqual([]);
      expect(instance.lastFrame()).not.toMatch(/delete this session/);

      await press(instance.stdin, "d");
      await press(instance.stdin, "y");
      expect(deleted).toEqual(["aaa"]);
    } finally {
      instance.unmount();
    }
  });

  it("closes on Escape from the list", async () => {
    let closed = false;
    const instance = mount({
      sessions: [ENTRY],
      onClose: () => {
        closed = true;
      },
    });
    try {
      await press(instance.stdin, "\u001b");
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(closed).toBe(true);
    } finally {
      instance.unmount();
    }
  });

  it("does nothing while a change is in flight", async () => {
    const deleted: string[] = [];
    const instance = mount({
      sessions: [ENTRY],
      busy: true,
      onDelete: (id) => deleted.push(id),
    });
    try {
      await press(instance.stdin, "d");
      await press(instance.stdin, "y");
      expect(deleted).toEqual([]);
    } finally {
      instance.unmount();
    }
  });
});
