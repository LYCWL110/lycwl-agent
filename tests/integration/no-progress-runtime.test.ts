import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type {
  ModelProvider,
  ProviderCompletion,
  ProviderRequest,
} from "../../src/ports/model-provider.ts";
import type {
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutor,
} from "../../src/ports/tool-executor.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

/**
 * The coordinator must refuse to dispatch a third identical call and must record a
 * warning at the second. These tests use a provider that keeps requesting the same
 * call, which is exactly the loop the detector exists for.
 */
class RepeatingProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  readonly #callCount: number;

  constructor(callCount: number) {
    this.#callCount = callCount;
  }

  async complete(request: ProviderRequest): Promise<ProviderCompletion> {
    this.requests.push(request);
    if (this.requests.length > this.#callCount) {
      return { kind: "completed", toolCalls: [], text: "done" };
    }
    return {
      kind: "completed",
      toolCalls: [
        {
          providerToolCallId: `call-${this.requests.length}`,
          toolName: "read_note",
          arguments: { path: "a.ts" },
        },
      ],
      text: null,
    };
  }
}

class CountingTools implements ToolExecutor {
  readonly executions: ToolExecutionRequest[] = [];
  readonly #definition: ToolDefinition = {
    name: "read_note",
    version: "1",
    sideEffectClass: "read_only",
    requiresApproval: false,
    concurrencySafe: false,
  };

  getDefinition(toolName: string): ToolDefinition | null {
    return toolName === this.#definition.name ? this.#definition : null;
  }

  async execute(request: ToolExecutionRequest) {
    this.executions.push(request);
    return { status: "succeeded" as const, text: "same body" };
  }
}

function coordinator(provider: ModelProvider, tools: ToolExecutor) {
  return new RuntimeCoordinator({
    provider,
    tools,
    approvals: { decide: async () => "approved" },
    eventLog: new InMemoryEventLog(new SequenceIds("event"), new JsonDigest()),
    ids: new SequenceIds(),
    nowUtc: () => "2026-11-05T00:00:00.000Z",
    suspendOnApproval: false,
  });
}

describe("no-progress detection in the coordinator", () => {
  it("warns on the second identical call and blocks before the third", async () => {
    const provider = new RepeatingProvider(10);
    const tools = new CountingTools();
    const result = await coordinator(provider, tools).run("loop forever");

    // Two executions happen; the third is refused before dispatch.
    assert.equal(tools.executions.length, 2);

    const warnings = result.events.filter(
      (event) => event.payload.kind === "no_progress_detected" && event.payload.decision === "warn",
    );
    assert.equal(warnings.length, 1);

    const blocks = result.events.filter(
      (event) =>
        event.payload.kind === "no_progress_detected" && event.payload.decision === "block",
    );
    assert.equal(blocks.length, 1);

    assert.equal(result.status, "waiting");
    assert.equal(result.safeCode, "no_progress");
    assert.equal(result.run.state, "waiting");
    if (result.run.state !== "waiting") return;
    assert.equal(result.run.reason, "recovery_review");
  });

  it("does not block a single call", async () => {
    const provider = new RepeatingProvider(1);
    const tools = new CountingTools();
    const result = await coordinator(provider, tools).run("do one thing");

    assert.equal(tools.executions.length, 1);
    assert.equal(result.status, "completed");
    assert.equal(
      result.events.some((event) => event.payload.kind === "no_progress_detected"),
      false,
    );
  });

  it("treats different arguments as progress", async () => {
    class VaryingProvider implements ModelProvider {
      readonly requests: ProviderRequest[] = [];
      async complete(): Promise<ProviderCompletion> {
        this.requests.push({ modelRequestId: "r", attemptNo: 1, conversation: [] });
        if (this.requests.length > 3) {
          return { kind: "completed", toolCalls: [], text: "done" };
        }
        return {
          kind: "completed",
          toolCalls: [
            {
              providerToolCallId: `call-${this.requests.length}`,
              toolName: "read_note",
              arguments: { path: `file-${this.requests.length}.ts` },
            },
          ],
          text: null,
        };
      }
    }
    const tools = new CountingTools();
    const result = await coordinator(new VaryingProvider(), tools).run("read several files");

    assert.equal(tools.executions.length, 3);
    assert.equal(result.status, "completed");
    assert.equal(
      result.events.some((event) => event.payload.kind === "no_progress_detected"),
      false,
    );
  });

  it("is insensitive to object key order in the arguments", async () => {
    class KeyOrderProvider implements ModelProvider {
      readonly requests: ProviderRequest[] = [];
      async complete(): Promise<ProviderCompletion> {
        this.requests.push({ modelRequestId: "r", attemptNo: 1, conversation: [] });
        if (this.requests.length > 3) {
          return { kind: "completed", toolCalls: [], text: "done" };
        }
        // Alternate key order: canonicalization must still see one fingerprint.
        const args =
          this.requests.length % 2 === 1
            ? { path: "a.ts", mode: "full" }
            : { mode: "full", path: "a.ts" };
        return {
          kind: "completed",
          toolCalls: [
            {
              providerToolCallId: `call-${this.requests.length}`,
              toolName: "read_note",
              arguments: args,
            },
          ],
          text: null,
        };
      }
    }
    const tools = new CountingTools();
    const result = await coordinator(new KeyOrderProvider(), tools).run("same call twice");

    assert.equal(result.status, "waiting");
    assert.equal(result.safeCode, "no_progress");
    assert.equal(tools.executions.length, 2);
  });
});
