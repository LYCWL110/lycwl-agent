import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ReactElement } from "react";
import type { ModelDetailsResult } from "../../src/adapters/providers/model-list.ts";
import { parseModelList } from "../../src/adapters/providers/model-list.ts";
import { createConfigStore } from "../../src/adapters/windows/config-store.ts";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import { type ConfigFlowOptions, startConfigFlow } from "../../src/bootstrap/config-flow.ts";
import { assembleRuntime } from "../../src/bootstrap/runtime-assembly.ts";
import { saveSetup } from "../../src/bootstrap/setup-save.ts";
import { parseJsonc, toPlainValue } from "../../src/domain/config/jsonc.ts";
import type { CatalogModel } from "../../src/domain/config/model-catalog.ts";
import {
  readProviderConfig,
  type SupportedProtocol,
} from "../../src/domain/config/provider-config.ts";
import { applyKey, reasoningChoices, reasoningNotice } from "../../src/tui/config-browser.ts";
import { ConfigBrowser, type ConfigBrowserProps } from "../../src/tui/config-browser-view.ts";
import { type SetupDraft, type SetupProps, SetupScreen } from "../../src/tui/setup-screen.ts";

let root = "";
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-config-flow-"));
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture(name: string, protocol: SupportedProtocol = "anthropic_messages") {
  const directory = path.join(root, name);
  const store = createConfigStore({ directory });
  const vault = createFileVault({ directory });
  const saved = await saveSetup({
    draft: {
      protocol,
      baseUrl: "https://gateway.example/v1",
      model: "original",
      credentialRef: "fixture",
      apiKey: "fixture-key-do-not-use",
    },
    store,
    vault,
  });
  assert.ok(saved.ok);
  return { directory, store, vault, credentialRef: saved.config.credentialRef };
}

async function open(
  f: Pick<Awaited<ReturnType<typeof fixture>>, "directory" | "store" | "vault">,
  extra: Partial<ConfigFlowOptions> = {},
  browse = true,
) {
  let element: ReactElement | null = null;
  let resolveMounted: () => void = () => undefined;
  const mounted = new Promise<void>((resolve) => {
    resolveMounted = resolve;
  });
  let closed = false;
  const flow = startConfigFlow({
    configStore: f.store,
    vault: f.vault,
    workspaceRoot: f.directory,
    dataDirectory: f.directory,
    onReady: () => undefined,
    onDiscard: () => undefined,
    ...extra,
    mount: (value) => {
      element = value;
      resolveMounted();
      return {
        rerender: (next) => {
          element = next as ReactElement;
        },
        unmount: () => {
          closed = true;
        },
      };
    },
  });
  await mounted;
  const initialElement = element as ReactElement | null;
  assert.equal(initialElement?.type, extra.initialPage === "model" ? ConfigBrowser : SetupScreen);
  if (browse && extra.initialPage !== "model") {
    const setup = initialElement?.props as SetupProps;
    setup.onBrowse?.(setup.initial as SetupDraft);
  }
  return {
    flow,
    browser: (): ConfigBrowserProps => {
      assert.equal(element?.type, ConfigBrowser);
      return element?.props as ConfigBrowserProps;
    },
    setup: (): SetupProps => {
      assert.equal(element?.type, SetupScreen);
      return element?.props as SetupProps;
    },
    closed: () => closed,
  };
}

async function read(f: Pick<Awaited<ReturnType<typeof fixture>>, "directory" | "store" | "vault">) {
  const loaded = await f.store.load();
  assert.ok(loaded.ok);
  const parsed = parseJsonc(loaded.value.text);
  assert.ok(parsed.ok);
  const config = readProviderConfig(toPlainValue(parsed.value));
  assert.ok(config.ok);
  return { loaded: loaded.value, config: config.value };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("configuration update did not arrive");
}

