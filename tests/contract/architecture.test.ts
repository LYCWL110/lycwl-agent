import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  findBoundaryViolations,
  findPolicyViolations,
  listSourceModules,
} from "../../tools/architecture-boundary.ts";

const SOURCE_ROOT = path.resolve("src");

describe("architecture dependency boundaries", () => {
  it("keeps the current source tree within the selected boundaries", async () => {
    const modules = await listSourceModules(SOURCE_ROOT);
    assert.ok(modules.length > 0, "architecture scan must inspect at least one source module");
    assert.deepEqual(findBoundaryViolations(modules), []);
  });

  it("keeps pure layers free of ambient access and non-executing layers free of process use", async () => {
    const modules = await listSourceModules(SOURCE_ROOT);
    assert.deepEqual(findPolicyViolations(modules), []);
  });

  it("rejects runtime imports from domain code", () => {
    const violations = findBoundaryViolations([
      {
        path: path.join("domain", "example.ts"),
        source: 'import { readFile } from "node:fs/promises";',
      },
    ]);
    assert.deepEqual(violations, [
      `${path.join("domain", "example.ts")} imports runtime module "node:fs/promises"`,
    ]);
  });

  it("rejects a reverse dependency from application to an adapter", () => {
    const violations = findBoundaryViolations([
      {
        path: path.join("application", "example.ts"),
        source: 'import "../adapters/provider/example.ts";',
      },
    ]);
    assert.deepEqual(violations, [
      `${path.join("application", "example.ts")} imports forbidden "../adapters/provider/example.ts"`,
    ]);
  });

  it("rejects a reverse dependency from an adapter to application", () => {
    const violations = findBoundaryViolations([
      {
        path: path.join("adapters", "persistence", "example.ts"),
        source: 'import "../../application/coordinator/example.ts";',
      },
    ]);
    assert.deepEqual(violations, [
      `${path.join("adapters", "persistence", "example.ts")} imports forbidden "../../application/coordinator/example.ts"`,
    ]);
  });

  it("rejects a relative import that escapes the src root", () => {
    const violations = findBoundaryViolations([
      {
        path: path.join("adapters", "persistence", "example.ts"),
        source: 'import "../../../application/coordinator/example.ts";',
      },
    ]);
    assert.deepEqual(violations, [
      `${path.join("adapters", "persistence", "example.ts")} imports outside the source root "../../../application/coordinator/example.ts"`,
    ]);
  });

  it("rejects a relative import cycle", () => {
    const first = path.join("domain", "first.ts");
    const second = path.join("domain", "second.ts");
    const violations = findBoundaryViolations([
      { path: first, source: 'import "./second.ts";' },
      { path: second, source: 'import "./first.ts";' },
    ]);
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /^dependency cycle: /);
  });
});

describe("pure and non-executing layer policy", () => {
  it("rejects process.env in a domain module", () => {
    const violations = findPolicyViolations([
      { path: path.join("domain", "example.ts"), source: "const x = process.env.X;" },
    ]);
    assert.deepEqual(violations, [
      path.join("domain", "example.ts") + " uses process.env in a pure layer",
    ]);
  });

  it("rejects an ambient clock in a domain module", () => {
    const violations = findPolicyViolations([
      { path: path.join("domain", "example.ts"), source: "const t = Date.now();" },
    ]);
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /Date\.now/);
  });

  it("rejects randomness in a ports module", () => {
    const violations = findPolicyViolations([
      { path: path.join("ports", "example.ts"), source: "const r = Math.random();" },
    ]);
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /Math\.random/);
  });

  it("allows ambient access in an adapter", () => {
    const violations = findPolicyViolations([
      {
        path: path.join("adapters", "example.ts"),
        source: "const x = process.env.X + Date.now();",
      },
    ]);
    assert.deepEqual(violations, []);
  });

  it("rejects child_process in the TUI", () => {
    const violations = findPolicyViolations([
      {
        path: path.join("tui", "example.ts"),
        source: 'import { spawn } from "node:child_process";',
      },
    ]);
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? "", /child_process/);
  });

  it("allows child_process in an adapter, which is where process execution belongs", () => {
    const violations = findPolicyViolations([
      {
        path: path.join("adapters", "example.ts"),
        source: 'import { spawn } from "node:child_process";',
      },
    ]);
    assert.deepEqual(violations, []);
  });
});
