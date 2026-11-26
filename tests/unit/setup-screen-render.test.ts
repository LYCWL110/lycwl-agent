import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Box, render as mountTerminal, renderToString, Text } from "ink";
import { render } from "ink-testing-library";
import { createElement as h, type ReactElement } from "react";
import { describe, it } from "vitest";
import { createConfigStore } from "../../src/adapters/windows/config-store.ts";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { startConfigFlow } from "../../src/bootstrap/config-flow.ts";
import { saveSetup } from "../../src/bootstrap/setup-save.ts";
import { parseJsonc, toPlainValue } from "../../src/domain/config/jsonc.ts";
import { readProviderConfig } from "../../src/domain/config/provider-config.ts";
import { cellWidth, clipText, wrapText } from "../../src/tui/chrome.ts";
import { createTuiController } from "../../src/tui/controller.ts";
import { CredentialScreen } from "../../src/tui/credential-screen.ts";
import { startTui } from "../../src/tui/main.ts";
import type { SetupDraft } from "../../src/tui/setup-screen.ts";
import { SetupScreen } from "../../src/tui/setup-screen.ts";
import { TextInput } from "../../src/tui/text-input.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedApprovalGate,
  ScriptedProvider,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

function frame(element: ReactElement): string {
  const { lastFrame, unmount } = render(element);
  const output = lastFrame() ?? "";
  unmount();
  return output;
}

