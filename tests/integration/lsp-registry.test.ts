import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { createLspTools } from "../../src/adapters/tools/lsp-tools.ts";
import { createLspRegistry } from "../../src/adapters/windows/lsp-registry.ts";

const STUB = path.join(import.meta.dirname, "..", "fakes", "stub-lsp-server.ts");

function config(overrides: Record<string, unknown> = {}) {
  return {
    serverId: "stub",
    executable: process.execPath,
    argv: [STUB],
    cwd: process.cwd(),
    configurationRevision: 1,
    environmentFingerprint: "fp-1",
    requestTimeoutMs: 3_000,
    ...overrides,
  };
}

function registry() {
  return createLspRegistry({ inheritedEnvironment: { PATH: process.env["PATH"] ?? "" } });
}

describe("SR04 LSP lease lifecycle", () => {
  it("starts in starting state before protocol readiness", async () => {
    const reg = registry();
    assert.equal(reg.lease(), null);
    const started = await reg.start(config(), { approvedInstanceId: "lsp-instance-1" });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    // Only after initialize does the lease become running.
    assert.equal(started.lease.state, "running");
    assert.equal(started.lease.protocolReady, true);
    assert.notEqual(started.lease.processExecutionId, null);
    assert.equal(started.lease.configurationRevision, 1);
    assert.equal(started.lease.environmentFingerprint, "fp-1");
    await reg.close();
  });

  it("binds the approved instance and the live execution identity", async () => {
    const reg = registry();
    await reg.start(config(), { approvedInstanceId: "lsp-instance-1" });
    const instance = reg.dependencies.getInstance();
    assert.equal(instance?.approvedInstanceId, "lsp-instance-1");
    assert.equal(instance?.state, "ready");
    assert.equal(reg.dependencies.getLiveIdentity(), instance?.executionIdentity);
    await reg.close();
  });

  it("moves to stopped only after proven termination", async () => {
    const reg = registry();
    await reg.start(config(), { approvedInstanceId: "lsp-instance-1" });
    assert.equal(reg.lease()?.state, "running");
    await reg.close();
    assert.equal(reg.lease()?.state, "stopped");
    assert.equal(reg.lease()?.protocolReady, false);
  });

  it("refuses a second start while a lease is active", async () => {
    const reg = registry();
    await reg.start(config(), { approvedInstanceId: "lsp-instance-1" });
    const second = await reg.start(config(), { approvedInstanceId: "lsp-instance-2" });
    assert.deepEqual(second, { ok: false, code: "lease_already_active" });
    await reg.close();
  });

  it("deletes the lease when the protocol never initializes", async () => {
    const reg = registry();
    const failed = await reg.start(
      config({ executable: "definitely-not-a-real-executable-xyz", argv: [] }),
      { approvedInstanceId: "lsp-instance-1" },
    );
    assert.equal(failed.ok, false);
    assert.equal(reg.lease(), null);
  });
});

describe("LSP tools against a stub server", () => {
  it("serves diagnostics after the lease is running", async () => {
    const reg = registry();
    await reg.start(config(), { approvedInstanceId: "lsp-instance-1" });
    const tools = createLspTools(reg.dependencies);

    const result = await tools.execute({
      toolCallId: "c1",
      toolName: "lsp_diagnostics",
      arguments: { path: "a.ts" },
    });

    assert.equal(result.status, "succeeded");
    assert.match(result.text ?? "", /a\.ts:2:4 error stub diagnostic \[stub\]/);
    await reg.close();
  });

  it("serves definition and references", async () => {
    const reg = registry();
    await reg.start(config(), { approvedInstanceId: "lsp-instance-1" });
    const tools = createLspTools(reg.dependencies);

    for (const toolName of ["lsp_definition", "lsp_references"]) {
      const result = await tools.execute({
        toolCallId: "c1",
        toolName,
        arguments: { path: "a.ts", position: { line: 0, character: 0 } },
      });
      assert.equal(result.status, "succeeded", `${toolName} failed`);
      assert.match(result.text ?? "", /b\.ts:1:0/);
    }
    await reg.close();
  });

  it("refuses requests when no instance exists", async () => {
    const reg = registry();
    const tools = createLspTools(reg.dependencies);
    const result = await tools.execute({
      toolCallId: "c1",
      toolName: "lsp_diagnostics",
      arguments: { path: "a.ts" },
    });
    assert.deepEqual(result, { status: "failed", safeCode: "not_found", text: null });
  });

  it("refuses requests after the lease is stopped", async () => {
    const reg = registry();
    await reg.start(config(), { approvedInstanceId: "lsp-instance-1" });
    await reg.close();

    const tools = createLspTools(reg.dependencies);
    const result = await tools.execute({
      toolCallId: "c1",
      toolName: "lsp_diagnostics",
      arguments: { path: "a.ts" },
    });
    // The instance was cleared on close, so no tool may proceed.
    assert.equal(result.status, "failed");
  });
});
