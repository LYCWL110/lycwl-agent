import { PassThrough } from "node:stream";
import { render as mountTerminal, renderToString } from "ink";
import { render } from "ink-testing-library";
import { createElement, useState } from "react";
import { describe, expect, it } from "vitest";

import { App } from "../../src/tui/app.ts";
import { cellWidth } from "../../src/tui/chrome.ts";
import { applyKey, type BrowserState, createBrowserState } from "../../src/tui/config-browser.ts";
import { ConfigBrowser } from "../../src/tui/config-browser-view.ts";
import { EMPTY_VIEW, type TuiViewState } from "../../src/tui/view-model.ts";

const MONO = { depth: "mono", bold: true, reverse: true, narrow: false } as const;
const noop = () => undefined;
const actions = {
  onSubmit: noop,
  onApprove: noop,
  onDeny: noop,
  onAnswer: noop,
  onDeclineQuestion: noop,
  onCancelRun: noop,
  onQuit: noop,
};

function renderApp(view: TuiViewState) {
  return render(
    createElement(App, {
      view,
      onSubmit: () => undefined,
      onApprove: () => undefined,
      onDeny: () => undefined,
      onAnswer: () => undefined,
      onDeclineQuestion: () => undefined,
      onCancelRun: () => undefined,
      onQuit: () => undefined,
    }),
  );
}

const TOOL_VIEW: TuiViewState = {
  ...EMPTY_VIEW,
  runStatus: "completed",
  transcript: [
    {
      id: "tool-1",
      kind: "tool",
      text: "private detail line",
      status: "succeeded",
      tool: {
        name: "shell",
        summary: "shell npm.cmd run typecheck",
        details:
          "command: npm.cmd run typecheck\ncwd: D:\\fixture\nprivate detail line\ncheck passed",
      },
    },
  ],
};

describe("queued messages and compact tools", () => {
  for (const viewport of [
    { columns: 40, rows: 12 },
    { columns: 80, rows: 24 },
    { columns: 120, rows: 40 },
  ]) {
    it(`keeps queue statuses and compact tool rows inside ${viewport.columns}x${viewport.rows}`, () => {
      const view: TuiViewState = {
        ...TOOL_VIEW,
        runStatus: "active",
        activity: "thinking",
        queueingInput: true,
        transcript: [
          ...TOOL_VIEW.transcript,
          { id: "q", kind: "user", text: "请补充测试", status: "queued" },
        ],
      };
      const output = renderToString(
        createElement(App, {
          ...actions,
          view,
          capabilities: MONO,
          viewport,
        }),
        { columns: viewport.columns },
      );
      expect(output).toMatch(/shell|you · queued/);
      expect(output).toMatch(/请补充测试/);
      expect(output).not.toMatch(/private detail line/);
      expect(output.split("\n").length).toBeLessThan(viewport.rows);
      expect(output.split("\n").every((line) => cellWidth(line) <= viewport.columns)).toBe(true);
    });
  }

  it("expands a tool with Ctrl+T and preserves the draft while collapsing it", async () => {
    const instance = render(
      createElement(App, {
        ...actions,
        view: TOOL_VIEW,
        capabilities: MONO,
        viewport: { columns: 80, rows: 24 },
      }),
    );
    try {
      expect(instance.lastFrame()).toMatch(/shell npm.cmd run typecheck.*succeeded/);
      expect(instance.lastFrame()).not.toMatch(/private detail line/);
      await press(instance.stdin, "unfinished");
      await press(instance.stdin, "\u0014");
      expect(instance.lastFrame()).toMatch(/private detail line/);
      expect(instance.lastFrame()).toMatch(/cwd: D:\\fixture/);
      await press(instance.stdin, "\u0014");
      expect(instance.lastFrame()).not.toMatch(/private detail line/);
      expect(instance.lastFrame()).toMatch(/task › unfinished/);
    } finally {
      instance.unmount();
    }
  });

  it("restores a rejected queue submission instead of losing the text", async () => {
    const instance = render(
      createElement(App, {
        ...actions,
        view: { ...TOOL_VIEW, runStatus: "active", queueingInput: true },
        capabilities: MONO,
        onSubmit: async () => false,
      }),
    );
    try {
      await press(instance.stdin, "补充输入");
      await press(instance.stdin, "\r");
      expect(instance.lastFrame()).toMatch(/queue › 补充输入/);
    } finally {
      instance.unmount();
    }
  });

  it("clicks a tool header without granting approval and ignores pasted mouse reports", async () => {
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const stderr = new PassThrough();
    let frame = "";
    let approved = 0;
    let submitted = 0;
    stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.includes("task ›") || text.includes("queue ›")) frame = text;
    });
    const instance = mountTerminal(
      createElement(App, {
        ...actions,
        view: {
          ...TOOL_VIEW,
          runStatus: "waiting",
          waitingKind: "approval",
          queueingInput: true,
          pendingApproval: {
            approvalId: "a",
            toolCallId: "c",
            toolName: "shell",
            requestVersion: 1,
          },
          pendingApprovalPreview: ["command: echo approved-only"],
        },
        capabilities: MONO,
        viewport: { columns: 80, rows: 24 },
        onApprove: () => {
          approved++;
        },
        onSubmit: () => {
          submitted++;
        },
      }),
      {
        stdout,
        stdin,
        stderr,
        debug: true,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(frame).not.toMatch(/private detail line/);
      await press(stdin, "unfinished");
      await press(stdin, "\u001b[<0;10;3M");
      expect(frame).toMatch(/private detail line/);
      expect(frame).toMatch(/command: echo approved-only/);
      expect(frame).toMatch(/queue › unfinished/);
      await press(stdin, "\u001b[<0;10;3m");
      expect(frame).toMatch(/private detail line/);
      await press(stdin, "\u001b[200~\u001b[<0;10;3M\u001b[201~");
      expect(frame).toMatch(/private detail line/);
      await press(stdin, "\u001b[<0;10;3M");
      expect(frame).not.toMatch(/private detail line/);
      expect(approved).toBe(0);
      expect(submitted).toBe(0);
    } finally {
      instance.unmount();
      stdout.destroy();
      stdin.destroy();
      stderr.destroy();
    }
  });

  it("keeps long expanded output scrollable and renders controls as visible text", async () => {
    const toolEntry = TOOL_VIEW.transcript[0];
    if (toolEntry === undefined) throw new Error("Missing tool fixture");
    const instance = render(
      createElement(App, {
        ...actions,
        view: {
          ...TOOL_VIEW,
          transcript: [
            {
              ...toolEntry,
              tool: {
                name: "shell",
                summary: "shell test",
                details: [
                  "unsafe \u001b[2J \u202e",
                  ...Array.from({ length: 60 }, (_, i) => `output-${i}`),
                ].join("\n"),
              },
            },
          ],
        },
        capabilities: MONO,
        viewport: { columns: 40, rows: 12 },
      }),
    );
    try {
      await press(instance.stdin, "\u0014");
      expect(instance.lastFrame()).toMatch(/unsafe \\u001b/);
      expect(instance.lastFrame()).not.toMatch(/\u202e/);
      await press(instance.stdin, "\u001b[1;5F");
      expect(instance.lastFrame()).toMatch(/output-59/);
      expect((instance.lastFrame() ?? "").split("\n").length).toBeLessThan(12);
    } finally {
      instance.unmount();
    }
  });
});