describe("setup screen rendering", () => {
  it("masks correction keys, preserves exact input and saves only explicitly", async () => {
    const saved: string[] = [];
    const instance = render(
      h(CredentialScreen, {
        width: 36,
        onSave: async (secret) => {
          saved.push(secret);
          return false;
        },
        onClose: () => undefined,
      }),
    );
    const secret = "SYNTHETIC_CORRECTION_KEY";
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      instance.stdin.write(secret);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(saved.length, 0);
      assert.equal(instance.frames.join("").includes(secret), false);
      assert.match(instance.lastFrame() ?? "", /\*{10}/u);
      instance.stdin.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(saved, [secret]);
      assert.equal(instance.frames.join("").includes(secret), false);
      assert.match(instance.lastFrame() ?? "", /Key not saved/u);
    } finally {
      instance.unmount();
    }
  });

  it("opens the reasoning catalog from the form instead of cycling unverified choices", async () => {
    let selectedColumn: string | undefined;
    const instance = render(
      h(SetupScreen, {
        initial: { protocol: "openai_chat", model: "fixture" },
        hasStoredCredential: true,
        error: null,
        warnings: [],
        onBrowse: (_draft, column) => {
          selectedColumn = column;
        },
        onSave: () => undefined,
        onDiscard: () => undefined,
      }),
    );
    try {
      for (const key of ["\t", "\t", "\t", "\t", "\u001b[C"]) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        instance.stdin.write(key);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(selectedColumn, "reasoning");
    } finally {
      instance.unmount();
    }
  });

  it("loads the catalog from the Model field, selects a model and saves its reasoning effort", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lycwl-catalog-keys-"));
    const store = createConfigStore({ directory });
    const vault = createFileVault({ directory });
    const seeded = await saveSetup({
      store,
      vault,
      draft: {
        protocol: "openai_responses",
        baseUrl: "https://gateway.example/v1",
        model: "original",
        credentialRef: "fixture",
        apiKey: "catalog-fixture-key",
      },
    });
    assert.ok(seeded.ok);
    let instance: ReturnType<typeof render> | undefined;
    let fetchCount = 0;
    const flow = startConfigFlow({
      configStore: store,
      vault,
      workspaceRoot: directory,
      dataDirectory: directory,
      capabilities: { depth: "mono", bold: true, reverse: true, narrow: false },
      mount: (element) => {
        instance = render(element);
        return instance;
      },
      fetchModels: async ({ baseUrl, apiKey }) => {
        fetchCount += 1;
        assert.equal(baseUrl, "https://gateway.example/v1");
        assert.equal(apiKey, "catalog-fixture-key");
        return ["available-a", { id: "available-b", reasoning: { efforts: ["low", "high"] } }];
      },
      onReady: () => undefined,
      onDiscard: () => undefined,
    });
    const press = async (key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(instance);
      instance.stdin.write(key);
      await new Promise((resolve) => setTimeout(resolve, 25));
    };
    try {
      for (let retry = 0; !instance && retry < 100; retry += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      for (const key of ["\t", "\t", "\t", "\r"]) await press(key);
      assert.equal(fetchCount, 1);
      assert.match(instance?.lastFrame() ?? "", /available-a/);
      assert.match(instance?.lastFrame() ?? "", /available-b/);
      for (const key of ["\u001b[B", "\u001b[B", "\u001b[C", "\u001b[B", "\u001b[B"])
        await press(key);
      assert.match(instance?.lastFrame() ?? "", /Reasoning/);
      assert.match(instance?.lastFrame() ?? "", /▸ ● high/);
      await press("\r");
      assert.equal(await flow.done, "saved");
      const loaded = await store.load();
      assert.ok(loaded.ok);
      const parsed = parseJsonc(loaded.value.text);
      assert.ok(parsed.ok);
      const config = readProviderConfig(toPlainValue(parsed.value));
      assert.ok(config.ok);
      assert.equal(config.value.model, "available-b");
      assert.equal(config.value.reasoningEffort, "high");
      assert.equal(instance?.frames.join("").includes("catalog-fixture-key"), false);
    } finally {
      flow.unmount();
      instance?.unmount();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves an effort representable by Anthropic when changing protocol", async () => {
    let saved: SetupDraft | null = null;
    const instance = render(
      h(SetupScreen, {
        initial: { protocol: "openai_chat", reasoningEffort: "medium" },
        hasStoredCredential: true,
        error: null,
        warnings: [],
        onSave: (draft) => {
          saved = draft;
        },
        onDiscard: () => undefined,
      }),
    );
    const press = async (key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      instance.stdin.write(key);
      await new Promise((resolve) => setTimeout(resolve, 25));
    };
    try {
      for (const key of ["\t", "\t", "\t", "\t", "\u001b[C", "\u0013"]) await press(key);
      assert.equal((saved as SetupDraft | null)?.reasoningEffort, "high");
      for (const key of ["\u001b[A", "\u001b[A", "\u001b[A", "\u001b[D", "\u0013"])
        await press(key);
      assert.equal((saved as SetupDraft | null)?.protocol, "anthropic_messages");
      assert.equal((saved as SetupDraft | null)?.reasoningEffort, "high");
    } finally {
      instance.unmount();
    }
  });

  it("changes URL and key through the mounted configuration flow and reopens saved values", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lycwl-form-keys-"));
    const store = createConfigStore({ directory });
    const vault = createFileVault({ directory });
    const seeded = await saveSetup({
      store,
      vault,
      draft: {
        protocol: "openai_chat",
        baseUrl: "https://old.example/v1",
        model: "fixture-model",
        credentialRef: "fixture",
        apiKey: "old-fixture-key",
      },
    });
    assert.ok(seeded.ok);
    let instance: ReturnType<typeof render> | undefined;
    const mount = (element: ReactElement) => {
      instance = render(element);
      return instance;
    };
    const options = {
      configStore: store,
      vault,
      workspaceRoot: directory,
      dataDirectory: directory,
      capabilities: { depth: "mono", bold: true, reverse: true, narrow: false } as const,
      mount,
      onReady: () => undefined,
      onDiscard: () => undefined,
    };
    const flow = startConfigFlow(options);
    try {
      for (let retry = 0; !instance && retry < 100; retry += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(instance);
      assert.match(instance.lastFrame() ?? "", /Base URL/);
      assert.match(instance.lastFrame() ?? "", /API key/);
      for (const key of [
        "\r",
        "\u0015",
        "https://new.example/v1",
        "\r",
        "\t",
        "\t",
        "\r",
        "new-fixture-key",
        "\u0013",
      ]) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        instance.stdin.write(key);
      }
      assert.equal(await flow.done, "saved");
      assert.equal(instance.frames.join("").includes("new-fixture-key"), false);
      const loaded = await store.load();
      assert.ok(loaded.ok);
      const parsed = parseJsonc(loaded.value.text);
      assert.ok(parsed.ok);
      const config = readProviderConfig(toPlainValue(parsed.value));
      assert.ok(config.ok);
      assert.equal(config.value.baseUrl, "https://new.example/v1");
      const credential = await vault.read({
        reference: config.value.credentialRef,
        purpose: "provider_api_key",
        revision: 1,
      });
      assert.ok(credential.ok);
      assert.equal(credential.value, "new-fixture-key");
      instance = undefined;
      const reopened = startConfigFlow(options);
      for (let retry = 0; !instance && retry < 100; retry += 1)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(instance);
      assert.match(
        (instance as ReturnType<typeof render>).lastFrame() ?? "",
        /https:\/\/new\.example\/v1/,
      );
      assert.match((instance as ReturnType<typeof render>).lastFrame() ?? "", /\(stored\)/);
      reopened.unmount();
      await reopened.done;
    } finally {
      flow.unmount();
      instance?.unmount();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("changes the protocol with arrows and submits that choice", async () => {
    let saved: SetupDraft | null = null;
    const instance = render(
      h(SetupScreen, {
        initial: { protocol: "anthropic_messages", baseUrl: "https://gateway.example", model: "m" },
        hasStoredCredential: true,
        error: null,
        warnings: [],
        onSave: (value) => {
          saved = value;
        },
        onDiscard: () => undefined,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.stdin.write("\t");
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.stdin.write("\u001b[C");
    await new Promise((resolve) => setTimeout(resolve, 20));
    instance.stdin.write("\u0013");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((saved as SetupDraft | null)?.protocol, "openai_chat");
    instance.unmount();
  });

  it("fits the full form into a narrow 40 by 24 terminal", () => {
    const output = renderToString(
      h(SetupScreen, {
        initial: {
          protocol: "openai_responses",
          baseUrl: "https://gateway.example",
          model: "中文模型",
        },
        hasStoredCredential: true,
        error: null,
        warnings: ["credentials are stored unencrypted"],
        viewport: { columns: 40, rows: 24 },
        capabilities: { depth: "mono", bold: true, reverse: true, narrow: true },
        onSave: () => undefined,
        onDiscard: () => undefined,
      }),
      { columns: 40 },
    );
    assert.ok(output.split("\n").every((line) => cellWidth(line) <= 40));
    assert.ok(output.split("\n").length <= 24, `rendered ${output.split("\n").length} rows`);
    assert.match(output, /API key/);
    assert.match(output, /Protocol/);
    assert.match(output, /unencrypted/);
  });
  it("keeps validation and save errors visible in a narrow terminal", () => {
    const output = renderToString(
      h(SetupScreen, {
        initial: { protocol: "openai_chat" },
        hasStoredCredential: true,
        error: { field: "baseUrl", code: "insecure_base_url" },
        saveError: "insecure_base_url",
        warnings: ["credentials are stored unencrypted"],
        viewport: { columns: 40, rows: 24 },
        capabilities: { depth: "mono", bold: true, reverse: true, narrow: true },
        onSave: () => undefined,
        onDiscard: () => undefined,
      }),
      { columns: 40 },
    );
    assert.ok(output.split("\n").every((line) => cellWidth(line) <= 40));
    assert.ok(output.split("\n").length <= 24, `rendered ${output.split("\n").length} rows`);
    assert.match(output, /Save failed: insecure_base_url/);
    assert.match(output, /invalid: insecure_base_url/);
  });
  it("shows every field and the save/discard hint", () => {
    const output = frame(
      h(SetupScreen, {
        initial: {},
        hasStoredCredential: false,
        error: null,
        warnings: [],
        onSave: () => undefined,
        onDiscard: () => undefined,
      }),
    );
    assert.match(output, /Provider setup/);
    assert.match(output, /Base URL/);
    assert.match(output, /Model/);
    assert.match(output, /Credential reference/);
    assert.match(output, /API key/);
    assert.match(output, /Enter edit/);
    assert.match(output, /Ctrl\+S save/);
    assert.match(output, /Esc discards/);
  });

  it("never renders a typed key", () => {
    const output = frame(
      h(SetupScreen, {
        initial: {},
        hasStoredCredential: false,
        error: null,
        warnings: [],
        onSave: () => undefined,
        onDiscard: () => undefined,
      }),
    );
    // The field starts empty, so any secret-shaped content would be a bug.
    assert.equal(/sk-/.test(output), false);
  });

  it("shows a field-specific validation error", () => {
    const output = frame(
      h(SetupScreen, {
        initial: {},
        hasStoredCredential: false,
        error: { field: "baseUrl", code: "insecure_base_url" },
        warnings: [],
        onSave: () => undefined,
        onDiscard: () => undefined,
      }),
    );
    assert.match(output, /invalid: insecure_base_url/);
  });

  it("shows the plaintext storage warning", () => {
    const output = frame(
      h(SetupScreen, {
        initial: {},
        hasStoredCredential: false,
        error: null,
        warnings: ["credentials are stored unencrypted (ADR-0038)"],
        onSave: () => undefined,
        onDiscard: () => undefined,
      }),
    );
    assert.match(output, /unencrypted/);
  });

  it("marks the key field optional when a credential already exists", () => {
    const output = frame(
      h(SetupScreen, {
        initial: {},
        hasStoredCredential: true,
        error: null,
        warnings: [],
        onSave: () => undefined,
        onDiscard: () => undefined,
      }),
    );
    // Required fields carry a marker; the key must not when one is already stored.
    const keyLine = output.split("\n").find((line) => line.includes("API key")) ?? "";
    assert.equal(keyLine.includes("*"), false);
  });

  it("edits URL and masked key with caret movement and saves only explicitly", async () => {
    let saved: SetupDraft | null = null;
    let discarded = false;
    const instance = render(
      h(SetupScreen, {
        initial: { baseUrl: "https://old.example/v1", protocol: "openai_chat", model: "original" },
        hasStoredCredential: true,
        error: null,
        warnings: [],
        viewport: { columns: 40, rows: 24 },
        onSave: (value) => {
          saved = value;
        },
        onDiscard: () => {
          discarded = true;
        },
      }),
    );
    const press = async (key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      instance.stdin.write(key);
      await new Promise((resolve) => setTimeout(resolve, 25));
    };
    try {
      await press("\r");
      assert.match(instance.lastFrame() ?? "", /Editing/);
      await press("\u0015");
      await press("https://new.example/v1");
      await press("\u001b[D");
      await press("\u001b[3~");
      await press("2");
      await press("\r");
      assert.equal(saved, null);
      await press("\t");
      await press("\t");
      await press("\r");
      await press("fixture-secret-123");
      await press("\u001b[H");
      await press("X");
      await press("\u001b[F");
      await press("\u007f");
      assert.equal(instance.frames.join("").includes("fixture-secret-123"), false);
      await press("\u001b");
      assert.equal(discarded, false);
      await press("\u0013");
      assert.equal((saved as SetupDraft | null)?.baseUrl, "https://new.example/v2");
      assert.equal((saved as SetupDraft | null)?.apiKey, "Xfixture-secret-12");
      assert.equal(discarded, false);
    } finally {
      instance.unmount();
    }
  });
});

describe("terminal cell layout", () => {
  it("enters an alternate screen for the main TUI and restores the terminal on Ctrl+C", async () => {
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const stderr = new PassThrough();
    let output = "";
    stdout.on("data", (data) => {
      output += data.toString();
    });
    const ids = new SequenceIds("screen");
    const coordinator = new RuntimeCoordinator({
      provider: new ScriptedProvider([]),
      tools: new RecordingTools(false, { status: "succeeded", text: null }),
      approvals: new ScriptedApprovalGate([]),
      eventLog: new InMemoryEventLog(ids, new JsonDigest()),
      ids,
      nowUtc: () => "2026-11-06T00:00:00.000Z",
    });
    const ui = startTui(createTuiController({ coordinator }), {
      mount: (element, options) =>
        mountTerminal(element, {
          ...options,
          stdout,
          stdin,
          stderr,
          interactive: true,
          patchConsole: false,
        }),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(output.includes("\u001b[?1049h"), "enter the alternate screen");
      assert.ok(output.includes("\u001b[?1000h\u001b[?1006h"), "enable terminal mouse reports");
      assert.equal(output.includes("\u001b[?1049l"), false);
      stdin.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(output.includes("\u001b[?1049l"), false, "Escape must not exit");
      stdin.write("\u0003");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(output.includes("\u001b[?1049l"), "restore the primary screen on exit");
      assert.ok(output.includes("\u001b[?1000l\u001b[?1006l"), "release terminal mouse capture");
      assert.equal(output.split("\u001b[?1049l").length - 1, 1);
      ui.unmount();
      assert.equal(output.split("\u001b[?1049l").length - 1, 1, "cleanup is idempotent");
    } finally {
      ui.unmount();
      stdout.destroy();
      stdin.destroy();
      stderr.destroy();
    }
  });

  it("uses the same alternate-screen lifecycle for provider configuration", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lycwl-config-screen-"));
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const stderr = new PassThrough();
    let output = "";
    stdout.on("data", (data) => {
      output += data.toString();
    });
    let mounted: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      mounted = resolve;
    });
    const flow = startConfigFlow({
      configStore: createConfigStore({ directory }),
      vault: createFileVault({ directory }),
      workspaceRoot: directory,
      dataDirectory: directory,
      capabilities: { depth: "mono", bold: true, reverse: true, narrow: false },
      mount: (element, options) => {
        const instance = mountTerminal(element, {
          ...options,
          stdout,
          stdin,
          stderr,
          interactive: true,
          patchConsole: false,
        });
        mounted?.();
        return instance;
      },
      onReady: () => undefined,
      onDiscard: () => undefined,
    });
    try {
      await ready;
      assert.ok(output.includes("\u001b[?1049h"));
      flow.unmount();
      assert.equal(await flow.done, "discarded");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(output.includes("\u001b[?1049l"));
    } finally {
      flow.unmount();
      stdout.destroy();
      stdin.destroy();
      stderr.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("places and shows the native terminal cursor and moves it with layout", async () => {
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const stderr = new PassThrough();
    let output = "";
    stdout.on("data", (data) => {
      output += data.toString();
    });
    const screen = (padding: number) =>
      h(
        Box,
        { paddingLeft: padding, paddingTop: 2 },
        h(Text, null, "> "),
        h(TextInput, { value: "中文abc", cursor: 2, width: 20 }),
      );
    const instance = mountTerminal(screen(3), {
      stdout,
      stdin,
      stderr,
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(output.includes("\u001b[?25h"), "the terminal must receive a show-cursor sequence");
      assert.ok(
        output.includes("\u001b[10G"),
        "caret must be after padding, prompt and wide characters",
      );
      output = "";
      instance.rerender(screen(6));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(
        output.includes("\u001b[13G"),
        "caret must follow its measured position after layout changes",
      );
    } finally {
      instance.unmount();
      stdout.destroy();
      stdin.destroy();
      stderr.destroy();
    }
  });
  it("counts CJK and emoji cells while keeping combining sequences together", () => {
    assert.equal(cellWidth("中文ab"), 6);
    assert.equal(cellWidth("e\u0301"), 1);
    assert.equal(cellWidth("👩‍💻"), 2);
    assert.equal(clipText("中文abcd", 5), "中文…");
    assert.deepEqual(wrapText("中文abcd", 4), ["中文", "abcd"]);
  });
});
