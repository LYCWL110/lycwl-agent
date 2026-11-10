import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  bindAttempt,
  createRunModelBinding,
  type DisclosureConsent,
  decideDisclosure,
  describeEndpoint,
  endpointFingerprintInput,
  formatDisclosurePreview,
  type RunModelBinding,
} from "../../src/domain/model-request/run-binding.ts";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const HEX = sha256("x");

function endpoint() {
  const described = describeEndpoint({ host: "API.Example.COM", port: null, path: "/v1/messages" });
  assert.equal(described.ok, true);
  if (!described.ok) throw new Error("endpoint");
  return described.value;
}

function binding(
  overrides: Partial<Parameters<typeof createRunModelBinding>[0]> = {},
): RunModelBinding {
  const ep = endpoint();
  const result = createRunModelBinding({
    providerId: "provider-a",
    modelId: "model-a",
    protocolId: "protocol-a",
    adapterVersion: "adapter-1",
    endpoint: ep,
    endpointFingerprint: sha256(endpointFingerprintInput(ep)),
    catalog: { snapshotId: "catalog-1", sha256: HEX },
    capabilities: { snapshotId: "caps-1", sha256: sha256("caps") },
    credential: { credentialRef: "provider-main", revision: 1 },
    ...overrides,
  });
  // Asserting separately keeps the narrow usable below; the assert itself already
  // fails the test on a refusal.
  if (result.ok === false) throw new Error("binding should be valid");
  return result.value;
}

describe("endpoint description", () => {
  it("lowercases the host and keeps scheme/port/path", () => {
    const ep = endpoint();
    assert.deepEqual(ep, {
      scheme: "https",
      host: "api.example.com",
      port: null,
      path: "/v1/messages",
    });
  });

  it("defaults an empty path to the root", () => {
    const described = describeEndpoint({ host: "h", port: 443, path: "" });
    assert.equal(described.ok, true);
    if (!described.ok) return;
    assert.equal(described.value.path, "/");
  });

  it("rejects a query string, fragment, userinfo or relative path", () => {
    for (const input of [
      { host: "h", port: null, path: "/x?key=secret" },
      { host: "h", port: null, path: "/x#frag" },
      { host: "user:pw@h", port: null, path: "/" },
      { host: "h/sub", port: null, path: "/" },
      { host: "", port: null, path: "/" },
      { host: "h", port: 0, path: "/" },
      { host: "h", port: 70_000, path: "/" },
      { host: "h", port: null, path: "relative" },
    ]) {
      const described = describeEndpoint(input);
      assert.deepEqual(described, { ok: false, code: "invalid_endpoint" }, JSON.stringify(input));
    }
  });

  it("never lets a query string into the fingerprint input", () => {
    // Two endpoints differing only by a credential-bearing query share a
    // fingerprint on purpose: the query is dropped before hashing.
    const a = describeEndpoint({ host: "h", port: null, path: "/v1" });
    assert.equal(a.ok, true);
    if (!a.ok) return;
    assert.equal(endpointFingerprintInput(a.value).includes("?"), false);
  });
});

describe("run model binding", () => {
  it("accepts a complete binding", () => {
    const value = binding();
    assert.equal(value.providerId, "provider-a");
    assert.equal(value.credential.credentialRef, "provider-main");
  });

  it("rejects missing identity fields", () => {
    assert.equal(createRunModelBinding({ ...validInput(), providerId: "" }).ok, false);
    assert.equal(createRunModelBinding({ ...validInput(), modelId: "" }).ok, false);
    assert.equal(createRunModelBinding({ ...validInput(), protocolId: "" }).ok, false);
    assert.equal(createRunModelBinding({ ...validInput(), adapterVersion: "" }).ok, false);
  });

  it("rejects a non-hex endpoint fingerprint", () => {
    const result = createRunModelBinding({ ...validInput(), endpointFingerprint: "not-a-hash" });
    assert.deepEqual(result, { ok: false, code: "invalid_fingerprint" });
  });

  it("rejects a malformed snapshot identity", () => {
    const result = createRunModelBinding({
      ...validInput(),
      catalog: { snapshotId: "c", sha256: "short" },
    });
    assert.deepEqual(result, { ok: false, code: "invalid_snapshot" });
  });

  it("rejects an empty credential reference or a zero revision", () => {
    assert.equal(
      createRunModelBinding({ ...validInput(), credential: { credentialRef: "", revision: 1 } }).ok,
      false,
    );
    assert.equal(
      createRunModelBinding({ ...validInput(), credential: { credentialRef: "r", revision: 0 } })
        .ok,
      false,
    );
  });
});