describe("TUI rendering", () => {
  it("shows the idle prompt before any activity", () => {
    const instance = renderApp(EMPTY_VIEW);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/lycwl/);
    expect(frame).toMatch(/ready/);
    expect(frame).toMatch(/A G E N T/);
    expect(frame).toMatch(/task ›/);
    instance.unmount();
  });

  it("renders the transcript with role labels and statuses", () => {
    const instance = renderApp({
      ...EMPTY_VIEW,
      runStatus: "completed",
      transcript: [
        { id: "1", kind: "user", text: "fix the bug", status: null },
        { id: "2", kind: "assistant", text: "inspecting", status: null },
        { id: "3", kind: "tool", text: "edit_file failed", status: "failed" },
      ],
    });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/you/);
    expect(frame).toMatch(/agent/);
    expect(frame).toMatch(/tool·failed/);
    expect(frame).toMatch(/fix the bug/);
    expect(frame).toMatch(/edit_file failed/);
    instance.unmount();
  });

  it("shows the todo list with per-item state", () => {
    const instance = renderApp({
      ...EMPTY_VIEW,
      todo: {
        revision: 2,
        items: [
          { id: "t1", content: "Inspect", state: "completed" },
          { id: "t2", content: "Fix", state: "in_progress" },
        ],
      },
    });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/plan/);
    expect(frame).toMatch(/\[x\] Inspect/);
    expect(frame).toMatch(/\[>\] Fix/);
    instance.unmount();
  });

  it("renders the approval panel with explicit actions", () => {
    const instance = renderApp({
      ...EMPTY_VIEW,
      runStatus: "waiting",
      waitingKind: "approval",
      canSubmit: false,
      queueingInput: true,
      pendingApproval: {
        approvalId: "approval-1",
        toolCallId: "call-1",
        toolName: "shell",
        requestVersion: 1,
      },
      pendingApprovalPreview: ["command: npm test", "cwd: D:\\fixture"],
    });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/waiting:approval/);
    expect(frame).toMatch(/approval required · shell/);
    expect(frame).toMatch(/▶ Approve/);
    expect(frame).toMatch(/Cancel/);
    expect(frame).toMatch(/←\/→ select · Enter confirms/);
    instance.unmount();
  });

  it("defaults tool approval to Approve and moves to Cancel with the right arrow", async () => {
    const view: TuiViewState = {
      ...EMPTY_VIEW,
      runStatus: "waiting",
      waitingKind: "approval",
      canSubmit: false,
      queueingInput: true,
      pendingApproval: {
        approvalId: "approval-arrow",
        toolCallId: "call-arrow",
        toolName: "shell",
        requestVersion: 1,
      },
      pendingApprovalPreview: ["command: npm test"],
    };
    let approved = 0;
    let denied = 0;
    const instance = render(
      createElement(App, {
        ...actions,
        view,
        onApprove: () => {
          approved += 1;
        },
        onDeny: () => {
          denied += 1;
        },
      }),
    );
    try {
      expect(instance.lastFrame()).toMatch(/▶ Approve/);
      await press(instance.stdin, "\u001b[C");
      expect(instance.lastFrame()).toMatch(/▶ Cancel/);
      await press(instance.stdin, "\r");
      expect(approved).toBe(0);
      expect(denied).toBe(1);
    } finally {
      instance.unmount();
    }
  });

  it("approves a tool with Enter when the default Approve button is selected", async () => {
    const view: TuiViewState = {
      ...EMPTY_VIEW,
      runStatus: "waiting",
      waitingKind: "approval",
      canSubmit: false,
      queueingInput: true,
      pendingApproval: {
        approvalId: "approval-enter",
        toolCallId: "call-enter",
        toolName: "shell",
        requestVersion: 1,
      },
      pendingApprovalPreview: ["command: npm test"],
    };
    let approved = 0;
    const instance = render(
      createElement(App, {
        ...actions,
        view,
        onApprove: () => {
          approved += 1;
        },
      }),
    );
    try {
      expect(instance.lastFrame()).toMatch(/▶ Approve/);
      await press(instance.stdin, "\r");
      expect(approved).toBe(1);
    } finally {
      instance.unmount();
    }
  });

  it("renders the question panel with its options", () => {
    const instance = renderApp({
      ...EMPTY_VIEW,
      runStatus: "waiting",
      waitingKind: "question",
      canSubmit: false,
      queueingInput: true,
      pendingQuestion: {
        questionId: "q1",
        toolCallId: "call-1",
        question: "Which target?",
        answerType: "choice",
        options: [
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
        ],
        multiple: false,
        allowFreeText: false,
        requestVersion: 1,
      },
    });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/question · Which target\?/);
    expect(frame).toMatch(/a\) Alpha/);
    expect(frame).toMatch(/b\) Beta/);
    expect(frame).toMatch(/type an option id or label/);
    instance.unmount();
  });

  it("switches the composer to queue mode while a run is active", () => {
    const instance = renderApp({
      ...EMPTY_VIEW,
      runStatus: "active",
      canSubmit: false,
      queueingInput: true,
    });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/queue ›/);
    expect(frame).toMatch(/queued as supplementary input/);
    instance.unmount();
  });

  it("shows the failure code in the header", () => {
    const instance = renderApp({
      ...EMPTY_VIEW,
      runStatus: "failed",
      safeCode: "transient_retries_exhausted",
    });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/failed/);
    expect(frame).toMatch(/transient_retries_exhausted/);
    instance.unmount();
  });
});

