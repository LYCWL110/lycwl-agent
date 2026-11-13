import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CASE_MANIFESTS, currentHash, manifestFor } from "./case-manifest.ts";

/**
 * The manifests describe the fixtures, so they must agree with what is on disk.
 *
 * A manifest whose hash no longer matches its fixture is worse than no manifest: it
 * would let a sample claim to start from a frozen state that no longer exists.
 */

describe("case manifests", () => {
  it("covers E01 through E06", () => {
    assert.deepEqual(
      CASE_MANIFESTS.map((manifest) => manifest.caseId),
      ["E01", "E02", "E03", "E04", "E05", "E06"],
    );
  });

  it("every recorded hash still matches the file on disk", () => {
    for (const manifest of CASE_MANIFESTS) {
      for (const [relative, recorded] of Object.entries(manifest.initialHashes)) {
        assert.equal(
          currentHash(manifest.caseId, relative),
          recorded,
          `${manifest.caseId} ${relative} changed since the manifest was written`,
        );
      }
    }
  });

  it("a mutable file is also listed as visible", () => {
    // The model must be able to read what it is asked to change.
    for (const manifest of CASE_MANIFESTS) {
      for (const mutable of manifest.mutableFiles) {
        assert.equal(
          manifest.visibleFiles.includes(mutable),
          true,
          `${manifest.caseId}: ${mutable} is mutable but not visible`,
        );
      }
    }
  });

  it("a verifier file is never visible", () => {
    // A hidden assertion that the model can read is not hidden.
    for (const manifest of CASE_MANIFESTS) {
      for (const verifier of manifest.verifierFiles) {
        assert.equal(
          manifest.visibleFiles.includes(verifier),
          false,
          `${manifest.caseId}: ${verifier} is a verifier but is visible`,
        );
      }
    }
  });

  it("every case names at least one assertion", () => {
    for (const manifest of CASE_MANIFESTS) {
      const total = manifest.failToPass.length + manifest.passToPass.length;
      assert.ok(total > 0, manifest.caseId);
    }
  });

  it("only E03 and E04 have no FAIL_TO_PASS", () => {
    // E03 has no defect by design, and E04 measures a submission rather than a fix.
    for (const manifest of CASE_MANIFESTS) {
      const expectedEmpty = manifest.caseId === "E03" || manifest.caseId === "E04";
      assert.equal(
        manifest.failToPass.length === 0,
        expectedEmpty,
        `${manifest.caseId}: unexpected FAIL_TO_PASS set`,
      );
    }
  });

  it("every case names a first branch", () => {
    for (const manifest of CASE_MANIFESTS) {
      assert.ok(manifest.firstBranch.length > 0, manifest.caseId);
    }
  });

  it("E05 keeps the UI package immutable", () => {
    // The root AGENTS.md forbids touching it, and the verifier checks it.
    assert.equal(manifestFor("E05").immutableFiles.includes("packages/ui/src/card.ts"), true);
  });

  it("E06 names the file with a space and Chinese characters", () => {
    // The whole point of the case: a path the tooling must handle correctly.
    assert.equal(manifestFor("E06").mutableFiles.includes("src/中文 路径/labels.ts"), true);
  });

  it("rejects an unknown case id", () => {
    assert.throws(() => manifestFor("E99" as never));
  });
});
