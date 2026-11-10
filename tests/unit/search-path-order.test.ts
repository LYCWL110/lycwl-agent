import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compareSearchPaths,
  normalizeSearchPath,
  sortSearchPaths,
} from "../../src/domain/search/path-order.ts";

describe("deterministic search path order", () => {
  it("normalizes separators and trims edge slashes", () => {
    assert.equal(normalizeSearchPath("\\src\\\\a.ts\\"), "src/a.ts");
    assert.equal(normalizeSearchPath("src/a.ts"), "src/a.ts");
  });

  it("places ancestors before descendants", () => {
    assert.equal(compareSearchPaths("src", "src/a.ts") < 0, true);
    assert.equal(compareSearchPaths("src/a.ts", "src/b/c.ts") < 0, true);
  });

  it("compares by code point, not locale", () => {
    // Uppercase letters precede lowercase in code point order.
    assert.equal(compareSearchPaths("A.ts", "a.ts") < 0, true);
    // 'Z' (0x5A) precedes 'a' (0x61) regardless of locale collation.
    assert.equal(compareSearchPaths("Z.ts", "a.ts") < 0, true);
  });

  it("sorts a mixed list deterministically", () => {
    const sorted = sortSearchPaths(["src/z.ts", "src/a.ts", "README.md", "src", "src/nested/b.ts"]);
    assert.deepEqual(sorted, ["README.md", "src", "src/a.ts", "src/nested/b.ts", "src/z.ts"]);
  });

  it("does not mutate the input array", () => {
    const input = ["b", "a"];
    sortSearchPaths(input);
    assert.deepEqual(input, ["b", "a"]);
  });
});