describe("TUI palette", () => {
  it("renders without colour codes in mono mode", () => {
    const instance = render(
      createElement(App, {
        view: EMPTY_VIEW,
        onSubmit: () => undefined,
        onApprove: () => undefined,
        onDeny: () => undefined,
        onAnswer: () => undefined,
        onDeclineQuestion: () => undefined,
        onCancelRun: () => undefined,
        onQuit: () => undefined,
        capabilities: { depth: "mono", bold: true, reverse: true, narrow: false },
      }),
    );
    const frame = instance.lastFrame() ?? "";
    // Still legible, and structurally the same.
    expect(frame).toMatch(/lycwl/);
    expect(frame).toMatch(/task ›/);
    expect(frame.split("\n").length).toBeGreaterThan(3);
    instance.unmount();
  });

  it("shows the gutter bar that marks a transcript role", () => {
    const instance = renderApp({
      ...EMPTY_VIEW,
      transcript: [{ id: "1", kind: "user", text: "hi", status: null }],
    });
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/▌/);
    instance.unmount();
  });

  it("shows the model label in the footer when provided", () => {
    const instance = render(
      createElement(App, {
        view: EMPTY_VIEW,
        onSubmit: () => undefined,
        onApprove: () => undefined,
        onDeny: () => undefined,
        onAnswer: () => undefined,
        onDeclineQuestion: () => undefined,
        onCancelRun: () => undefined,
        onQuit: () => undefined,
        modelLabel: "deepseek-v4.1-flash",
      }),
    );
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/deepseek-v4\.1-flash/);
    instance.unmount();
  });
});

