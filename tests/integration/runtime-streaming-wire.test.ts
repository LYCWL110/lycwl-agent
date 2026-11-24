import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type {
  ProviderHttpRequest,
  ProviderHttpResult,
} from "../../src/adapters/providers/provider-http.ts";
import type { SseEvent } from "../../src/adapters/providers/provider-sse.ts";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import { closeRuntimeSelections, selectRuntime } from "../fakes/owned-runtime.ts";

const SETTINGS = {
  provider: {
    protocol: "openai_chat",
    model: "fixture",
    baseUrl: "https://fixture.invalid",
    credentialRef: "fixture-key",
    contextWindow: 128_000,
  },
};

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition was not reached");
}

describe("runtime streaming wiring", () => {
  it("sends stream:true through the production composition and shows text before completion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-stream-wire-"));
    try {
      const workspace = path.join(root, "workspace");
      const data = path.join(root, "data");
      await mkdir(workspace, { recursive: true });

      const vault = createFileVault({ directory: data });
      const written = await vault.write({
        reference: "fixture-key",
        purpose: "provider_api_key",
        secret: "test-key",
      });
      assert.equal(written.ok, true, written.ok ? "" : written.code);

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const bodies: Record<string, unknown>[] = [];
      const streamPost = async (
        input: ProviderHttpRequest,
        onEvent: (event: SseEvent) => void,
      ): Promise<ProviderHttpResult> => {
        bodies.push(JSON.parse(input.bodyText) as Record<string, unknown>);
        onEvent({
          event: null,
          data: '{"choices":[{"delta":{"content":"hel"}}]}',
          id: null,
        });
        await gate;
        onEvent({
          event: null,
          data: '{"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
          id: null,
        });
        onEvent({ event: null, data: "[DONE]", id: null });
        return {
          ok: true,
          status: 200,
          headers: { "content-type": "text/event-stream" },
          bodyText: "",
          wireBytes: 0,
          eventStream: true,
        };
      };

      const selected = await selectRuntime({
        workspaceRoot: workspace,
        dataDirectory: data,
        stateDirectory: data,
        settings: SETTINGS,
        hasSettings: true,
        streamPost,
      });
      assert.equal(selected.kind, "real", selected.kind === "demo" ? selected.reason : "");
      if (selected.kind !== "real") return;

      const running = selected.coordinator.run("stream this");
      await waitFor(() => selected.coordinator.currentRunProjection()?.streaming?.text === "hel");
      assert.deepEqual(selected.coordinator.currentRunProjection()?.streaming, { text: "hel" });

      release();
      const result = await running;
      assert.equal(result.status, "completed");
      assert.equal(result.text, "hello");
      assert.equal(bodies[0]?.["stream"], true);
      assert.deepEqual(bodies[0]?.["stream_options"], { include_usage: true });
      const validated = result.events.filter(
        (event) => event.payload.kind === "model_response_validated",
      );
      assert.equal(validated.length, 1);
      assert.equal(selected.coordinator.currentRunProjection(), null);
    } finally {
      await closeRuntimeSelections();
      await rm(root, { recursive: true, force: true });
    }
  });
});
