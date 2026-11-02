import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  findBoundaryViolations,
  listSourceModules,
} from "../../tools/architecture-boundary.ts";

const SOURCE_ROOT = path.resolve("src");

describe("architecture dependency boundaries", () => {
  it("keeps the current source tree within the selected boundaries", async () => {
    const modules = await listSourceModules(SOURCE_ROOT);
    assert.ok(modules.length > 0, "architecture scan must inspect at least one source module");
    assert.deepEqual(findBoundaryViolations(modules), []);
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