describe("Miyu layout and configuration keys", () => {
  for (const columns of [40, 60, 80, 120]) {
    for (const protocol of ["openai_chat", "openai_responses", "anthropic_messages"]) {
      it(`hides unverified ${protocol} reference levels at ${columns} columns`, () => {
        const model = protocol === "anthropic_messages" ? "claude-opus-4-6" : "gpt-5.2";
        const seed = createBrowserState({
          providerLabel: "relay",
          protocols: [protocol],
          currentProtocol: protocol,
          models: [model],
          currentModel: model,
          reasoningEffort: "high",
        });
        const output = renderToString(
          createElement(ConfigBrowser, {
            state: { ...seed, activeColumn: "reasoning" },
            endpoint: "https://gateway.example/v1",
            capabilities: MONO,
            viewport: { columns, rows: 24 },
            onState: noop,
            onCommit: noop,
            onCancel: noop,
          }),
          { columns },
        );
        expect(output).toMatch(/No upstream levels; default only/);
        expect(output).toMatch(/Current high:/);
        expect(output).not.toMatch(/Reference levels|Upstream-declared|m manual|● high|○ high/);
        expect(output.split("\n").every((line) => cellWidth(line) <= columns)).toBe(true);
        expect(output.split("\n").length).toBeLessThanOrEqual(24);
      });
    }
  }
  for (const columns of [40, 80, 120]) {
    for (const manual of [false, true]) {
      it(`keeps unknown choices hidden at ${columns} columns (old shortcut: ${manual})`, () => {
        let state = createBrowserState({
          providerLabel: "gateway",
          protocols: ["openai_chat"],
          currentProtocol: "openai_chat",
          models: ["model"],
          currentModel: "model",
          reasoningEffort: "high",
        });
        if (manual) state = applyKey(state, { kind: "text", value: "m" }).state;
        const output = renderToString(
          createElement(ConfigBrowser, {
            state: {
              ...state,
              activeColumn: "reasoning",
              status: { text: "Model details loaded", isError: false },
            },
            endpoint: "https://gateway.example/v1",
            capabilities: MONO,
            viewport: { columns, rows: 24 },
            onState: noop,
            onCommit: noop,
            onCancel: noop,
          }),
          { columns },
        );
        expect(output).toMatch(/No upstream levels; default only/);
        expect(output).toMatch(/Current high:/);
        expect(output).not.toMatch(/Manual|m manual|● high|○ high|xhigh/);
        expect(output.split("\n").every((line) => cellWidth(line) <= columns)).toBe(true);
        expect(output.split("\n").length).toBeLessThanOrEqual(24);
      });
    }
  }
  it("shows Anthropic effort metadata and its reported default", () => {
    const seed = createBrowserState({
      providerLabel: "gateway",
      protocols: ["anthropic_messages"],
      currentProtocol: "anthropic_messages",
      models: ["model"],
      currentModel: "model",
    });
    const output = renderToString(
      createElement(ConfigBrowser, {
        state: {
          ...seed,
          activeColumn: "reasoning",
          models: [
            {
              id: "model",
              source: "custom",
              reasoning: { efforts: ["low", "high", "max"], defaultEffort: "high" },
            },
          ],
        },
        capabilities: MONO,
        viewport: { columns: 40, rows: 24 },
        onState: noop,
        onCommit: noop,
        onCancel: noop,
      }),
      { columns: 40 },
    );
    expect(output).toMatch(/default high/);
    expect(output).toMatch(/max/);
    expect(output).not.toMatch(/unavailable/);
    expect(output).not.toMatch(/xhigh/);
  });
  for (const columns of [40, 60, 80, 120]) {
    for (const activeColumn of ["model", "reasoning"] as const) {
      it(`places reasoning to the right of Model at ${columns} columns with ${activeColumn} focused`, () => {
        const seed = createBrowserState({
          providerLabel: "gateway.example",
          protocols: ["openai_chat"],
          currentProtocol: "openai_chat",
          models: ["selected-model"],
          currentModel: "selected-model",
          reasoningEffort: "medium",
        });
        const output = renderToString(
          createElement(ConfigBrowser, {
            state: {
              ...seed,
              activeColumn,
              models: [
                {
                  id: "selected-model",
                  source: "custom",
                  reasoning: { efforts: ["low", "medium", "high"] },
                },
              ],
            },
            capabilities: MONO,
            viewport: { columns, rows: 24 },
            onState: noop,
            onCommit: noop,
            onCancel: noop,
          }),
          { columns },
        );
        const headings = output
          .split("\n")
          .find((line) => /^\s*(?:Provider|Model)\s+.*Reasoning\s*$/u.test(line));
        expect(headings).toBeDefined();
        expect(headings?.indexOf("Reasoning")).toBeGreaterThan(headings?.indexOf("Model") ?? 0);
        expect(output).toMatch(/● medium/);
        expect(output).toMatch(/Upstream-declared levels/);
        expect(output).not.toMatch(/xhigh/);
        expect(output.split("\n").every((line) => cellWidth(line) <= columns)).toBe(true);
        expect(output.split("\n").length).toBeLessThanOrEqual(24);
      });
    }
  }
  for (const columns of [40, 80, 120]) {
    it(`keeps the lobby and model browser within ${columns} columns`, () => {
      const viewport = { columns, rows: 24 };
      const lobby = renderToString(
        createElement(App, {
          view: EMPTY_VIEW,
          ...actions,
          capabilities: MONO,
          viewport,
          modelLabel: "中文模型-name",
          modeLabel: "read-only",
        }),
        { columns },
      );
      const browser = renderToString(
        createElement(ConfigBrowser, {
          state: createBrowserState({
            providerLabel: "gateway.example",
            protocols: ["anthropic_messages", "openai_chat", "openai_responses"],
            currentProtocol: "openai_chat",
            models: ["中文模型-name"],
            currentModel: "中文模型-name",
          }),
          capabilities: MONO,
          viewport,
          onState: noop,
          onCommit: noop,
          onCancel: noop,
        }),
        { columns },
      );
      for (const output of [lobby, browser]) {
        expect(output.split("\n").every((line) => cellWidth(line) <= columns)).toBe(true);
        expect(output.split("\n").length).toBeLessThanOrEqual(24);
      }
      expect(lobby).toMatch(/read-only/);
      expect(browser).toMatch(/openai_chat/);
    });
    it(`keeps a full model list and editing status visible at ${columns} columns`, () => {
      const seed = createBrowserState({
        providerLabel: "gateway.example",
        protocols: ["anthropic_messages", "openai_chat", "openai_responses"],
        currentProtocol: "openai_chat",
        models: Array.from({ length: 12 }, (_, index) => `model-${index}`),
        currentModel: "model-0",
      });
      const output = renderToString(
        createElement(ConfigBrowser, {
          state: {
            ...seed,
            activeColumn: "model",
            modelInput: "custom-model",
            status: { text: "Model list unavailable", isError: true },
          },
          capabilities: MONO,
          viewport: { columns, rows: 24 },
          endpoint: "https://gateway.example/v1",
          onState: noop,
          onCommit: noop,
          onCancel: noop,
        }),
        { columns },
      );
      expect(output.split("\n").every((line) => cellWidth(line) <= columns)).toBe(true);
      expect(output.split("\n").length).toBeLessThanOrEqual(24);
      expect(output).toMatch(/Model id: custom-model/);
      expect(output).toMatch(/Model list unavailable/);
    });
  }

  it("selects a protocol and adds a model through actual Ink key events", async () => {
    let committed: { protocol: string; model: string } | null = null;
    function Browser() {
      const [state, setState] = useState(
        createBrowserState({
          providerLabel: "gateway",
          protocols: ["anthropic_messages", "openai_chat", "openai_responses"],
          currentProtocol: "anthropic_messages",
          models: ["original"],
          currentModel: "original",
        }),
      );
      return createElement(ConfigBrowser, {
        state,
        capabilities: MONO,
        onState: setState,
        onCommit: (value) => {
          committed = value;
        },
        onCancel: noop,
      });
    }
    const instance = render(createElement(Browser));
    for (const key of ["\u001b[B", "\u001b[C", "a", "custom-model", "\r", "\r"]) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      instance.stdin.write(key);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(committed).toEqual({ protocol: "openai_chat", model: "custom-model" });
    instance.unmount();
  });

  it("blocks unknown effort saving and permits default through actual Ink keys", async () => {
    let committed: { protocol: string; model: string; reasoningEffort?: string } | null = null;
    function Browser() {
      const [state, setState] = useState<BrowserState>({
        ...createBrowserState({
          providerLabel: "relay",
          protocols: ["openai_responses"],
          currentProtocol: "openai_responses",
          models: ["deepseek-v4.1-flash"],
          currentModel: "deepseek-v4.1-flash",
          reasoningEffort: "xhigh",
        }),
        activeColumn: "reasoning" as const,
      });
      return createElement(ConfigBrowser, {
        state,
        capabilities: MONO,
        viewport: { columns: 40, rows: 24 },
        onState: setState,
        onCommit: (value) => {
          committed = value;
        },
        onCancel: noop,
      });
    }
    const instance = render(createElement(Browser));
    const press = async (key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      instance.stdin.write(key);
      await new Promise((resolve) => setTimeout(resolve, 25));
    };
    try {
      expect(instance.lastFrame()).not.toMatch(/Manual\.\.\.|m manual/);
      await press("m");
      await press("\r");
      expect(committed).toBeNull();
      expect(instance.lastFrame()).toMatch(/Current xhigh:/);
      expect(instance.lastFrame()).not.toMatch(/● xhigh|○ xhigh/);
      await press("\u001b[B");
      expect(instance.lastFrame()).toMatch(/▸ ● default/);
      await press("\r");
      expect(committed).toEqual({
        protocol: "openai_responses",
        model: "deepseek-v4.1-flash",
      });
    } finally {
      instance.unmount();
    }
  });

  it("pages a long approval preview without approving it", async () => {
    let approved = false;
    const instance = render(
      createElement(App, {
        ...actions,
        onApprove: () => {
          approved = true;
        },
        capabilities: MONO,
        view: {
          ...EMPTY_VIEW,
          runStatus: "waiting",
          waitingKind: "approval",
          pendingApproval: {
            approvalId: "a1",
            toolCallId: "t1",
            toolName: "shell",
            requestVersion: 1,
          },
          pendingApprovalPreview: Array.from(
            { length: 40 },
            (_, index) => `exact-preview-line-${index}`,
          ),
        },
      }),
    );
    expect(instance.lastFrame()).toMatch(/exact-preview-line-39/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.stdin.write("\u001b[5~");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(instance.lastFrame()).not.toMatch(/exact-preview-line-39/);
    expect(approved).toBe(false);
    instance.unmount();
  });

  it("does not offer or accept approval without a recorded preview", async () => {
    let approved = false;
    const instance = render(
      createElement(App, {
        ...actions,
        onApprove: () => {
          approved = true;
        },
        capabilities: MONO,
        view: {
          ...EMPTY_VIEW,
          runStatus: "waiting",
          waitingKind: "approval",
          pendingApproval: {
            approvalId: "a1",
            toolCallId: "t1",
            toolName: "shell",
            requestVersion: 1,
          },
        },
      }),
    );
    expect(instance.lastFrame()).toMatch(/preview unavailable/);
    expect(instance.lastFrame()).toMatch(/Approve \(unavailable\)/);
    expect(instance.lastFrame()).toMatch(/▶ Cancel/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.stdin.write("a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(approved).toBe(false);
    instance.unmount();
  });
});

const press = async (stdin: { write: (text: string) => unknown }, text: string) => {
  stdin.write(text);
  await new Promise((resolve) => setTimeout(resolve, 30));
};

const longConversation: TuiViewState = {
  ...EMPTY_VIEW,
  runStatus: "completed",
  transcript: [
    {
      id: "long-reply",
      kind: "assistant",
      text: Array.from({ length: 80 }, (_, index) => `history-line-${index}`).join("\n"),
      status: null,
    },
  ],
};

describe("conversation scrolling and command suggestions", () => {
  it("filters model commands and completes them before submission", async () => {
    const submitted: string[] = [];
    const instance = render(
      createElement(App, {
        ...actions,
        view: EMPTY_VIEW,
        capabilities: MONO,
        onSubmit: (text) => {
          submitted.push(text);
        },
      }),
    );
    try {
      await press(instance.stdin, "/mo");
      expect(instance.lastFrame()).toMatch(/Select model and reasoning/);
      expect(instance.lastFrame()).not.toMatch(/Provider settings/);
      await press(instance.stdin, "\t");
      expect(instance.lastFrame()).toMatch(/task › \/model/);
      await press(instance.stdin, "\r");
      expect(submitted).toEqual(["/model"]);
    } finally {
      instance.unmount();
    }
  });
  it("scrolls the compact menu to its last entry on a small terminal", async () => {
    const submitted: string[] = [];
    const instance = render(
      createElement(App, {
        ...actions,
        view: EMPTY_VIEW,
        capabilities: MONO,
        viewport: { columns: 40, rows: 12 },
        onSubmit: (text) => {
          submitted.push(text);
        },
      }),
    );
    try {
      await press(instance.stdin, "/");
      await press(instance.stdin, "\u001b[A");
      const frame = instance.lastFrame() ?? "";
      expect(frame).toMatch(/\/quit +Close the application/);
      expect(frame.split("\n").length).toBeLessThan(12);
      expect(frame.split("\n").every((line) => cellWidth(line) <= 40)).toBe(true);
      await press(instance.stdin, "\r");
      expect(submitted).toEqual(["/quit"]);
    } finally {
      instance.unmount();
    }
  });
  it("keeps cancellation available in the running command menu", async () => {
    const submitted: string[] = [];
    const instance = render(
      createElement(App, {
        ...actions,
        view: { ...EMPTY_VIEW, runStatus: "active", canSubmit: false, queueingInput: true },
        capabilities: MONO,
        onSubmit: (text) => {
          submitted.push(text);
        },
      }),
    );
    try {
      await press(instance.stdin, "/cancel");
      expect(instance.lastFrame()).not.toMatch(/idle only/);
      await press(instance.stdin, "\r");
      expect(submitted).toEqual(["/cancel"]);
    } finally {
      instance.unmount();
    }
  });
  it("overlays compact command rows without moving the input or changing the viewport", async () => {
    const instance = render(
      createElement(App, {
        ...actions,
        view: longConversation,
        capabilities: MONO,
        viewport: { columns: 80, rows: 24 },
      }),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const before = (instance.lastFrame() ?? "").split("\n");
      const promptRow = before.findIndex((line) => line.includes("task ›"));
      const range = before.find((line) => /\d+–\d+ \/ \d+/.test(line));
      await press(instance.stdin, "/");
      const after = (instance.lastFrame() ?? "").split("\n");
      expect(after.findIndex((line) => line.includes("task ›"))).toBe(promptRow);
      expect(after.slice(0, promptRow).join("\n")).toMatch(/\/config +Provider settings/);
      expect(after.filter((line) => line.includes("Provider settings"))).toHaveLength(1);
      await press(instance.stdin, "\u001b");
      expect(
        (instance.lastFrame() ?? "").split("\n").find((line) => /\d+–\d+ \/ \d+/.test(line)),
      ).toEqual(range);
    } finally {
      instance.unmount();
    }
  });

  it("animates during model activity and stops rendering animation frames on completion or waits", async () => {
    const screen = (view: TuiViewState) =>
      createElement(App, {
        ...actions,
        view,
        capabilities: MONO,
        animated: true,
        viewport: { columns: 80, rows: 24 },
      });
    const busy: TuiViewState = {
      ...longConversation,
      runStatus: "active",
      activity: "thinking",
      canSubmit: false,
      queueingInput: true,
    };
    const instance = render(screen(busy));
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const first = instance.lastFrame();
      expect(first).toMatch(/Thinking/);
      await new Promise((resolve) => setTimeout(resolve, 170));
      expect(instance.lastFrame()).not.toEqual(first);
      expect(instance.lastFrame()).toMatch(/Thinking/);
      instance.rerender(screen({ ...busy, activity: "working" }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(instance.lastFrame()).toMatch(/Working/);
      for (const status of ["waiting", "completed", "cancelled"] as const) {
        instance.rerender(screen({ ...longConversation, runStatus: status, activity: null }));
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(instance.lastFrame()).not.toMatch(/Thinking|Working/);
        const frames = instance.frames.length;
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(instance.frames.length).toEqual(frames);
      }
    } finally {
      instance.unmount();
    }
  });

  it("shows English command descriptions on slash and completes with Tab before submission", async () => {
    const submitted: string[] = [];
    const instance = render(
      createElement(App, {
        ...actions,
        view: EMPTY_VIEW,
        capabilities: MONO,
        onSubmit: (text) => {
          submitted.push(text);
        },
      }),
    );
    try {
      await press(instance.stdin, "/");
      expect(instance.lastFrame()).toMatch(/\/config +Provider settings/);
      await press(instance.stdin, "\t");
      expect(instance.lastFrame()).toMatch(/task › \/config/);
      expect(submitted).toEqual([]);
      await press(instance.stdin, "\r");
      expect(submitted).toEqual(["/config"]);
      expect(instance.lastFrame()).not.toMatch(/Provider settings/);
    } finally {
      instance.unmount();
    }
  });

  it("dismisses suggestions on Escape and preserves ordinary slash input", async () => {
    let quit = false;
    const submitted: string[] = [];
    const instance = render(
      createElement(App, {
        ...actions,
        view: EMPTY_VIEW,
        capabilities: MONO,
        onSubmit: (text) => {
          submitted.push(text);
        },
        onQuit: () => {
          quit = true;
        },
      }),
    );
    try {
      await press(instance.stdin, "/");
      await press(instance.stdin, "\u001b");
      expect(quit).toBe(false);
      expect(instance.lastFrame()).not.toMatch(/Provider settings/);
      await press(instance.stdin, "workspace/file.ts");
      await press(instance.stdin, "\r");
      expect(submitted).toEqual(["/workspace/file.ts"]);
    } finally {
      instance.unmount();
    }
  });

  it("marks settings unavailable during a run and does not queue the selected command", async () => {
    const submitted: string[] = [];
    const instance = render(
      createElement(App, {
        ...actions,
        view: { ...EMPTY_VIEW, runStatus: "active", canSubmit: false, queueingInput: true },
        capabilities: MONO,
        onSubmit: (text) => {
          submitted.push(text);
        },
      }),
    );
    try {
      await press(instance.stdin, "/");
      expect(instance.lastFrame()).toMatch(/Provider settings \(idle only\)/);
      await press(instance.stdin, "\r");
      expect(submitted).toEqual([]);
      expect(instance.lastFrame()).toMatch(/queue › \//);
    } finally {
      instance.unmount();
    }
  });

  for (const viewport of [
    { columns: 40, rows: 12 },
    { columns: 80, rows: 24 },
    { columns: 120, rows: 40 },
  ]) {
    it(`keeps the transcript, suggestions and input inside ${viewport.columns}x${viewport.rows}`, async () => {
      const instance = render(
        createElement(App, {
          ...actions,
          view: longConversation,
          capabilities: MONO,
          viewport,
        }),
      );
      try {
        await press(instance.stdin, "/");
        const frame = instance.lastFrame() ?? "";
        expect(frame).toMatch(/\/config/);
        expect(frame).toMatch(/task › \//);
        expect(frame.split("\n").length).toBeLessThanOrEqual(viewport.rows);
        expect(frame.split("\n").every((line) => cellWidth(line) <= viewport.columns)).toBe(true);
        await press(instance.stdin, "\u001b");
        await press(instance.stdin, "\u001b[5~");
        expect(instance.lastFrame()).not.toMatch(/history-line-79/);
      } finally {
        instance.unmount();
      }
    });

    it(`keeps slash suggestions visible in the ${viewport.columns}x${viewport.rows} lobby`, async () => {
      const instance = render(
        createElement(App, {
          ...actions,
          view: EMPTY_VIEW,
          capabilities: MONO,
          viewport,
        }),
      );
      try {
        await press(instance.stdin, "/");
        const frame = instance.lastFrame() ?? "";
        expect(frame).toMatch(/\/config/);
        expect(frame).toMatch(/task › \//);
        expect(frame.split("\n").length).toBeLessThan(viewport.rows);
        expect(frame.split("\n").every((line) => cellWidth(line) <= viewport.columns)).toBe(true);
      } finally {
        instance.unmount();
      }
    });
  }

  it("keeps slash answers literal while a question is open", async () => {
    const answered: string[] = [];
    const instance = render(
      createElement(App, {
        ...actions,
        view: {
          ...EMPTY_VIEW,
          runStatus: "waiting",
          waitingKind: "question",
          canSubmit: false,
          queueingInput: true,
          pendingQuestion: {
            questionId: "q1",
            toolCallId: "t1",
            question: "Which path?",
            answerType: "text",
            options: [],
            multiple: false,
            allowFreeText: true,
            requestVersion: 1,
          },
        },
        capabilities: MONO,
        onAnswer: (text) => answered.push(text),
      }),
    );
    try {
      await press(instance.stdin, "/config");
      expect(instance.lastFrame()).not.toMatch(/Provider settings/);
      await press(instance.stdin, "\r");
      expect(answered).toEqual(["/config"]);
    } finally {
      instance.unmount();
    }
  });

  it("clamps page boundaries and anchors earlier messages while new replies arrive", async () => {
    const screen = (view: TuiViewState) =>
      createElement(App, {
        ...actions,
        view,
        capabilities: MONO,
        viewport: { columns: 80, rows: 24 },
      });
    const instance = render(screen(longConversation));
    try {
      await press(instance.stdin, "\u001b[1;5H");
      expect(instance.lastFrame()).toMatch(/history-line-0\b/);
      await press(instance.stdin, "\u001b[5~");
      await press(instance.stdin, "\u001b[5~");
      await press(instance.stdin, "\u001b[6~");
      expect(instance.lastFrame()).not.toMatch(/history-line-0\b/);
      const before = instance.lastFrame()?.match(/history-line-\d+/)?.[0];
      expect(before).toBeDefined();
      instance.rerender(
        screen({
          ...longConversation,
          transcript: [
            ...longConversation.transcript,
            { id: "new-reply", kind: "assistant", text: "newly appended reply", status: null },
          ],
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(instance.lastFrame()?.match(/history-line-\d+/)?.[0]).toEqual(before);
      await press(instance.stdin, "\u001b[1;5F");
      expect(instance.lastFrame()).toMatch(/newly appended reply/);
    } finally {
      instance.unmount();
    }
  });

  it("scrolls with real terminal wheel reports, preserves the draft and disables mouse tracking on exit", async () => {
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const stderr = new PassThrough();
    let output = "";
    let frame = "";
    stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      if (text.includes("task ›")) frame = text;
    });
    const submitted: string[] = [];
    const instance = mountTerminal(
      createElement(App, {
        ...actions,
        view: longConversation,
        capabilities: MONO,
        viewport: { columns: 80, rows: 24 },
        onSubmit: (text) => {
          submitted.push(text);
        },
      }),
      {
        stdout,
        stdin,
        stderr,
        debug: true,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(output).toContain("\u001b[?1000h\u001b[?1006h");
      expect(frame).toMatch(/history-line-79/);
      await press(stdin, "unfinished draft");
      await press(stdin, "\u001b[<64;20;6M".repeat(5));
      expect(frame).not.toMatch(/history-line-79/);
      expect(frame).toMatch(/task › unfinished draft/);
      const before = frame;
      await press(stdin, "\u001b[<64;20;23M");
      expect(frame).toEqual(before);
      await press(stdin, "\u001b[<65;20;6M".repeat(5));
      expect(frame).toMatch(/history-line-79/);
      expect(output).toContain("\u001b[?2004h");
      await press(stdin, "\u001b[200~\u001b[<64;20;6M\r\u001b[201~");
      expect(frame).toMatch(/history-line-79/);
      expect(submitted).toEqual([]);
      await press(stdin, "\r");
      expect(submitted).toEqual(["unfinished draft[<64;20;6M"]);
      instance.unmount();
      expect(output).toContain("\u001b[?1000l\u001b[?1006l");
      expect(output).toContain("\u001b[?2004l");
      const ended = output;
      stdin.write("\u001b[<64;20;6M");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(output).toEqual(ended);
    } finally {
      instance.unmount();
      stdout.destroy();
      stdin.destroy();
      stderr.destroy();
    }
  });
});

describe("footer token counts", () => {
  it("shows the total for the last Run", () => {
    const instance = renderApp({
      ...EMPTY_VIEW,
      runStatus: "completed",
      usage: { inputTokens: 1200, outputTokens: 300 },
    });
    try {
      expect(instance.lastFrame()).toMatch(/1\.5k tok/);
    } finally {
      instance.unmount();
    }
  });

  it("shows the cached subset when the provider reported one", () => {
    // The cached count explains a large prompt with a small effective cost, so it
    // is worth the footer space; it is a subset, not an addition.
    const instance = renderApp({
      ...EMPTY_VIEW,
      runStatus: "completed",
      usage: { inputTokens: 5000, outputTokens: 100, cachedInputTokens: 4000 },
    });
    try {
      expect(instance.lastFrame()).toMatch(/5\.1k tok \(4k cached\)/);
    } finally {
      instance.unmount();
    }
  });

  it("shows nothing when usage is unknown", () => {
    // Unknown must not read as zero.
    const instance = renderApp({ ...EMPTY_VIEW, runStatus: "completed", usage: null });
    try {
      expect(instance.lastFrame()).not.toMatch(/ tok/);
    } finally {
      instance.unmount();
    }
  });

  it("shows nothing when no request reported tokens", () => {
    const instance = renderApp({
      ...EMPTY_VIEW,
      runStatus: "completed",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    try {
      expect(instance.lastFrame()).not.toMatch(/ tok/);
    } finally {
      instance.unmount();
    }
  });

  it("keeps the status code visible alongside the count", () => {
    const instance = renderApp({
      ...EMPTY_VIEW,
      runStatus: "failed",
      safeCode: "round_limit",
      usage: { inputTokens: 900, outputTokens: 100 },
    });
    try {
      const frame = instance.lastFrame() ?? "";
      expect(frame).toMatch(/1k tok/);
      expect(frame).toMatch(/round_limit/);
    } finally {
      instance.unmount();
    }
  });
});

describe("local command pages", () => {
  for (const viewport of [
    { columns: 40, rows: 12 },
    { columns: 80, rows: 24 },
  ]) {
    it(`selects a new session and enters a resume ID at ${viewport.columns} columns`, async () => {
      const submitted: string[] = [];
      let closed = 0;
      const instance = render(
        createElement(App, {
          ...actions,
          view: { ...EMPTY_VIEW, localPanel: "session" },
          capabilities: MONO,
          viewport,
          sessionId: "a".repeat(80),
          onSubmit: (text) => {
            submitted.push(text);
          },
          onClosePanel: () => {
            closed += 1;
          },
        }),
      );
      try {
        const frame = instance.lastFrame() ?? "";
        expect(frame).toMatch(/Current:/);
        expect(frame.split("\n").length).toBeLessThan(viewport.rows);
        expect(frame.split("\n").every((line) => cellWidth(line) <= viewport.columns)).toBe(true);
        await press(instance.stdin, "\u001b[B");
        await press(instance.stdin, "\r");
        expect(submitted).toEqual(["/new"]);
        await press(instance.stdin, "\u001b[B");
        await press(instance.stdin, "\r");
        await press(instance.stdin, "saved-123");
        expect(instance.lastFrame()).toMatch(/ID: saved-123/);
        await press(instance.stdin, "\r");
        expect(submitted).toEqual(["/new", "/session resume saved-123"]);
        await press(instance.stdin, "\u001b");
        expect(closed).toBe(0);
        await press(instance.stdin, "\u001b");
        expect(closed).toBe(1);
      } finally {
        instance.unmount();
      }
    });
  }
  it("opens help without exposing or changing the transcript and closes it on Escape", async () => {
    let closed = false;
    let quit = false;
    const instance = render(
      createElement(App, {
        ...actions,
        view: { ...longConversation, localPanel: "help" },
        capabilities: MONO,
        viewport: { columns: 40, rows: 12 },
        onClosePanel: () => {
          closed = true;
        },
        onQuit: () => {
          quit = true;
        },
      }),
    );
    try {
      expect(instance.lastFrame()).toMatch(/Commands/);
      expect(instance.lastFrame()).not.toMatch(/history-line/);
      // Scroll to the end rather than a fixed number of steps: the command list
      // grows, and a hardcoded count silently stops reaching the last rows.
      for (let step = 0; step < 60; step += 1) await press(instance.stdin, "\u001b[B");
      // The row wraps at 36 columns, so match a fragment that stays on one line.
      expect(instance.lastFrame()).toMatch(/Toggle tool/);
      await press(instance.stdin, "\u001b");
      expect(closed).toBe(true);
      expect(quit).toBe(false);
    } finally {
      instance.unmount();
    }
  });
});
