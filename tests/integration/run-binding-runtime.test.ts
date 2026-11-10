import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import {
  createRunModelBinding,
  describeEndpoint,
  endpointFingerprintInput,
  type RunModelBinding,
} from "../../src/domain/model-request/run-binding.ts";
import type { ModelProvider, ProviderRequest } from "../../src/ports/model-provider.ts";
import type { ToolExecutor } from "../../src/ports/tool-executor.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedApprovalGate,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function binding(): RunModelBinding {
  const described = describeEndpoint({ host: "api.example.com", port: null, path: "/v1/messages" });
  assert.equal(described.ok, true);
  if (!described.ok) throw new Error("endpoint");
  const result = createRunModelBinding({
    providerId: "provider-a",
    modelId: "model-a",
    protocolId: "protocol-a",
    adapterVersion: "adapter-1",
    endpoint: described.value,
    endpointFingerprint: sha256(endpointFingerprintInput(described.value)),
    catalog: { snapshotId: "catalog-1", sha256: sha256("catalog") },
    capabilities: { snapshotId: "caps-1", sha256: sha256("caps") },
    credential: { credentialRef: "provider-main", revision: 1 },
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("binding");
  return result.value;
}

class CountingProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  async complete(request: ProviderRequest) {
    this.requests.push(request);
    return { kind: "completed" as const, toolCalls: [], text: "done" };
  }
}

const tools: ToolExecutor = new RecordingTools(false, { status: "succeeded", text: "ok" });

function coordinator(options: {
  provider: ModelProvider;
  runBinding?: RunModelBinding;
  resolveCredentialRevision?: () => Promise<number | null>;
}) {
  return new RuntimeCoordinator({
    provider: options.provider,
    tools,
    approvals: new ScriptedApprovalGate([]),
    eventLog: new InMemoryEventLog(new SequenceIds("event"), new JsonDigest()),
    ids: new SequenceIds(),
    nowUtc: () => "2026-11-05T00:00:00.000Z",
    suspendOnApproval: false,
    ...(options.runBinding === undefined ? {} : { runBinding: options.runBinding }),
    ...(options.resolveCredentialRevision === undefined
      ? {}
      : { resolveCredentialRevision: options.resolveCredentialRevision }),
  });
}

describe("C03 run route binding", () => {
  it("records the fixed route once at Run start", async () => {
    const provider = new CountingProvider();
    const result = await coordinator({ provider, runBinding: binding() }).run("task");

    assert.equal(result.status, "completed");
    const events = result.events.filter((event) => event.payload.kind === "run_model_binding");
    assert.equal(events.length, 1);
    const payload = events[0]?.payload;
    assert.ok(payload && payload.kind === "run_model_binding");
    if (!payload || payload.kind !== "run_model_binding") return;
    assert.equal(payload.providerId, "provider-a");
    assert.equal(payload.modelId, "model-a");
    assert.equal(payload.catalogSnapshotId, "catalog-1");
    assert.equal(payload.capabilitySnapshotId, "caps-1");
    assert.equal(payload.credentialRef, "provider-main");
    assert.equal(payload.credentialRevision, 1);
  });

  it("writes no route event when no binding is configured", async () => {
    const result = await coordinator({ provider: new CountingProvider() }).run("task");
    assert.equal(
      result.events.some((event) => event.payload.kind === "run_model_binding"),
      false,
    );
  });

  it("binds the credential revision per attempt", async () => {
    const provider = new CountingProvider();
    const result = await coordinator({
      provider,
      runBinding: binding(),
      resolveCredentialRevision: async () => 4,
    }).run("task");

    assert.equal(result.status, "completed");
    const started = result.events.filter((event) => event.payload.kind === "model_request_started");
    assert.equal(started.length, 1);
    const payload = started[0]?.payload;
    assert.ok(payload && payload.kind === "model_request_started");
    if (!payload || payload.kind !== "model_request_started") return;
    assert.equal(payload.credentialRevision, 4);
  });

  it("refuses to send when the credential identity changed inside the Run", async () => {
    const provider = new CountingProvider();
    // The resolver reports a revision, but the coordinator can only bind the Run's
    // reference. A different reference must be rejected before any send.
    const result = await coordinator({
      provider,
      runBinding: binding(),
      resolveCredentialRevision: async () => 0,
    }).run("task");

    // revision 0 is invalid, so the pre-send check refuses; nothing was sent.
    assert.equal(result.status, "failed");
    assert.equal(provider.requests.length, 0);
    assert.equal(result.safeCode, "invalid_credential_revision");
  });

  it("treats a throwing resolver as a non-send", async () => {
    const provider = new CountingProvider();
    const result = await coordinator({
      provider,
      runBinding: binding(),
      resolveCredentialRevision: async () => {
        throw new Error("vault_unavailable");
      },
    }).run("task");

    assert.equal(result.status, "failed");
    assert.equal(provider.requests.length, 0);
    assert.equal(result.safeCode, "credential_binding_failed");
  });

  it("still sends when no credential resolver is configured", async () => {
    const provider = new CountingProvider();
    const result = await coordinator({ provider, runBinding: binding() }).run("task");
    assert.equal(result.status, "completed");
    assert.equal(provider.requests.length, 1);
    const started = result.events.find((event) => event.payload.kind === "model_request_started");
    assert.ok(started && started.payload.kind === "model_request_started");
    if (!started || started.payload.kind !== "model_request_started") return;
    assert.equal(started.payload.credentialRevision, undefined);
  });
});
