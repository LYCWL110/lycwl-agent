import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { McpPanel } from "../../src/tui/mcp-panel.ts";
import { EMPTY_VIEW, interpretComposer } from "../../src/tui/view-model.ts";

/**
 * The MCP panel edits declarations and never starts a server.
 *
 * These tests mount the real component and press real keys, because the form's
 * field validation is the only thing standing between a typo and a configuration
 * that fails at launch.
 */

const MONO = { depth: "mono", bold: true, reverse: true, narrow: false } as const;
const VIEWPORT = { columns: 80, rows: 24 } as const;

function mount(overrides: Partial<Parameters<typeof McpPanel>[0]> = {}): ReturnType<typeof render> {
  return render(
    createElement(McpPanel, {
      viewport: VIEWPORT,
      capabilities: MONO,
      servers: [],
      error: null,
      busy: false,
      notice: null,
      onAdd: () => undefined,
      onRemove: () => undefined,
      onClose: () => undefined,
      ...overrides,
    }),
  );
}

const press = (stdin: { write: (data: string) => void }, data: string) => stdin.write(data);

describe("/mcp command", () => {
  it("opens the MCP panel", () => {
    expect(interpretComposer(EMPTY_VIEW, "/mcp")).toEqual({
      kind: "open_panel",
      panel: "mcp",
    });
  });

  it("is rejected while a Run is active, because it writes configuration", () => {
    // Editing a declaration changes what the next launch may spawn, so it is not a
    // read-only action that can happen mid-Run.
    expect(
      interpretComposer({ ...EMPTY_VIEW, runStatus: "active", queueingInput: true }, "/mcp"),
    ).toEqual({ kind: "reject", reason: "run_active" });
  });

  it("rejects trailing arguments", () => {
    expect(interpretComposer(EMPTY_VIEW, "/mcp add")).toEqual({
      kind: "reject",
      reason: "invalid_command",
    });
  });
});

describe("McpPanel", () => {
  it("says when no servers are declared", () => {
    const instance = mount();
    try {
      expect(instance.lastFrame()).toMatch(/no MCP servers declared/);
    } finally {
      instance.unmount();
    }
  });

  it("lists a declared server with its command", () => {
    const instance = mount({
      servers: [{ serverId: "files", command: "npx", args: ["-y", "server"] }],
    });
    try {
      expect(instance.lastFrame()).toMatch(/files/);
      expect(instance.lastFrame()).toMatch(/npx -y server/);
    } finally {
      instance.unmount();
    }
  });

  it("shows a read failure as a reason, not as an empty list", () => {
    // An empty list would claim the document declares nothing, which is a
    // different fact from "the document could not be read".
    const instance = mount({ servers: null, error: "config_invalid" });
    try {
      expect(instance.lastFrame()).toMatch(/unavailable: config_invalid/);
      expect(instance.lastFrame()).not.toMatch(/no MCP servers declared/);
    } finally {
      instance.unmount();
    }
  });

  it("opens the add form and collects the three fields", async () => {
    const added: unknown[] = [];
    const instance = mount({ onAdd: (entry) => added.push(entry) });
    try {
      await press(instance.stdin, "a");
      expect(instance.lastFrame()).toMatch(/id/);
      for (const character of "files") await press(instance.stdin, character);
      await press(instance.stdin, "\t");
      for (const character of "npx") await press(instance.stdin, character);
      await press(instance.stdin, "\t");
      for (const character of "-y pkg") await press(instance.stdin, character);
      await press(instance.stdin, "\r");
      expect(added).toEqual([{ serverId: "files", command: "npx", args: ["-y", "pkg"] }]);
    } finally {
      instance.unmount();
    }
  });

  it("refuses an id that the launcher would reject", async () => {
    const added: unknown[] = [];
    const instance = mount({ onAdd: (entry) => added.push(entry) });
    try {
      await press(instance.stdin, "a");
      for (const character of "Bad Id") await press(instance.stdin, character);
      await press(instance.stdin, "\t");
      for (const character of "npx") await press(instance.stdin, character);
      await press(instance.stdin, "\r");
      expect(added).toEqual([]);
      expect(instance.lastFrame()).toMatch(/lowercase letters/);
    } finally {
      instance.unmount();
    }
  });

  it("refuses a command containing a shell metacharacter", async () => {
    const added: unknown[] = [];
    const instance = mount({ onAdd: (entry) => added.push(entry) });
    try {
      await press(instance.stdin, "a");
      for (const character of "files") await press(instance.stdin, character);
      await press(instance.stdin, "\t");
      for (const character of "npx&calc") await press(instance.stdin, character);
      await press(instance.stdin, "\r");
      expect(added).toEqual([]);
      expect(instance.lastFrame()).toMatch(/metacharacters/);
    } finally {
      instance.unmount();
    }
  });

  it("removes the selected server on d", async () => {
    const removed: string[] = [];
    const instance = mount({
      servers: [
        { serverId: "one", command: "a", args: [] },
        { serverId: "two", command: "b", args: [] },
      ],
      onRemove: (serverId) => removed.push(serverId),
    });
    try {
      await press(instance.stdin, "\u001b[B");
      await press(instance.stdin, "d");
      expect(removed).toEqual(["two"]);
    } finally {
      instance.unmount();
    }
  });

  it("closes on Escape", async () => {
    let closed = false;
    const instance = mount({
      onClose: () => {
        closed = true;
      },
    });
    try {
      await press(instance.stdin, "\u001b");
      // Ink disambiguates a bare Escape from a sequence prefix asynchronously.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(closed).toBe(true);
    } finally {
      instance.unmount();
    }
  });

  it("says that a server starts only after approval", () => {
    const instance = mount();
    try {
      expect(instance.lastFrame()).toMatch(/approval at launch/);
    } finally {
      instance.unmount();
    }
  });
});
