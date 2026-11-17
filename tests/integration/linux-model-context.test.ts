import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ReactElement } from "react";
import { parseModelDetails, parseModelList } from "../../src/adapters/providers/model-list.ts";
import { createConfigStore } from "../../src/adapters/windows/config-store.ts";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import { type ConfigFlowOptions, startConfigFlow } from "../../src/bootstrap/config-flow.ts";
import { selectRuntime } from "../../src/bootstrap/runtime-selection.ts";
import { saveSetup } from "../../src/bootstrap/setup-save.ts";
import { parseJsonc, toPlainValue } from "../../src/domain/config/jsonc.ts";
import type { ContextWindowSource } from "../../src/domain/config/model-context.ts";
import { readProviderConfig } from "../../src/domain/config/provider-config.ts";
import { contextNotice, reasoningChoices } from "../../src/tui/config-browser.ts";
import { ConfigBrowser, type ConfigBrowserProps } from "../../src/tui/config-browser-view.ts";
import { type SetupDraft, type SetupProps, SetupScreen } from "../../src/tui/setup-screen.ts";

async function waitFor(predicate: () => boolean) {
  for (let n = 0; n < 400; n++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("model metadata did not settle");
}

async function fixture(
  t: TestContext,
  extra: Partial<ConfigFlowOptions> = {},
  context?: number,
  source?: ContextWindowSource,
) {
  const root = await mkdtemp(path.join(tmpdir(), "lycwl-context-"));
  const store = createConfigStore({ directory: root });
  const vault = createFileVault({ directory: root });
  const saved = await saveSetup({
    draft: {
      protocol: "openai_chat",
      baseUrl: "https://fixture.invalid/v1",
      model: "original",
      apiKey: "fixture-context-key",
      credentialRef: "fixture",
      ...(context === undefined ? {} : { contextWindow: context }),
      ...(source === undefined ? {} : { contextWindowSource: source }),
    },
    store,
    vault,
  });
  assert.ok(saved.ok);
  let element: ReactElement | null = null;
  const flow = startConfigFlow({
    configStore: store,
    vault,
    workspaceRoot: root,
    dataDirectory: root,
    initialPage: "model",
    onReady: () => undefined,
    onDiscard: () => undefined,
    fetchModels: async () => [{ id: "original", reasoning: { efforts: ["low", "high"] } }],
    ...extra,
    mount: (value) => {
      element = value;
      return {
        rerender: (next) => {
          element = next as ReactElement;
        },
        unmount: () => undefined,
      };
    },
  });
  t.after(async () => {
    flow.unmount();
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(() => element !== null);
  const browser = () => {
    assert.equal(element?.type, ConfigBrowser);
    return element?.props as ConfigBrowserProps;
  };
  const setup = () => {
    assert.equal(element?.type, SetupScreen);
    return element?.props as SetupProps;
  };
  if (extra.initialPage !== "setup")
    await waitFor(() => browser().state.models.some((model) => model.reasoning !== undefined));
  const read = async () => {
    const loaded = await store.load();
    assert.ok(loaded.ok);
    const parsed = parseJsonc(loaded.value.text);
    assert.ok(parsed.ok);
    const settings = toPlainValue(parsed.value);
    const config = readProviderConfig(settings);
    assert.ok(config.ok);
    return { config: config.value, settings };
  };
  return { root, store, vault, flow, browser, setup, read };
}

describe("Linux model context configuration", { skip: process.platform !== "linux" }, () => {
  it("uses list context without an unnecessary detail request and saves the source", async (t) => {
    let calls = 0;
    const f = await fixture(t, {
      fetchModels: async () => [
        { id: "original", contextWindow: 131072, reasoning: { efforts: ["low", "high"] } },
      ],
      fetchModel: async () => {
        calls++;
        return { ok: false, code: "not_supported" };
      },
    });
    assert.match(contextNotice(f.browser().state), /131,072.*upstream/);
    f.browser().onCommit({ protocol: "openai_chat", model: "original", reasoningEffort: "high" });
    assert.equal(await f.flow.done, "saved");
    assert.equal(calls, 0);
    assert.equal((await f.read()).config.contextWindow, 131072);
    assert.equal((await f.read()).config.contextWindowSource, "upstream");
    assert.equal((await f.read()).config.reasoningEffort, "high");
  });

  it("fetches context at save even when list reasoning was already available", async (t) => {
    let calls = 0;
    const f = await fixture(t, {
      fetchModel: async () => {
        calls++;
        return parseModelDetails(
          JSON.stringify({ id: "original", context_length: 200000 }),
          "openai_chat",
        );
      },
    });
    f.browser().onCommit({ protocol: "openai_chat", model: "original", reasoningEffort: "high" });
    assert.equal(await f.flow.done, "saved");
    assert.equal(calls, 1);
    const { config } = await f.read();
    assert.equal(config.contextWindow, 200000);
    assert.equal(config.reasoningEffort, "high");
  });

  for (const failure of ["missing", "malformed", "unsupported", "throw", "mismatch"] as const) {
    it(`defaults to 272000 when metadata is ${failure}`, async (t) => {
      const f = await fixture(t, {
        fetchModel: async () => {
          if (failure === "throw") throw new Error("offline");
          if (failure === "unsupported") return { ok: false, code: "not_supported" };
          if (failure === "mismatch")
            return { ok: true, model: { id: "other", contextWindow: 65536 } };
          return parseModelDetails(
            JSON.stringify({
              id: "original",
              ...(failure === "malformed" ? { context_length: "200k" } : {}),
            }),
            "openai_chat",
          );
        },
      });
      f.browser().onCommit({ protocol: "openai_chat", model: "original" });
      assert.equal(await f.flow.done, "saved");
      const { config } = await f.read();
      assert.equal(config.contextWindow, 272000);
      assert.equal(config.contextWindowSource, "default");
    });
  }

  it("preserves explicit manual context limits", async (t) => {
    const f = await fixture(
      t,
      {
        fetchModels: async () => [
          { id: "original", contextWindow: 200000, reasoning: { efforts: ["high"] } },
        ],
      },
      32768,
    );
    f.browser().onCommit({ protocol: "openai_chat", model: "original" });
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.contextWindow, 32768);
    assert.equal((await f.read()).config.contextWindowSource, "manual");
  });

  it("does not carry the previous model's context into a new model", async (t) => {
    const f = await fixture(
      t,
      {
        fetchModels: async () => [
          { id: "original", contextWindow: 200000, reasoning: { efforts: ["high"] } },
          { id: "other", contextWindow: 65536, reasoning: { efforts: ["high"] } },
        ],
      },
      128000,
      "upstream",
    );
    const state = f.browser().state;
    f.browser().onState({
      ...state,
      modelIndex: state.models.findIndex((model) => model.id === "other"),
    });
    f.browser().onCommit({ protocol: "openai_chat", model: "other" });
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.contextWindow, 65536);
    assert.equal((await f.read()).config.contextWindowSource, "upstream");
  });

  it("waits for a late detail result before saving and preserves reasoning choices", async (t) => {
    let reply:
      | ((result: { ok: true; model: { id: string; contextWindow: number } }) => void)
      | undefined;
    const f = await fixture(t, {
      fetchModel: () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    });
    f.browser().onCommit({ protocol: "openai_chat", model: "original", reasoningEffort: "high" });
    await waitFor(() => reply !== undefined);
    assert.equal((await f.read()).config.contextWindow, null);
    reply?.({ ok: true, model: { id: "original", contextWindow: 65536 } });
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.contextWindow, 65536);
    assert.equal((await f.read()).config.reasoningEffort, "high");
  });

  it("discards stale context replies after changing models", async (t) => {
    let reply:
      | ((result: { ok: true; model: { id: string; contextWindow: number } }) => void)
      | undefined;
    const f = await fixture(t, {
      fetchModels: async () => [
        { id: "original", reasoning: { efforts: ["high"] } },
        { id: "other", contextWindow: 65536, reasoning: { efforts: ["high"] } },
      ],
      fetchModel: () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    });
    f.browser().onCommit({ protocol: "openai_chat", model: "original" });
    await waitFor(() => reply !== undefined);
    f.browser().onState({ ...f.browser().state, modelIndex: 1 });
    reply?.({ ok: true, model: { id: "original", contextWindow: 200000 } });
    await delay(20);
    assert.deepEqual(reasoningChoices(f.browser().state), ["default", "high"]);
    f.browser().onCommit({ protocol: "openai_chat", model: "other" });
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.contextWindow, 65536);
  });

  it("retrieves context on a direct setup save without opening the browser", async (t) => {
    const f = await fixture(t, {
      initialPage: "setup",
      fetchModel: async () => ({ ok: true, model: { id: "original", contextWindow: 98304 } }),
    });
    f.setup().onSave(f.setup().initial as SetupDraft);
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.contextWindow, 98304);
  });

  it("loads missing context during actual model selection independently of list reasoning", async (t) => {
    let calls = 0;
    const f = await fixture(t, {
      discoverContextOnSelection: true,
      fetchModel: async () => {
        calls++;
        return {
          ok: true,
          model: { id: "original", contextWindow: 65536, reasoningInvalid: true },
        };
      },
    });
    await waitFor(() => f.browser().state.models[0]?.contextWindow === 65536);
    assert.equal(calls, 1);
    assert.deepEqual(reasoningChoices(f.browser().state), ["default", "low", "high"]);
    assert.match(contextNotice(f.browser().state), /65,536.*upstream/);
    f.browser().onCommit({ protocol: "openai_chat", model: "original", reasoningEffort: "high" });
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.contextWindow, 65536);
  });

  it("preserves a valid list declaration when returning to the setup form", async (t) => {
    let calls = 0;
    const f = await fixture(t, {
      fetchModels: async () => [
        { id: "original", contextWindow: 65536, reasoning: { efforts: ["high"] } },
      ],
      fetchModel: async () => {
        calls++;
        return { ok: false, code: "not_supported" };
      },
    });
    f.browser().onEdit?.();
    f.setup().onSave({ ...(f.setup().initial as SetupDraft), reasoningEffort: "default" });
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.contextWindow, 65536);
    assert.equal(calls, 0);
  });

  it("uses list context on direct setup save if the details endpoint is unsupported", async (t) => {
    let calls = 0;
    const f = await fixture(t, {
      initialPage: "setup",
      fetchModels: async () => [{ id: "original", contextWindow: 65536 }],
      fetchModel: async () => {
        calls++;
        return { ok: false, code: "not_supported" };
      },
    });
    f.setup().onSave(f.setup().initial as SetupDraft);
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.contextWindow, 65536);
    assert.equal(calls, 0);
  });

  it("retains a detail-discovered context across browser to setup navigation", async (t) => {
    let calls = 0;
    const f = await fixture(t, {
      fetchModel: async () => {
        calls++;
        return calls === 1
          ? { ok: true, model: { id: "original", contextWindow: 65536 } }
          : { ok: false, code: "not_supported" };
      },
      discoverContextOnSelection: true,
    });
    await waitFor(() => f.browser().state.models[0]?.contextWindow === 65536);
    f.browser().onEdit?.();
    f.setup().onSave({ ...(f.setup().initial as SetupDraft), reasoningEffort: "default" });
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.contextWindow, 65536);
    assert.equal(calls, 1);
  });

  it("retains discovered context while reconfirming a non-default effort from the form", async (t) => {
    let calls = 0;
    const f = await fixture(t, {
      discoverContextOnSelection: true,
      fetchModel: async () => {
        calls++;
        return calls === 1
          ? { ok: true, model: { id: "original", contextWindow: 65536 } }
          : { ok: false, code: "not_supported" };
      },
    });
    await waitFor(() => f.browser().state.models[0]?.contextWindow === 65536);
    f.browser().onState({ ...f.browser().state, reasoningEffort: "high" });
    f.browser().onEdit?.();
    f.setup().onSave(f.setup().initial as SetupDraft);
    await waitFor(() => f.browser().state.models[0]?.reasoning !== undefined);
    f.browser().onCommit({ protocol: "openai_chat", model: "original", reasoningEffort: "high" });
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.contextWindow, 65536);
    assert.equal((await f.read()).config.reasoningEffort, "high");
    assert.equal(calls, 1);
  });

  it("rechecks the catalog after entering the form before the previous list request finishes", async (t) => {
    let calls = 0;
    let reply: ((value: readonly string[]) => void) | undefined;
    const f = await fixture(t, {
      initialPage: "setup",
      fetchModels: async () => {
        calls++;
        if (calls === 1)
          return new Promise((resolve) => {
            reply = resolve;
          });
        return [{ id: "original", contextWindow: 65536 }];
      },
      fetchModel: async () => ({ ok: false, code: "not_supported" }),
    });
    f.setup().onBrowse?.(f.setup().initial as SetupDraft);
    await waitFor(() => reply !== undefined);
    f.browser().onEdit?.();
    f.setup().onSave(f.setup().initial as SetupDraft);
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.contextWindow, 65536);
    assert.equal(calls, 2);
    reply?.(["original"]);
  });

  it("cancels an old commit if the reasoning choice changes during the detail request", async (t) => {
    let reply:
      | ((value: { ok: true; model: { id: string; contextWindow: number } }) => void)
      | undefined;
    const f = await fixture(t, {
      fetchModel: () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    });
    f.browser().onState({ ...f.browser().state, reasoningEffort: "high" });
    f.browser().onCommit({ protocol: "openai_chat", model: "original", reasoningEffort: "high" });
    await waitFor(() => reply !== undefined);
    f.browser().onState({ ...f.browser().state, reasoningEffort: "low" });
    reply?.({ ok: true, model: { id: "original", contextWindow: 65536 } });
    await delay(20);
    assert.equal((await f.read()).config.contextWindow, null);
    f.browser().onCommit({ protocol: "openai_chat", model: "original", reasoningEffort: "low" });
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.reasoningEffort, "low");
    assert.equal((await f.read()).config.contextWindow, 65536);
  });

  it("does not wait on unrelated detail metadata when a manual window is configured", async (t) => {
    let calls = 0;
    const f = await fixture(
      t,
      {
        discoverContextOnSelection: true,
        fetchModel: async () => {
          calls++;
          throw new Error("must not be needed");
        },
      },
      32768,
    );
    f.browser().onCommit({ protocol: "openai_chat", model: "original", reasoningEffort: "high" });
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.contextWindow, 32768);
    assert.equal(calls, 0);
  });

  it("allows focus-only navigation while a context save is awaiting details", async (t) => {
    let reply:
      | ((value: { ok: true; model: { id: string; contextWindow: number } }) => void)
      | undefined;
    const f = await fixture(t, {
      fetchModel: () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    });
    f.browser().onCommit({ protocol: "openai_chat", model: "original" });
    await waitFor(() => reply !== undefined);
    f.browser().onState({ ...f.browser().state, activeColumn: "reasoning" });
    reply?.({ ok: true, model: { id: "original", contextWindow: 65536 } });
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.contextWindow, 65536);
  });

  for (const protocol of ["openai_chat", "openai_responses", "anthropic_messages"] as const) {
    it(`preserves list reasoning when a ${protocol} context detail has conflicting reasoning`, async (t) => {
      const f = await fixture(t, {
        initialPage: "setup",
        fetchModels: async () => [{ id: "original", reasoning: { efforts: ["high"] } }],
        fetchModel: async () => ({
          ok: true,
          model: { id: "original", contextWindow: 65536, reasoning: { efforts: ["low"] } },
        }),
      });
      f.setup().onBrowse?.({ ...(f.setup().initial as SetupDraft), protocol });
      await waitFor(() => f.browser().state.models[0]?.reasoning !== undefined);
      f.browser().onCommit({ protocol, model: "original", reasoningEffort: "high" });
      assert.equal(await f.flow.done, "saved");
      assert.equal((await f.read()).config.contextWindow, 65536);
      assert.equal((await f.read()).config.reasoningEffort, "high");
    });
  }

  it("does not reuse old catalog context or a stored key for an edited endpoint", async (t) => {
    let requests = 0;
    const f = await fixture(t, {
      fetchModels: async () => [
        { id: "original", contextWindow: 65536, reasoning: { efforts: ["high"] } },
      ],
      fetchModel: async () => {
        requests++;
        return { ok: true, model: { id: "original", contextWindow: 65536 } };
      },
    });
    f.browser().onEdit?.();
    f.setup().onSave({
      ...(f.setup().initial as SetupDraft),
      baseUrl: "https://changed.invalid/v1",
      reasoningEffort: "default",
    });
    assert.equal(await f.flow.done, "saved");
    assert.equal(requests, 0);
    assert.equal((await f.read()).config.contextWindow, 272000);
    assert.equal((await f.read()).config.contextWindowSource, "default");
  });

  it("cancels an in-flight commit after navigating away and back", async (t) => {
    let reply:
      | ((value: { ok: true; model: { id: string; contextWindow: number } }) => void)
      | undefined;
    const f = await fixture(t, {
      fetchModels: async () => [
        { id: "original", reasoning: { efforts: ["high"] } },
        { id: "other", contextWindow: 32768, reasoning: { efforts: ["high"] } },
      ],
      fetchModel: () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    });
    f.browser().onCommit({ protocol: "openai_chat", model: "original" });
    await waitFor(() => reply !== undefined);
    f.browser().onState({ ...f.browser().state, modelIndex: 1 });
    f.browser().onState({ ...f.browser().state, modelIndex: 0 });
    reply?.({ ok: true, model: { id: "original", contextWindow: 65536 } });
    await delay(20);
    assert.equal((await f.read()).config.contextWindow, null);
    f.browser().onCommit({ protocol: "openai_chat", model: "original" });
    assert.equal(await f.flow.done, "saved");
    assert.equal((await f.read()).config.contextWindow, 65536);
  });

  it("lets an old configuration without a context limit run using the 272k default", async (t) => {
    const f = await fixture(t);
    f.flow.unmount();
    const prior = await f.read();
    assert.equal(prior.config.contextWindow, null);
    let sent = false;
    const runtime = await selectRuntime({
      workspaceRoot: f.root,
      dataDirectory: f.root,
      settings: prior.settings,
      hasSettings: true,
      post: async () => {
        sent = true;
        return {
          ok: true,
          status: 200,
          headers: {},
          wireBytes: 1,
          bodyText: JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        };
      },
    });
    assert.equal(runtime.kind, "real");
    if (runtime.kind !== "real") return;
    t.after(() => runtime.coordinator.closeSession("cleanup"));
    assert.equal(runtime.config.contextWindow, 272000);
    assert.ok(runtime.warnings.some((warning) => /272000.*unverified/.test(warning)));
    assert.equal((await runtime.coordinator.run("test default capacity")).status, "completed");
    assert.equal(sent, true);
  });
});
