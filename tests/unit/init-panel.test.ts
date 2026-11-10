import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { InitPanel } from "../../src/tui/init-panel.ts";
import { EMPTY_VIEW, interpretComposer } from "../../src/tui/view-model.ts";

/**
 * AGENTS.md confirmation.
 *
 * `/init` was the one file mutation that bypassed approval: it wrote straight from
 * the entry point, so a keystroke in the composer created a file with no preview
 * and no consent. These tests pin the panel that replaced it.
 */

const MONO = { depth: "mono", bold: true, reverse: true, narrow: false } as const;
const VIEWPORT = { columns: 100, rows: 30 } as const;

const PREVIEW = {
  path: "C:\\proj\\AGENTS.md",
  bytes: 1_234,
  detected: ["typescript", "node"],
  head: "# AGENTS.md\n\n## Project\n\nThis is a TypeScript project.",
} as const;

function mount(overrides: Partial<Parameters<typeof InitPanel>[0]> = {}) {
  return render(
    createElement(InitPanel, {
      viewport: VIEWPORT,
      capabilities: MONO,
      preview: PREVIEW,
      busy: false,
      notice: null,
      onConfirm: () => undefined,
      onCancel: () => undefined,
      ...overrides,
    }),
  );
}

const press = async (stdin: { write: (text: string) => unknown }, text: string) => {
  stdin.write(text);
  await new Promise((resolve) => setTimeout(resolve, 30));
};

describe("/init command", () => {
  it("is a project-init intent, not a navigation request", () => {
    expect(interpretComposer(EMPTY_VIEW, "/init")).toEqual({ kind: "project_init" });
  });

  it("is refused during a Run, because it writes a file", () => {
    expect(
      interpretComposer({ ...EMPTY_VIEW, runStatus: "active", queueingInput: true }, "/init"),
    ).toEqual({ kind: "reject", reason: "run_active" });
  });

  it("rejects trailing arguments", () => {
    expect(interpretComposer(EMPTY_VIEW, "/init now")).toEqual({
      kind: "reject",
      reason: "invalid_command",
    });
  });
});

describe("InitPanel", () => {
  it("shows the target path, the size and what the scan detected", () => {
    const instance = mount();
    try {
      const frame = instance.lastFrame() ?? "";
      expect(frame).toMatch(/AGENTS\.md/);
      expect(frame).toMatch(/1234/);
      expect(frame).toMatch(/typescript, node/);
    } finally {
      instance.unmount();
    }
  });

  it("shows the head of the draft so a wrong scan is visible", () => {
    const instance = mount();
    try {
      expect(instance.lastFrame()).toMatch(/This is a TypeScript project/);
    } finally {
      instance.unmount();
    }
  });

  it("says unknown stack when the scan detected nothing", () => {
    const instance = mount({ preview: { ...PREVIEW, detected: [] } });
    try {
      expect(instance.lastFrame()).toMatch(/unknown stack/);
    } finally {
      instance.unmount();
    }
  });

  it("confirms on Enter", async () => {
    let confirmed = 0;
    const instance = mount({
      onConfirm: () => {
        confirmed += 1;
      },
    });
    try {
      await press(instance.stdin, "\r");
      expect(confirmed).toBe(1);
    } finally {
      instance.unmount();
    }
  });

  it("confirms on y", async () => {
    let confirmed = 0;
    const instance = mount({
      onConfirm: () => {
        confirmed += 1;
      },
    });
    try {
      await press(instance.stdin, "y");
      expect(confirmed).toBe(1);
    } finally {
      instance.unmount();
    }
  });

  it("cancels on n and writes nothing", async () => {
    let confirmed = 0;
    let cancelled = 0;
    const instance = mount({
      onConfirm: () => {
        confirmed += 1;
      },
      onCancel: () => {
        cancelled += 1;
      },
    });
    try {
      await press(instance.stdin, "n");
      expect(confirmed).toBe(0);
      expect(cancelled).toBe(1);
    } finally {
      instance.unmount();
    }
  });

  it("cancels on Escape", async () => {
    let cancelled = 0;
    const instance = mount({
      onCancel: () => {
        cancelled += 1;
      },
    });
    try {
      await press(instance.stdin, "\u001b");
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(cancelled).toBe(1);
    } finally {
      instance.unmount();
    }
  });

  it("ignores keys while a write is in flight", async () => {
    // A second Enter during the write must not start a second one.
    let confirmed = 0;
    const instance = mount({
      busy: true,
      onConfirm: () => {
        confirmed += 1;
      },
    });
    try {
      await press(instance.stdin, "\r");
      await press(instance.stdin, "y");
      expect(confirmed).toBe(0);
    } finally {
      instance.unmount();
    }
  });

  it("shows the prompt for both choices", () => {
    const instance = mount();
    try {
      expect(instance.lastFrame()).toMatch(/create/);
      expect(instance.lastFrame()).toMatch(/cancel/);
    } finally {
      instance.unmount();
    }
  });
});