describe("configuration flow persistence", () => {
  it("blocks unknown saved effort and requires default for an unknown Responses model", async () => {
    const f = await fixture("unknown-responses-manual-action", "openai_responses");
    const initial = await read(f);
    const saved = await f.store.save({
      baseRevision: initial.loaded.revision,
      baseDocumentHash: initial.loaded.documentHash,
      draft: initial.loaded.text.replace(
        '"model": "original"',
        '"model": "deepseek-v4.1-flash", "reasoningEffort": "xhigh"',
      ),
    });
    assert.ok(saved.ok);
    const ui = await open(f, { initialPage: "model" });
    ui.browser().onState(applyKey(ui.browser().state, "right").state);
    assert.equal(ui.browser().state.activeColumn, "reasoning");
    assert.deepEqual(reasoningChoices(ui.browser().state), ["default"]);
    ui.browser().onState(applyKey(ui.browser().state, { kind: "text", value: "m" }).state);
    const opened = applyKey(ui.browser().state, "enter");
    assert.equal(opened.commit, null);
    ui.browser().onState(opened.state);
    assert.equal(ui.closed(), false);
    assert.equal((await read(f)).loaded.documentHash, saved.value.documentHash);
    assert.equal(reasoningNotice(ui.browser().state), "No upstream levels; default only");
    assert.equal(ui.browser().state.reasoningEffort, "xhigh");
    ui.browser().onCommit({
      protocol: "openai_responses",
      model: "deepseek-v4.1-flash",
      reasoningEffort: "xhigh",
    });
    assert.equal(ui.closed(), false);
    assert.equal((await read(f)).loaded.documentHash, saved.value.documentHash);
    ui.browser().onState(applyKey(ui.browser().state, "down").state);
    const commit = applyKey(ui.browser().state, "enter").commit;
    assert.ok(commit);
    ui.browser().onCommit(commit);
    assert.equal(await ui.flow.done, "saved");
    assert.equal((await read(f)).config.reasoningEffort ?? "default", "default");
    assert.equal((await read(f)).config.model, "deepseek-v4.1-flash");
  });

  for (const protocol of ["openai_chat", "openai_responses", "anthropic_messages"] as const) {
    it(`does not save a ${protocol} reference level without upstream metadata`, async () => {
      const model = protocol === "anthropic_messages" ? "claude-opus-4-6" : "gpt-5.2";
      const f = await fixture(`reference-${protocol}`, protocol);
      const ui = await open(f, {
        initialPage: "model",
        fetchModels: async () => [model],
        fetchModel: async () => ({ ok: false, code: "not_supported" }),
      });
      await waitFor(() => ui.browser().state.models.some((entry) => entry.id === model));
      ui.browser().onState(applyKey(ui.browser().state, "down").state);
      assert.equal(reasoningNotice(ui.browser().state), "No upstream levels; default only");
      assert.deepEqual(reasoningChoices(ui.browser().state), ["default"]);
      await waitFor(() => /Model details unavailable/.test(ui.browser().state.status?.text ?? ""));
      assert.equal(ui.browser().state.status?.isError, true);
      ui.browser().onCommit({ protocol, model, reasoningEffort: "high" });
      assert.equal(ui.closed(), false);
      assert.equal((await read(f)).config.model, "original");
      ui.browser().onCommit({ protocol, model, reasoningEffort: "default" });
      assert.equal(await ui.flow.done, "saved");
      assert.equal((await read(f)).config.model, model);
      assert.equal((await read(f)).config.reasoningEffort ?? "default", "default");
      const reopened = await open(f, { initialPage: "model" });
      assert.equal(reopened.browser().state.reasoningEffort, "default");
      assert.equal(reasoningNotice(reopened.browser().state), "No upstream levels; default only");
      reopened.browser().onCancel();
      await reopened.flow.done;
    });
  }

  it("applies late upstream restrictions and preserves an invalid saved value until reselected", async () => {
    const f = await fixture("reference-then-declaration", "openai_responses");
    let reply: ((value: ModelDetailsResult) => void) | undefined;
    const ui = await open(f, {
      initialPage: "model",
      fetchModels: async () => ["gpt-5.2"],
      fetchModel: () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    });
    await waitFor(() => ui.browser().state.models.length === 2);
    ui.browser().onState(applyKey(ui.browser().state, "down").state);
    ui.browser().onState({ ...ui.browser().state, reasoningEffort: "xhigh" });
    await waitFor(() => reply !== undefined);
    reply?.({ ok: true, model: { id: "gpt-5.2", reasoning: { efforts: ["low"] } } });
    await waitFor(() => ui.browser().state.models[1]?.reasoning !== undefined);
    assert.deepEqual(reasoningChoices(ui.browser().state), ["default", "low"]);
    assert.equal(ui.browser().state.reasoningEffort, "xhigh");
    assert.equal(applyKey(ui.browser().state, "enter").commit, null);
    ui.browser().onCommit({
      protocol: "openai_responses",
      model: "gpt-5.2",
      reasoningEffort: "xhigh",
    });
    assert.equal(ui.closed(), false);
    ui.browser().onCommit({
      protocol: "openai_responses",
      model: "gpt-5.2",
      reasoningEffort: "low",
    });
    assert.equal(await ui.flow.done, "saved");
  });

  it("keeps choices at default after invalid details and a refresh without metadata", async () => {
    const f = await fixture("reference-invalid-detail", "openai_responses");
    let calls = 0;
    const ui = await open(f, {
      initialPage: "model",
      fetchModels: async () => ["gpt-5.2"],
      fetchModel: async ({ model }) => {
        calls += 1;
        return calls === 1
          ? { ok: true, model: { id: model, reasoningInvalid: true } }
          : { ok: true, model: { id: model } };
      },
    });
    await waitFor(() => ui.browser().state.models.length === 2);
    ui.browser().onState(applyKey(ui.browser().state, "down").state);
    await waitFor(() => ui.browser().state.models[1]?.reasoningInvalid === true);
    assert.deepEqual(reasoningChoices(ui.browser().state), ["default"]);
    ui.browser().onRefresh?.();
    assert.equal(ui.browser().state.models[1]?.reasoningInvalid, undefined);
    assert.equal(reasoningNotice(ui.browser().state), "No upstream levels; default only");
    await waitFor(() =>
      /Model details do not declare effort levels/.test(ui.browser().state.status?.text ?? ""),
    );
    assert.equal(calls, 2);
    ui.browser().onCancel();
    await ui.flow.done;
  });

  it("does not use reference choices when model list and details endpoints are unavailable", async () => {
    const f = await fixture("reference-no-list", "openai_responses");
    const saved = await read(f);
    assert.ok(
      (
        await f.store.save({
          baseRevision: saved.loaded.revision,
          baseDocumentHash: saved.loaded.documentHash,
          draft: saved.loaded.text.replace('"model": "original"', '"model": "gpt-5.2"'),
        })
      ).ok,
    );
    const ui = await open(f, {
      initialPage: "model",
      fetchModels: async () => ({ ok: false, code: "not_supported" }),
      fetchModel: async () => ({ ok: false, code: "not_supported" }),
    });
    await waitFor(() => /Model details unavailable/.test(ui.browser().state.status?.text ?? ""));
    assert.equal(reasoningNotice(ui.browser().state), "No upstream levels; default only");
    ui.browser().onCommit({
      protocol: "openai_responses",
      model: "gpt-5.2",
      reasoningEffort: "high",
    });
    assert.equal(ui.closed(), false);
    assert.equal((await read(f)).config.reasoningEffort, undefined);
    ui.browser().onCancel();
    assert.equal(await ui.flow.done, "discarded");
  });

  for (const protocol of ["openai_chat", "openai_responses", "anthropic_messages"] as const) {
    it(`retrieves selected-model metadata when the ${protocol} catalog lacks levels`, async () => {
      const f = await fixture(`detail-${protocol}`, protocol);
      let calls = 0;
      const ui = await open(f, {
        initialPage: "model",
        fetchModels: async () => ["original"],
        fetchModel: async (request) => {
          calls += 1;
          assert.equal(request.protocol, protocol);
          assert.equal(request.baseUrl, "https://gateway.example/v1");
          assert.equal(request.apiKey, "fixture-key-do-not-use");
          assert.equal(request.model, "original");
          return {
            ok: true,
            model: {
              id: request.model,
              reasoning: { efforts: ["low", "high", "max"], defaultEffort: "high" },
            },
          };
        },
      });
      await waitFor(() => ui.browser().state.models[0]?.reasoning !== undefined);
      assert.equal(calls, 1);
      assert.equal(ui.browser().state.models[0]?.reasoning?.defaultEffort, "high");
      assert.equal(ui.browser().state.reasoningEffort, "default");
      ui.browser().onCommit({ protocol, model: "original", reasoningEffort: "max" });
      assert.equal(await ui.flow.done, "saved");
      assert.equal((await read(f)).config.reasoningEffort, "max");
    });
  }

  it("uses list metadata without requesting model details", async () => {
    const f = await fixture("no-detail-needed", "anthropic_messages");
    let calls = 0;
    const ui = await open(f, {
      initialPage: "model",
      fetchModels: async () => [{ id: "original", reasoning: { efforts: ["high"] } }],
      fetchModel: async () => {
        calls += 1;
        return { ok: false, code: "unexpected" };
      },
    });
    await waitFor(() => ui.browser().state.models[0]?.reasoning !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(calls, 0);
    ui.browser().onCancel();
    await ui.flow.done;
  });

  it("ignores late detail replies, reuses scoped results and clears the cache on refresh", async () => {
    const f = await fixture("detail-races", "openai_chat");
    const pending = new Map<string, (value: ModelDetailsResult) => void>();
    const calls: string[] = [];
    const ui = await open(f, {
      initialPage: "model",
      fetchModels: async () => ["original", "other"],
      fetchModel: ({ model }) =>
        new Promise((resolve) => {
          calls.push(model);
          pending.set(model, resolve);
        }),
    });
    await waitFor(() => pending.has("original"));
    ui.browser().onState(applyKey(ui.browser().state, "down").state);
    await waitFor(() => pending.has("other"));
    pending.get("other")?.({ ok: true, model: { id: "other", reasoning: { efforts: ["high"] } } });
    await waitFor(() => ui.browser().state.models[1]?.reasoning !== undefined);
    pending.get("original")?.({
      ok: true,
      model: { id: "original", reasoning: { efforts: ["low"] } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.browser().state.models[0]?.reasoning, undefined);
    assert.deepEqual(ui.browser().state.models[1]?.reasoning?.efforts, ["high"]);
    ui.browser().onState(applyKey(ui.browser().state, "up").state);
    await waitFor(() => ui.browser().state.models[0]?.reasoning !== undefined);
    assert.equal(calls.filter((model) => model === "original").length, 1);
    ui.browser().onRefresh?.();
    assert.equal(ui.browser().state.models[0]?.reasoning, undefined);
    await waitFor(() => calls.filter((model) => model === "original").length === 2);
    ui.browser().onCancel();
    await ui.flow.done;
    pending.get("original")?.({
      ok: true,
      model: { id: "original", reasoning: { efforts: ["max"] } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.closed(), true);
    assert.equal((await read(f)).config.reasoningEffort, undefined);
  });

  it("does not use the stored key for detail requests after editing the destination", async () => {
    const f = await fixture("detail-key-boundary", "openai_chat");
    let calls = 0;
    const ui = await open(
      f,
      {
        fetchModels: async () => [],
        fetchModel: async () => {
          calls += 1;
          return { ok: false, code: "not_supported" };
        },
      },
      false,
    );
    ui.setup().onBrowse?.({
      ...(ui.setup().initial as SetupDraft),
      baseUrl: "https://other.example/v1",
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(calls, 0);
    assert.match(ui.browser().state.status?.text ?? "", /Enter an API key/);
    ui.browser().onCancel();
    await ui.flow.done;
  });

  it("does not apply model details from a previous protocol", async () => {
    const f = await fixture("detail-protocol", "anthropic_messages");
    const replies = new Map<SupportedProtocol, (result: ModelDetailsResult) => void>();
    const ui = await open(f, {
      initialPage: "model",
      fetchModels: async () => ["original"],
      fetchModel: ({ protocol }) =>
        new Promise((resolve) => {
          replies.set(protocol, resolve);
        }),
    });
    await waitFor(() => replies.has("anthropic_messages"));
    ui.browser().onState({ ...ui.browser().state, activeColumn: "protocol" });
    ui.browser().onState(applyKey(ui.browser().state, "down").state);
    await waitFor(() => replies.has("openai_chat"));
    replies.get("openai_chat")?.({
      ok: true,
      model: { id: "original", reasoning: { efforts: ["low"] } },
    });
    await waitFor(() => ui.browser().state.models[0]?.reasoning !== undefined);
    replies.get("anthropic_messages")?.({
      ok: true,
      model: { id: "original", reasoning: { efforts: ["max"] } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(ui.browser().state.models[0]?.reasoning?.efforts, ["low"]);
    ui.browser().onCancel();
    await ui.flow.done;
  });

  it("fetches fresh declarations after an explicit key edit without exposing the key", async () => {
    const f = await fixture("detail-key-edit", "openai_responses");
    const keys: string[] = [];
    const ui = await open(f, {
      initialPage: "model",
      fetchModels: async () => ["original"],
      fetchModel: async ({ model, apiKey }) => {
        keys.push(apiKey);
        return {
          ok: true,
          model: { id: model, reasoning: { efforts: keys.length === 1 ? ["low"] : ["max"] } },
        };
      },
    });
    await waitFor(() => ui.browser().state.models[0]?.reasoning !== undefined);
    ui.browser().onEdit?.();
    ui.setup().onBrowse?.({ ...(ui.setup().initial as SetupDraft), apiKey: "replacement-fixture" });
    await waitFor(() => keys.length === 2 && ui.browser().state.models[0]?.reasoning !== undefined);
    assert.deepEqual(keys, ["fixture-key-do-not-use", "replacement-fixture"]);
    assert.deepEqual(ui.browser().state.models[0]?.reasoning?.efforts, ["max"]);
    assert.equal(JSON.stringify(ui.browser().state).includes("replacement-fixture"), false);
    ui.browser().onCancel();
    await ui.flow.done;
  });

  it("keeps absent or mismatched detail metadata unknown without a manual bypass", async () => {
    for (const outcome of [
      { ok: false, code: "not_supported" },
      { ok: true, model: { id: "another-model", reasoning: { efforts: ["high"] } } },
      { ok: true, model: { id: "original" } },
    ] as const) {
      const f = await fixture(
        `unknown-detail-${outcome.ok ? outcome.model.id : "missing"}`,
        "openai_chat",
      );
      const ui = await open(f, {
        initialPage: "model",
        fetchModels: async () => ["original"],
        fetchModel: async () => outcome,
      });
      await waitFor(() =>
        /support unknown|do not declare/.test(ui.browser().state.status?.text ?? ""),
      );
      assert.equal(ui.browser().state.models[0]?.reasoning, undefined);
      ui.browser().onCommit({
        protocol: "openai_chat",
        model: "original",
        reasoningEffort: "high",
      });
      assert.equal(ui.closed(), false);
      ui.browser().onState(applyKey(ui.browser().state, { kind: "text", value: "m" }).state);
      ui.browser().onCommit({
        protocol: "openai_chat",
        model: "original",
        reasoningEffort: "high",
      });
      assert.equal(ui.closed(), false);
      ui.browser().onCancel();
      assert.equal(await ui.flow.done, "discarded");
    }
  });

  it("uses catalog declarations to reject unavailable effort values before saving", async () => {
    const f = await fixture("declared-efforts", "openai_responses");
    const before = await read(f);
    const ui = await open(f, {
      initialPage: "model",
      fetchModels: async () => {
        const catalog = parseModelList(
          JSON.stringify({
            data: [{ id: "original", reasoning: { supported_efforts: ["low", "high"] } }],
          }),
        );
        assert.ok(catalog.ok);
        return catalog.catalog ?? catalog.models;
      },
    });
    await waitFor(() => ui.browser().state.models[0]?.reasoning !== undefined);
    ui.browser().onCommit({
      protocol: "openai_responses",
      model: "original",
      reasoningEffort: "xhigh",
    });
    assert.equal(ui.closed(), false);
    assert.match(ui.browser().state.status?.text ?? "", /Select a listed/);
    assert.equal((await read(f)).loaded.documentHash, before.loaded.documentHash);
    ui.browser().onCommit({
      protocol: "openai_chat",
      model: "original",
      reasoningEffort: "high",
    });
    assert.equal(ui.closed(), false);
    ui.browser().onState(applyKey(ui.browser().state, { kind: "text", value: "m" }).state);
    ui.browser().onCommit({
      protocol: "openai_responses",
      model: "original",
      reasoningEffort: "medium",
    });
    assert.equal(ui.closed(), false);
    ui.browser().onCommit({
      protocol: "openai_responses",
      model: "original",
      reasoningEffort: "high",
    });
    assert.equal(await ui.flow.done, "saved");
    assert.equal((await read(f)).config.reasoningEffort, "high");
  });

  it("does not silently change a saved effort when the catalog stops declaring it", async () => {
    const f = await fixture("saved-unavailable", "openai_chat");
    const initial = await read(f);
    const seeded = await f.store.save({
      baseRevision: initial.loaded.revision,
      baseDocumentHash: initial.loaded.documentHash,
      draft: initial.loaded.text.replace(
        '"model": "original"',
        '"model": "original", "reasoningEffort": "high"',
      ),
    });
    assert.ok(seeded.ok);
    const ui = await open(f, {
      initialPage: "model",
      fetchModels: async () => [{ id: "original", reasoning: { efforts: ["low"] } }],
    });
    await waitFor(() => ui.browser().state.models[0]?.reasoning !== undefined);
    assert.equal(ui.browser().state.reasoningEffort, "high");
    assert.equal(applyKey(ui.browser().state, "enter").commit, null);
    ui.browser().onState({ ...ui.browser().state, activeColumn: "reasoning" });
    ui.browser().onState(applyKey(ui.browser().state, "down").state);
    assert.equal(ui.browser().state.reasoningEffort, "default");
    const commit = applyKey(ui.browser().state, "enter").commit;
    assert.ok(commit);
    ui.browser().onCommit(commit);
    assert.equal(await ui.flow.done, "saved");
    assert.equal((await read(f)).config.reasoningEffort, "default");
  });

  it("requires selection for a form's explicit effort and clears declarations after editing the endpoint", async () => {
    const f = await fixture("form-effort", "openai_chat");
    let calls = 0;
    const ui = await open(
      f,
      {
        fetchModels: async () => {
          calls += 1;
          return [{ id: "original", reasoning: { efforts: ["low"] } }];
        },
      },
      false,
    );
    ui.setup().onSave({ ...(ui.setup().initial as SetupDraft), reasoningEffort: "high" });
    assert.equal(ui.browser().state.activeColumn, "reasoning");
    await waitFor(() => ui.browser().state.models[0]?.reasoning !== undefined);
    assert.equal(applyKey(ui.browser().state, "enter").commit, null);
    ui.browser().onEdit?.();
    ui.setup().onBrowse?.(
      { ...(ui.setup().initial as SetupDraft), baseUrl: "https://changed.example/v1" },
      "reasoning",
    );
    assert.equal(calls, 1);
    assert.equal(ui.browser().state.models[0]?.reasoning, undefined);
    assert.match(ui.browser().state.status?.text ?? "", /Enter an API key/);
    ui.browser().onCancel();
    await ui.flow.done;
  });

  it("clears old declarations before refresh and keeps them unknown on failure", async () => {
    const f = await fixture("refresh-efforts", "openai_chat");
    let fail: ((value: { ok: false; code: string }) => void) | undefined;
    let requests = 0;
    const ui = await open(f, {
      initialPage: "model",
      fetchModels: async () => {
        requests += 1;
        if (requests === 1) return [{ id: "original", reasoning: { efforts: ["high"] } }];
        return new Promise((resolve) => {
          fail = resolve;
        });
      },
    });
    await waitFor(() => ui.browser().state.models[0]?.reasoning !== undefined);
    ui.browser().onRefresh?.();
    assert.equal(ui.browser().state.models[0]?.reasoning, undefined);
    await waitFor(() => fail !== undefined);
    fail?.({ ok: false, code: "fetch_failed" });
    await waitFor(() => ui.browser().state.status?.isError === true);
    assert.equal(ui.browser().state.models[0]?.reasoning, undefined);
    ui.browser().onCancel();
    await ui.flow.done;
  });

  it("opens /model directly in the model column, fetches and saves without changing the connection", async () => {
    const f = await fixture("model-command", "openai_responses");
    let requests = 0;
    const ui = await open(f, {
      initialPage: "model",
      fetchModels: async (request) => {
        requests += 1;
        assert.equal(request.baseUrl, "https://gateway.example/v1");
        assert.equal(request.apiKey, "fixture-key-do-not-use");
        return [
          {
            id: "catalog-model",
            reasoning: { efforts: ["none", "minimal", "low", "medium", "high"] },
          },
        ];
      },
    });
    assert.equal(ui.browser().state.activeColumn, "model");
    await waitFor(() => ui.browser().state.models.some((model) => model.id === "catalog-model"));
    assert.equal(requests, 1);
    const next = applyKey(ui.browser().state, "down");
    ui.browser().onState(next.state);
    ui.browser().onState(applyKey(ui.browser().state, "right").state);
    assert.equal(ui.browser().state.activeColumn, "reasoning");
    for (let index = 0; index < 5; index += 1)
      ui.browser().onState(applyKey(ui.browser().state, "down").state);
    const commit = applyKey(ui.browser().state, "enter").commit;
    assert.ok(commit);
    ui.browser().onCommit(commit);
    assert.equal(await ui.flow.done, "saved");
    const saved = await read(f);
    assert.equal(saved.config.model, "catalog-model");
    assert.equal(saved.config.reasoningEffort, "high");
    assert.equal(saved.config.baseUrl, "https://gateway.example/v1");
    assert.equal(saved.config.credentialRef, f.credentialRef);
    const reopened = await open(f, { initialPage: "model" });
    assert.equal(reopened.browser().state.reasoningEffort, "high");
    reopened.browser().onCancel();
    await reopened.flow.done;
  });
  for (const protocol of ["openai_chat", "openai_responses", "anthropic_messages"] as const) {
    it(`passes the saved reasoning effort into a ${protocol} request`, async () => {
      const f = await fixture(`reasoning-wire-${protocol}`, protocol);
      const ui = await open(f);
      ui.browser().onState({
        ...ui.browser().state,
        models: [{ id: "reasoning-model", source: "custom", reasoning: { efforts: ["max"] } }],
        modelIndex: 0,
      });
      ui.browser().onState(applyKey(ui.browser().state, { kind: "text", value: "m" }).state);
      ui.browser().onCommit({ protocol, model: "reasoning-model", reasoningEffort: "max" });
      assert.equal(await ui.flow.done, "saved");
      const saved = await read(f);
      const parsed = parseJsonc(saved.loaded.text);
      assert.ok(parsed.ok);
      let sent: Record<string, unknown> | null = null;
      const assembled = await assembleRuntime({
        settings: toPlainValue(parsed.value),
        dataDirectory: f.directory,
        toolDefinitions: [],
        post: async (request) => {
          assert.equal(
            request.url,
            protocol === "openai_chat"
              ? "https://gateway.example/v1/chat/completions"
              : protocol === "openai_responses"
                ? "https://gateway.example/v1/responses"
                : "https://gateway.example/v1/messages",
          );
          sent = JSON.parse(request.bodyText) as Record<string, unknown>;
          return {
            ok: true,
            status: 200,
            headers: {},
            wireBytes: 0,
            bodyText: JSON.stringify(
              protocol === "openai_chat"
                ? { choices: [{ message: { content: "hello" } }] }
                : protocol === "openai_responses"
                  ? { status: "completed", output: [] }
                  : { content: [{ type: "text", text: "hello" }] },
            ),
          };
        },
      });
      assert.ok(assembled.ok);
      await assembled.provider.complete({
        modelRequestId: "request",
        attemptNo: 1,
        conversation: [{ kind: "user", text: "hello" }],
      });
      assert.ok(sent);
      const body = sent as Record<string, unknown>;
      assert.equal(body["model"], "reasoning-model");
      if (protocol === "openai_chat") assert.equal(body["reasoning_effort"], "max");
      else if (protocol === "openai_responses")
        assert.deepEqual(body["reasoning"], { effort: "max" });
      else assert.deepEqual(body["output_config"], { effort: "max" });
      assert.equal(JSON.stringify(body).includes("fixture-key-do-not-use"), false);
    });
  }

  it("opens the connection form first and persists URL and replacement key", async () => {
    const f = await fixture("url-key");
    const ui = await open(f, {}, false);
    const setup = ui.setup();
    assert.equal(setup.initial.baseUrl, "https://gateway.example/v1");
    assert.equal(setup.initial.apiKey, "");
    setup.onSave({
      ...(setup.initial as SetupDraft),
      baseUrl: "https://new.example/v1",
      apiKey: "replacement-fixture",
    });
    assert.equal(await ui.flow.done, "saved");
    const reopened = await open(f, {}, false);
    assert.equal(reopened.setup().initial.baseUrl, "https://new.example/v1");
    assert.equal(reopened.setup().hasStoredCredential, true);
    assert.equal(reopened.setup().initial.apiKey, "");
    const key = await f.vault.read({
      reference: (await read(f)).config.credentialRef,
      purpose: "provider_api_key",
      revision: 1,
    });
    assert.ok(key.ok);
    assert.equal(key.value, "replacement-fixture");
    assert.equal((await read(f)).loaded.text.includes("replacement-fixture"), false);
    reopened.setup().onDiscard();
    await reopened.flow.done;
  });

  it("fetches models for an explicit draft key and keeps drafts through catalog navigation", async () => {
    const f = await fixture("draft-catalog");
    let fetchCount = 0;
    const ui = await open(
      f,
      {
        fetchModels: async ({ baseUrl, apiKey }) => {
          assert.equal(baseUrl, "https://draft.example/v1");
          assert.equal(apiKey, "draft-key");
          fetchCount += 1;
          return ["draft-model"];
        },
      },
      false,
    );
    ui.setup().onBrowse?.({
      ...(ui.setup().initial as SetupDraft),
      baseUrl: "https://draft.example/v1",
      apiKey: "draft-key",
    });
    await waitFor(() => ui.browser().state.models.some((model) => model.id === "draft-model"));
    assert.equal(fetchCount, 1);
    ui.browser().onEdit?.();
    assert.equal(ui.setup().initial.baseUrl, "https://draft.example/v1");
    assert.equal(ui.setup().initial.apiKey, "draft-key");
    ui.setup().onBrowse?.(ui.setup().initial as SetupDraft);
    ui.browser().onCommit({ protocol: "openai_chat", model: "selected" });
    assert.equal(await ui.flow.done, "saved");
    assert.equal((await read(f)).config.baseUrl, "https://draft.example/v1");
    const key = await f.vault.read({
      reference: (await read(f)).config.credentialRef,
      purpose: "provider_api_key",
      revision: 1,
    });
    assert.ok(key.ok);
    assert.equal(key.value, "draft-key");
  });

  it("does not send a stored key to a changed destination without an explicit replacement key", async () => {
    const f = await fixture("unsaved-destination");
    let calls = 0;
    const ui = await open(
      f,
      {
        fetchModels: async () => {
          calls += 1;
          return [];
        },
      },
      false,
    );
    ui.setup().onBrowse?.({
      ...(ui.setup().initial as SetupDraft),
      baseUrl: "https://different.example/v1",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    assert.match(ui.browser().state.status?.text ?? "", /Enter an API key/);
    ui.browser().onCancel();
    await ui.flow.done;
  });

  it("loads and selects a model during first-time setup before any configuration is saved", async () => {
    const directory = path.join(root, "first-time-model-list");
    const f = {
      directory,
      store: createConfigStore({ directory }),
      vault: createFileVault({ directory }),
    };
    const ui = await open(
      f,
      {
        fetchModels: async ({ protocol, baseUrl, apiKey }) => {
          assert.equal(protocol, "openai_responses");
          assert.equal(baseUrl, "https://fresh.example/v1");
          assert.equal(apiKey, "new-fixture-key");
          return ["available-a", { id: "available-b", reasoning: { efforts: ["low", "high"] } }];
        },
      },
      false,
    );
    ui.setup().onBrowse?.({
      ...(ui.setup().initial as SetupDraft),
      protocol: "openai_responses",
      baseUrl: "https://fresh.example/v1",
      apiKey: "new-fixture-key",
      model: "",
      reasoningEffort: "high",
    });
    await waitFor(() => ui.browser().state.models.length === 2);
    const browser = ui.browser();
    browser.onState({ ...browser.state, activeColumn: "model", modelIndex: 1 });
    const commit = applyKey(ui.browser().state, "enter").commit;
    assert.ok(commit);
    ui.browser().onCommit(commit);
    assert.equal(await ui.flow.done, "saved");
    const saved = await read(f);
    assert.equal(saved.config.model, "available-b");
    assert.equal(saved.config.reasoningEffort, "high");
    assert.equal(saved.loaded.text.includes("new-fixture-key"), false);
    const reopened = await open(f);
    assert.equal(reopened.browser().state.reasoningEffort, "high");
    reopened.browser().onCancel();
    await reopened.flow.done;
  });

  it("shows model-list failures instead of treating them as a successful empty list", async () => {
    const f = await fixture("fetch-failure");
    const ui = await open(f, {
      fetchModels: async () => ({ ok: false, code: "not_supported" }),
    });
    await waitFor(() => ui.browser().state.status?.isError === true);
    assert.match(ui.browser().state.status?.text ?? "", /does not list models/);
    assert.equal(ui.browser().state.models[0]?.id, "original");
    ui.browser().onCancel();
    await ui.flow.done;
  });
  for (const protocol of ["openai_chat", "openai_responses", "anthropic_messages"] as const) {
    it(
      `persists the browser's ${protocol} selection and reopens it`,
      { timeout: 5000 },
      async () => {
        const f = await fixture(protocol);
        const ui = await open(f);
        const initial = ui.browser();
        initial.onState({
          ...initial.state,
          protocolIndex: initial.state.protocols.indexOf(protocol),
          models: [{ id: "chosen-model", source: "custom" }],
          modelIndex: 0,
        });
        const commit = applyKey(ui.browser().state, "enter").commit;
        assert.ok(commit);
        ui.browser().onCommit(commit);
        assert.equal(await ui.flow.done, "saved");
        assert.ok(ui.closed());
        const saved = await read(f);
        assert.equal(saved.config.protocol, protocol);
        assert.equal(saved.config.model, "chosen-model");
        assert.equal(saved.loaded.text.includes("fixture-key-do-not-use"), false);
        const reopened = await open(f);
        const browser = reopened.browser();
        assert.equal(browser.state.protocols[browser.state.protocolIndex], protocol);
        assert.equal(browser.state.models[browser.state.modelIndex]?.id, "chosen-model");
        browser.onCancel();
        assert.equal(await reopened.flow.done, "discarded");
      },
    );
  }

  it("does not write when a changed protocol is discarded", async () => {
    const f = await fixture("cancel", "openai_chat");
    const before = await read(f);
    const ui = await open(f);
    ui.browser().onState(applyKey(ui.browser().state, "down").state);
    ui.browser().onCancel();
    await ui.flow.done;
    assert.equal((await read(f)).loaded.documentHash, before.loaded.documentHash);
  });

  it("prefills endpoint, protocol and model and reuses the existing key", async () => {
    const f = await fixture("edit", "openai_responses");
    const ui = await open(f);
    ui.browser().onEdit?.();
    const setup = ui.setup();
    assert.equal(setup.initial.protocol, "openai_responses");
    assert.equal(setup.initial.baseUrl, "https://gateway.example/v1");
    assert.equal(setup.initial.model, "original");
    assert.equal(setup.initial.apiKey, "");
    assert.equal(setup.hasStoredCredential, true);
    setup.onSave({
      ...setup.initial,
      protocol: "openai_chat",
      baseUrl: "https://other.example/v1",
      model: "edited",
      credentialRef: f.credentialRef,
      apiKey: "",
    });
    assert.equal(await ui.flow.done, "saved");
    const saved = await read(f);
    assert.equal(saved.config.protocol, "openai_chat");
    assert.equal(saved.config.model, "edited");
  });

  it("preserves the current document on a concurrent save and keeps the browser open", async () => {
    const f = await fixture("conflict");
    const ui = await open(f);
    await saveSetup({
      draft: {
        protocol: "openai_responses",
        baseUrl: "https://other.example",
        model: "external",
        credentialRef: f.credentialRef,
        apiKey: "",
      },
      store: f.store,
      vault: f.vault,
    });
    ui.browser().onCommit({ protocol: "openai_chat", model: "stale" });
    await waitFor(() => ui.browser().state.status?.isError === true);
    assert.match(ui.browser().state.status?.text ?? "", /config_conflict/);
    assert.equal(ui.closed(), false);
    assert.equal((await read(f)).config.model, "external");
    ui.browser().onCancel();
    await ui.flow.done;
  });

  it("can reset a saved reasoning effort to the provider default", async () => {
    const f = await fixture("reset-reasoning", "openai_chat");
    const ui = await open(f, {
      fetchModels: async () => [{ id: "original", reasoning: { efforts: ["high"] } }],
    });
    await waitFor(() => ui.browser().state.models[0]?.reasoning !== undefined);
    ui.browser().onCommit({ protocol: "openai_chat", model: "original", reasoningEffort: "high" });
    await ui.flow.done;
    const reopened = await open(f);
    reopened.browser().onState({ ...reopened.browser().state, reasoningEffort: "default" });
    const commit = applyKey(reopened.browser().state, "enter").commit;
    assert.ok(commit);
    reopened.browser().onCommit(commit);
    assert.equal(await reopened.flow.done, "saved");
    assert.equal((await read(f)).config.reasoningEffort, "default");
  });

  it("ignores a model-list reply for a protocol the user already changed", async () => {
    const f = await fixture("fetch-race");
    const replies = new Map<
      SupportedProtocol,
      (models: readonly (string | CatalogModel)[]) => void
    >();
    const ui = await open(f, {
      fetchModels: ({ protocol }) =>
        new Promise((resolve) => {
          replies.set(protocol, resolve);
        }),
    });
    await waitFor(() => replies.has("anthropic_messages"));
    ui.browser().onState({ ...ui.browser().state, activeColumn: "protocol" });
    ui.browser().onState(applyKey(ui.browser().state, "down").state);
    await waitFor(() => replies.has("openai_chat"));
    replies.get("openai_chat")?.([
      "chat-only",
      { id: "original", reasoning: { efforts: ["low"] } },
    ]);
    await waitFor(() => ui.browser().state.models.some((entry) => entry.id === "chat-only"));
    replies.get("anthropic_messages")?.([
      "stale-result",
      { id: "original", reasoning: { efforts: ["high"] } },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      ui.browser().state.models.some((entry) => entry.id === "stale-result"),
      false,
    );
    assert.deepEqual(ui.browser().state.models[0]?.reasoning?.efforts, ["low"]);
    ui.browser().onCancel();
    await ui.flow.done;
  });

  it("rejects a stale edit before replacing its credential", async () => {
    const f = await fixture("credential-conflict");
    const ui = await open(f);
    ui.browser().onEdit?.();
    const draft = ui.setup().initial;
    const before = await read(f);
    const changed = await f.store.save({
      baseRevision: before.loaded.revision,
      baseDocumentHash: before.loaded.documentHash,
      draft: before.loaded.text.replace('"original"', '"external"'),
    });
    assert.ok(changed.ok);
    ui.setup().onSave({
      protocol: "openai_chat",
      baseUrl: draft.baseUrl ?? "",
      model: "stale",
      credentialRef: draft.credentialRef ?? "",
      apiKey: "replacement-that-must-not-be-written",
    });
    await waitFor(() => ui.setup().saveError === "config_conflict");
    const key = await f.vault.read({
      reference: f.credentialRef,
      purpose: "provider_api_key",
      revision: 1,
    });
    assert.ok(key.ok);
    assert.equal(key.value, "fixture-key-do-not-use");
    assert.equal((await read(f)).config.model, "external");
    ui.setup().onDiscard();
    await ui.flow.done;
  });

  it("keeps provider comments, context window and token budget while changing protocol", async () => {
    const f = await fixture("metadata");
    const before = await read(f);
    const seeded = await f.store.save({
      baseRevision: before.loaded.revision,
      baseDocumentHash: before.loaded.documentHash,
      draft: before.loaded.text
        .replace('"contextWindow": null', '"contextWindow": 128000')
        .replace('"maxOutputTokens": 4096', '// keep provider note\n    "maxOutputTokens": 8192'),
    });
    assert.ok(seeded.ok);
    const ui = await open(f);
    ui.browser().onCommit({ protocol: "openai_chat", model: "new" });
    await ui.flow.done;
    const saved = await read(f);
    assert.match(saved.loaded.text, /keep provider note/);
    assert.match(saved.loaded.text, /"contextWindow": 128000/);
    assert.equal(saved.config.maxOutputTokens, 8192);
  });
});
