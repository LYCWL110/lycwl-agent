import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allowFilteredName,
  commitConfiguration,
  createEnvConfiguration,
  ENV_LIMITS,
  type EnvConfiguration,
  fingerprintEnvironment,
  resolveEnvironment,
  setVariable,
  unsetVariable,
} from "../../src/domain/config/environment.ts";

function set(
  config: EnvConfiguration,
  name: string,
  source: Parameters<typeof setVariable>[2],
): EnvConfiguration {
  const result = setVariable(config, name, source);
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

function unset(config: EnvConfiguration, name: string): EnvConfiguration {
  const result = unsetVariable(config, name);
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

function allow(config: EnvConfiguration, name: string): EnvConfiguration {
  const result = allowFilteredName(config, name);
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

const noSecrets = { resolveToolSecret: async () => null };

describe("typed environment sources", () => {
  it("accepts literal, parent and tool-secret sources", () => {
    let config = createEnvConfiguration("lsp-typescript");
    config = set(config, "NODE_ENV", { kind: "literal", value: "production" });
    config = set(config, "PATH", { kind: "parent", name: "PATH" });
    config = set(config, "TOKEN", { kind: "tool_secret", reference: "lsp-token" });

    assert.deepEqual(
      config.set.map((entry) => `${entry.name}:${entry.source.kind}`),
      ["NODE_ENV:literal", "PATH:parent", "TOKEN:tool_secret"],
    );
  });

  it("rejects an empty name, an equals sign and control characters", () => {
    const config = createEnvConfiguration("c");
    for (const name of ["", "A=B", "BAD\u0000NAME", "x".repeat(ENV_LIMITS.maxNameLength + 1)]) {
      assert.deepEqual(setVariable(config, name, { kind: "literal", value: "v" }), {
        ok: false,
        code: "invalid_name",
      });
    }
  });

  it("treats case variants as the same name within one layer", () => {
    let config = createEnvConfiguration("c");
    config = set(config, "PATH", { kind: "literal", value: "a" });
    assert.deepEqual(setVariable(config, "Path", { kind: "literal", value: "b" }), {
      ok: false,
      code: "duplicate_name",
    });
  });

  it("rejects a set/unset conflict in both directions", () => {
    let config = createEnvConfiguration("c");
    config = unset(config, "TOKEN");
    assert.deepEqual(setVariable(config, "TOKEN", { kind: "literal", value: "v" }), {
      ok: false,
      code: "set_unset_conflict",
    });

    let other = createEnvConfiguration("c");
    other = set(other, "PATH", { kind: "literal", value: "v" });
    assert.deepEqual(unsetVariable(other, "path"), { ok: false, code: "set_unset_conflict" });
  });

  it("treats unsetting the same name twice as idempotent", () => {
    let config = createEnvConfiguration("c");
    config = unset(config, "TOKEN");
    config = unset(config, "token");
    assert.deepEqual(config.unset, ["TOKEN"]);
  });

  it("rejects an empty tool-secret reference", () => {
    assert.deepEqual(
      setVariable(createEnvConfiguration("c"), "TOKEN", {
        kind: "tool_secret",
        reference: "",
      }),
      { ok: false, code: "invalid_reference" },
    );
  });

  it("enforces the entry limit", () => {
    let config = createEnvConfiguration("c");
    for (let index = 0; index < ENV_LIMITS.maxEntries; index += 1) {
      config = set(config, `V${index}`, { kind: "literal", value: "x" });
    }
    assert.deepEqual(setVariable(config, "EXTRA", { kind: "literal", value: "x" }), {
      ok: false,
      code: "too_many_entries",
    });
  });
});

describe("environment resolution", () => {
  it("merges parent, configured literals and unset", async () => {
    let config = createEnvConfiguration("c");
    config = set(config, "APP_MODE", { kind: "literal", value: "test" });
    config = unset(config, "LEGACY");

    const resolved = await resolveEnvironment(config, {
      parent: { PATH: "C:\\Windows", LEGACY: "yes", KEEP: "ok" },
      ...noSecrets,
      filteredNames: [],
    });

    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.deepEqual(resolved.value.environment, {
      PATH: "C:\\Windows",
      KEEP: "ok",
      APP_MODE: "test",
    });
  });

  it("resolves a same-name parent source", async () => {
    let config = createEnvConfiguration("c");
    config = set(config, "COPY", { kind: "parent", name: "ORIGINAL" });

    const resolved = await resolveEnvironment(config, {
      parent: { ORIGINAL: "value" },
      ...noSecrets,
      filteredNames: [],
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.value.environment["COPY"], "value");
  });

  it("reports a parent source that does not exist instead of falling back", async () => {
    let config = createEnvConfiguration("c");
    config = set(config, "COPY", { kind: "parent", name: "MISSING" });

    const resolved = await resolveEnvironment(config, {
      parent: {},
      ...noSecrets,
      filteredNames: [],
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.deepEqual(resolved.value.unresolvedNames, ["COPY"]);
    assert.equal(resolved.value.environment["COPY"], undefined);
  });

  it("resolves a tool-secret reference through the injected boundary", async () => {
    let config = createEnvConfiguration("c");
    config = set(config, "TOKEN", { kind: "tool_secret", reference: "lsp-token" });

    const resolved = await resolveEnvironment(config, {
      parent: {},
      resolveToolSecret: async (reference) =>
        reference === "lsp-token" ? "resolved-secret" : null,
      filteredNames: [],
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.value.environment["TOKEN"], "resolved-secret");
  });

  it("drops a filtered name that is not authorized for this configuration", async () => {
    let config = createEnvConfiguration("c");
    config = set(config, "GITHUB_TOKEN", { kind: "literal", value: "from-parent" });

    const resolved = await resolveEnvironment(config, {
      parent: { SAFE: "keep" },
      ...noSecrets,
      filteredNames: ["GITHUB_TOKEN"],
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.deepEqual(resolved.value.filteredNames, ["GITHUB_TOKEN"]);
    assert.deepEqual(resolved.value.environment, { SAFE: "keep" });
  });

  it("keeps a filtered name only with an explicit allowFiltered authorization", async () => {
    let config = createEnvConfiguration("c");
    config = set(config, "GITHUB_TOKEN", { kind: "literal", value: "authorized" });
    config = allow(config, "github_token");

    const resolved = await resolveEnvironment(config, {
      parent: {},
      ...noSecrets,
      filteredNames: ["GITHUB_TOKEN"],
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.deepEqual(resolved.value.environment, { GITHUB_TOKEN: "authorized" });
    assert.deepEqual(resolved.value.filteredNames, []);
  });

  it("still filters the INPUT_ counterpart unless that exact name is authorized", async () => {
    let config = createEnvConfiguration("c");
    config = set(config, "INPUT_GITHUB_TOKEN", { kind: "literal", value: "v" });
    config = allow(config, "GITHUB_TOKEN");

    const resolved = await resolveEnvironment(config, {
      parent: {},
      ...noSecrets,
      filteredNames: ["GITHUB_TOKEN"],
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    // Authorizing GITHUB_TOKEN does not authorize INPUT_GITHUB_TOKEN.
    assert.deepEqual(resolved.value.filteredNames, ["INPUT_GITHUB_TOKEN"]);
  });

  it("never restores a filtered name through an unset-then-set sequence", async () => {
    let config = createEnvConfiguration("c");
    config = unset(config, "GITHUB_TOKEN");
    // Setting it afterwards is a conflict, so the only path is a fresh config.
    assert.deepEqual(setVariable(config, "GITHUB_TOKEN", { kind: "literal", value: "restored" }), {
      ok: false,
      code: "set_unset_conflict",
    });
  });
});

describe("revision and fingerprints", () => {
  it("creates a configuration at revision zero and increments on save", () => {
    const draft = createEnvConfiguration("c");
    assert.equal(draft.revision, 0);
    const saved = commitConfiguration(draft);
    assert.equal(saved.revision, 1);
    assert.equal(commitConfiguration(saved).revision, 2);
  });

  it("fingerprints names and values without exposing the values", () => {
    const digest = (value: string) => `h(${value.length})`;
    const fingerprint = fingerprintEnvironment({ TOKEN: "secret-value", PATH: "C:\\" }, digest);
    assert.deepEqual(Object.keys(fingerprint), ["PATH", "TOKEN"]);
    assert.equal(JSON.stringify(fingerprint).includes("secret-value"), false);
  });

  it("produces the same fingerprint for the same environment", () => {
    const digest = (value: string) => value;
    const first = fingerprintEnvironment({ A: "1", B: "2" }, digest);
    const second = fingerprintEnvironment({ B: "2", A: "1" }, digest);
    assert.deepEqual(first, second);
  });
});
