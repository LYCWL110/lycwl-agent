import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateIgnore,
  evaluateIgnoreWithAncestors,
  parseIgnoreFile,
} from "../../src/domain/search/ignore-rules.ts";

function rules(ignore: string, gitignore = "") {
  return [
    ...parseIgnoreFile(".gitignore", "", gitignore),
    ...parseIgnoreFile(".ignore", "", ignore),
  ];
}

describe("gitignore-style ignore rules", () => {
  it("skips blank lines and comments", () => {
    assert.deepEqual(parseIgnoreFile(".ignore", "", "\n# comment\n\n"), []);
  });

  it("matches a bare pattern at any depth", () => {
    const set = rules("*.log");
    assert.equal(evaluateIgnore(set, "a.log").ignored, true);
    assert.equal(evaluateIgnore(set, "deep/nested/b.log").ignored, true);
    assert.equal(evaluateIgnore(set, "keep.txt").ignored, false);
  });

  it("treats a pattern containing a slash as anchored", () => {
    const set = rules("build/output");
    assert.equal(evaluateIgnore(set, "build/output").ignored, true);
    assert.equal(evaluateIgnore(set, "nested/build/output").ignored, false);
  });

  it("honours directory-only patterns", () => {
    const set = rules("dist/");
    assert.equal(evaluateIgnore(set, "dist").ignored, true);
    assert.equal(evaluateIgnore(set, "dist").rule?.directoryOnly, true);
  });

  it("supports negation at the same depth", () => {
    const set = rules("*.log\n!keep.log");
    assert.equal(evaluateIgnore(set, "a.log").ignored, true);
    assert.equal(evaluateIgnore(set, "keep.log").ignored, false);
  });

  it("does not let a negation re-include a file under an excluded directory", () => {
    const set = rules("vendor/\n!vendor/keep.txt");
    assert.equal(evaluateIgnoreWithAncestors(set, "vendor/keep.txt").ignored, true);
  });

  it("lets .ignore outrank .gitignore at equal depth", () => {
    const set = rules("!a.txt", "a.txt");
    assert.equal(evaluateIgnore(set, "a.txt").ignored, false);
    assert.equal(evaluateIgnore(set, "a.txt").reason, "ignore_file");
  });

  it("lets a deeper rule win over a shallower one", () => {
    const set = [
      ...parseIgnoreFile(".ignore", "", "*.tmp"),
      ...parseIgnoreFile(".ignore", "src", "!keep.tmp"),
    ];
    assert.equal(evaluateIgnore(set, "other/a.tmp").ignored, true);
    assert.equal(evaluateIgnore(set, "src/keep.tmp").ignored, false);
  });

  it("supports ** across directories", () => {
    const set = rules("**/generated");
    assert.equal(evaluateIgnore(set, "generated").ignored, true);
    assert.equal(evaluateIgnore(set, "a/b/generated").ignored, true);
  });

  it("reports which source produced the verdict", () => {
    const set = rules("", "*.bak");
    const verdict = evaluateIgnore(set, "file.bak");
    assert.equal(verdict.ignored, true);
    assert.equal(verdict.reason, "gitignore_file");
  });
});
