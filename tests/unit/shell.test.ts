import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FIXED_FILTERED_NAMES,
  filterChildEnvironment,
  formatShellPreview,
  renderShellPreview,
  SHELL_LIMITS,
  validateShellRequest,
} from "../../src/domain/process/shell.ts";

describe("child environment filtering", () => {
  it("removes every fixed credential name", () => {
    const inherited: Record<string, string> = {};
    for (const name of FIXED_FILTERED_NAMES) inherited[name] = "secret-value";
    inherited["PATH"] = "C:\\Windows";

    const result = filterChildEnvironment(inherited);

    assert.deepEqual(result.environment, { PATH: "C:\\Windows" });
    assert.equal(result.removedNames.length, FIXED_FILTERED_NAMES.length);
  });

  it("never exposes removed values", () => {
    const result = filterChildEnvironment({ ANTHROPIC_API_KEY: "sk-very-secret" });
    assert.equal(JSON.stringify(result).includes("sk-very-secret"), false);
  });

  it("also filters the INPUT_ counterpart", () => {
    const result = filterChildEnvironment({ INPUT_ANTHROPIC_API_KEY: "secret" });
    assert.deepEqual(result.environment, {});
    assert.deepEqual(result.removedNames, ["INPUT_ANTHROPIC_API_KEY"]);
  });

  it("matches names case-insensitively", () => {
    const result = filterChildEnvironment({ anthropic_api_key: "secret" });
    assert.deepEqual(result.environment, {});
  });

  it("removes catalog-derived provider credential names", () => {
    const result = filterChildEnvironment(
      { OPENAI_API_KEY: "secret", PATH: "C:\\Windows" },
      {},
      { providerCredentialNames: ["OPENAI_API_KEY"] },
    );
    assert.deepEqual(result.environment, { PATH: "C:\\Windows" });
  });

  it("applies overrides before filtering so an overlay cannot restore a name", () => {
    const result = filterChildEnvironment(
      { PATH: "base" },
      { GITHUB_TOKEN: "restored", PATH: "override" },
    );
    assert.deepEqual(result.environment, { PATH: "override" });
    assert.deepEqual(result.removedNames, ["GITHUB_TOKEN"]);
  });

  it("keeps only explicitly granted names", () => {
    const result = filterChildEnvironment(
      { ANTHROPIC_API_KEY: "secret", PATH: "C:\\Windows" },
      {},
      { grantedNames: ["ANTHROPIC_API_KEY"] },
    );
    assert.deepEqual(result.environment, { ANTHROPIC_API_KEY: "secret", PATH: "C:\\Windows" });
    assert.deepEqual(result.removedNames, []);
  });

  it("reports a grant that matched nothing", () => {
    const result = filterChildEnvironment({}, {}, { grantedNames: ["MISSING_VAR"] });
    assert.deepEqual(result.missingGrantNames, ["MISSING_VAR"]);
  });

  it("does not filter names that merely contain a keyword", () => {
    const result = filterChildEnvironment({ MY_TOKEN_FILE: "value", TOKENIZER: "x" });
    assert.deepEqual(result.environment, { MY_TOKEN_FILE: "value", TOKENIZER: "x" });
  });
});

describe("shell request validation", () => {
  const base = { command: "npm test", cwd: "D:\\repo" };

  it("accepts a valid command with the default timeout", () => {
    const result = validateShellRequest(base, { sessionMode: "workspace_write" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.timeoutMs, SHELL_LIMITS.defaultTimeoutMs);
    assert.deepEqual(result.value.environmentGrants, []);
  });

  it("rejects Shell entirely in a read-only Session", () => {
    assert.deepEqual(validateShellRequest(base, { sessionMode: "read_only" }), {
      ok: false,
      code: "read_only_session",
    });
  });

  it("rejects an empty command or cwd", () => {
    for (const args of [null, {}, { command: " ", cwd: "x" }, { command: "x", cwd: "" }]) {
      assert.deepEqual(validateShellRequest(args, { sessionMode: "workspace_write" }), {
        ok: false,
        code: "invalid_arguments",
      });
    }
  });

  it("enforces the timeout bounds", () => {
    for (const timeoutMs of [0, -1, 999, SHELL_LIMITS.maxTimeoutMs + 1, 1.5]) {
      assert.deepEqual(
        validateShellRequest({ ...base, timeoutMs }, { sessionMode: "workspace_write" }),
        { ok: false, code: "invalid_timeout" },
      );
    }
    const atMin = validateShellRequest(
      { ...base, timeoutMs: SHELL_LIMITS.minTimeoutMs },
      { sessionMode: "workspace_write" },
    );
    assert.equal(atMin.ok, true);
  });

  it("enforces the environment grant bounds", () => {
    const tooMany = Array.from(
      { length: SHELL_LIMITS.maxEnvironmentGrants + 1 },
      (_, index) => `VAR_${index}`,
    );
    assert.deepEqual(
      validateShellRequest(
        { ...base, environmentGrants: tooMany },
        { sessionMode: "workspace_write" },
      ),
      { ok: false, code: "too_many_environment_grants" },
    );
    assert.deepEqual(
      validateShellRequest(
        { ...base, environmentGrants: ["A", "a"] },
        { sessionMode: "workspace_write" },
      ),
      { ok: false, code: "duplicate_environment_grant" },
    );
    assert.deepEqual(
      validateShellRequest(
        { ...base, environmentGrants: [""] },
        { sessionMode: "workspace_write" },
      ),
      { ok: false, code: "invalid_environment_grant" },
    );
  });
});

describe("shell preview", () => {
  it("marks a declared verification command in the preview", () => {
    const validated = validateShellRequest(
      { command: "npm test", cwd: "D:\\repo", verification: true },
      { sessionMode: "workspace_write" },
    );
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const preview = renderShellPreview(validated.value, {
      environment: {},
      removedNames: [],
      missingGrantNames: [],
    });
    assert.match(formatShellPreview(preview), /purpose=declared verification command/);
  });

  it("shows the normalized timeout and redacted grant names", () => {
    const validated = validateShellRequest(
      { command: "npm test", cwd: "D:\\repo", timeoutMs: 5000, environmentGrants: ["B", "A"] },
      { sessionMode: "workspace_write" },
    );
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const filter = filterChildEnvironment({ ANTHROPIC_API_KEY: "secret", PATH: "x" });
    const preview = renderShellPreview(validated.value, filter);
    assert.equal(preview.timeoutMs, 5000);
    assert.deepEqual(preview.grantedVariableNames, ["A", "B"]);
    assert.equal(preview.filteredVariableCount, 1);

    const text = formatShellPreview(preview);
    assert.match(text, /command=npm test/);
    assert.match(text, /timeoutMs=5000/);
    assert.match(text, /envGrants=A,B/);
    assert.match(text, /filteredEnv=1 name\(s\) removed/);
    assert.match(text, /sandbox=none/);
    assert.equal(text.includes("secret"), false);
  });
});