describe("attempt binding", () => {
  it("binds the run route and the given credential revision", () => {
    const runBinding = binding();
    const bound = bindAttempt(runBinding, {
      modelRequestId: "req-1",
      attemptNo: 2,
      credential: { credentialRef: "provider-main", revision: 3 },
    });
    assert.equal(bound.ok, true);
    if (!bound.ok) return;
    assert.equal(bound.value.attemptNo, 2);
    assert.equal(bound.value.credential.revision, 3);
    assert.equal(bound.value.route.providerId, "provider-a");
    assert.equal(bound.value.route.endpointFingerprint, runBinding.endpointFingerprint);
  });

  it("allows a revision advance for the same reference", () => {
    const bound = bindAttempt(binding(), {
      modelRequestId: "req-1",
      attemptNo: 2,
      credential: { credentialRef: "provider-main", revision: 7 },
    });
    assert.equal(bound.ok, true);
  });

  it("refuses a different credential reference inside a Run", () => {
    const bound = bindAttempt(binding(), {
      modelRequestId: "req-1",
      attemptNo: 1,
      credential: { credentialRef: "provider-other", revision: 1 },
    });
    assert.deepEqual(bound, { ok: false, code: "credential_identity_changed" });
  });

  it("refuses an invalid attempt identity", () => {
    const runBinding = binding();
    assert.equal(
      bindAttempt(runBinding, {
        modelRequestId: "",
        attemptNo: 1,
        credential: runBinding.credential,
      }).ok,
      false,
    );
    assert.equal(
      bindAttempt(runBinding, {
        modelRequestId: "r",
        attemptNo: 0,
        credential: runBinding.credential,
      }).ok,
      false,
    );
  });
});

describe("sensitive disclosure consent", () => {
  const runBinding = binding();
  const consent: DisclosureConsent = {
    destination: {
      providerId: runBinding.providerId,
      modelId: runBinding.modelId,
      endpointFingerprint: runBinding.endpointFingerprint,
    },
    credential: { credentialRef: "provider-main", revision: 1 },
    coveredSourceIds: ["s1", "s2"],
  };

  it("allows exactly the covered sources under the same destination and identity", () => {
    assert.deepEqual(
      decideDisclosure({
        consent,
        binding: runBinding,
        currentCredential: { credentialRef: "provider-main", revision: 5 },
        requestedSourceIds: ["s2", "s1"],
      }),
      { allowed: true },
    );
  });

  it("blocks when there is no consent", () => {
    const decision = decideDisclosure({
      consent: null,
      binding: runBinding,
      currentCredential: runBinding.credential,
      requestedSourceIds: ["s1"],
    });
    assert.equal(decision.allowed, false);
    if (decision.allowed) return;
    assert.equal(decision.reason, "no_consent");
    assert.deepEqual(decision.missingSourceIds, ["s1"]);
  });

  it("blocks when the destination changed", () => {
    const other = binding({ modelId: "model-b" });
    const decision = decideDisclosure({
      consent,
      binding: other,
      currentCredential: other.credential,
      requestedSourceIds: ["s1"],
    });
    assert.equal(decision.allowed, false);
    if (decision.allowed) return;
    assert.equal(decision.reason, "destination_changed");
  });

  it("blocks when the credential reference changed even for the same provider", () => {
    // ADR-0008: a different reference may be a different account.
    const decision = decideDisclosure({
      consent,
      binding: runBinding,
      currentCredential: { credentialRef: "provider-secondary", revision: 1 },
      requestedSourceIds: ["s1"],
    });
    assert.equal(decision.allowed, false);
    if (decision.allowed) return;
    assert.equal(decision.reason, "credential_identity_changed");
  });

  it("blocks an uncovered source and names it", () => {
    const decision = decideDisclosure({
      consent,
      binding: runBinding,
      currentCredential: runBinding.credential,
      requestedSourceIds: ["s1", "s3"],
    });
    assert.equal(decision.allowed, false);
    if (decision.allowed) return;
    assert.equal(decision.reason, "source_not_covered");
    assert.deepEqual(decision.missingSourceIds, ["s3"]);
  });

  it("renders a preview without any secret value", () => {
    const preview = formatDisclosurePreview({
      binding: runBinding,
      credential: { credentialRef: "provider-main", revision: 4 },
      sourceIds: ["s2", "s1"],
    });
    assert.match(preview, /provider=provider-a/);
    assert.match(preview, /credentialRef=provider-main/);
    assert.match(preview, /credentialRevision=4/);
    assert.match(preview, /covers=s1,s2/);
    assert.match(preview, /consent covers only the material shown/);
  });
});

function validInput() {
  const ep = endpoint();
  return {
    providerId: "p",
    modelId: "m",
    protocolId: "pr",
    adapterVersion: "a",
    endpoint: ep,
    endpointFingerprint: sha256(endpointFingerprintInput(ep)),
    catalog: { snapshotId: "c", sha256: HEX },
    capabilities: { snapshotId: "k", sha256: HEX },
    credential: { credentialRef: "r", revision: 1 },
  };
}
