import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  base64Length,
  DEFAULT_NORMALIZE_LIMITS,
  decideNormalization,
  IMAGE_NORMALIZE,
  resizeAttempts,
} from "../../src/domain/media/image-normalize.ts";

/**
 * Image shrink policy.
 *
 * The numbers follow OpenCode's image normalization. The rule these tests protect:
 * a small image is not re-encoded for no gain, and a transparent image is not
 * flattened onto black by a JPEG conversion.
 */

const limits = DEFAULT_NORMALIZE_LIMITS;

describe("decideNormalization", () => {
  it("keeps a small PNG untouched", () => {
    // Re-encoding a small image loses quality for no useful size win.
    const decision = decideNormalization({
      size: { width: 100, height: 100, base64Bytes: 10_000 },
      mediaType: "image/png",
      hasTransparency: false,
    });
    assert.deepEqual(decision, { kind: "keep" });
  });

  it("keeps a small JPEG untouched", () => {
    const decision = decideNormalization({
      size: { width: 100, height: 100, base64Bytes: 10_000 },
      mediaType: "image/jpeg",
      hasTransparency: false,
    });
    assert.deepEqual(decision, { kind: "keep" });
  });

  it("recompresses a large PNG that already fits the dimensions", () => {
    const decision = decideNormalization({
      size: { width: 1_500, height: 1_500, base64Bytes: 2_000_000 },
      mediaType: "image/png",
      hasTransparency: false,
    });
    assert.equal(decision.kind, "recompress");
    if (decision.kind !== "recompress") return;
    assert.equal(decision.quality, IMAGE_NORMALIZE.jpegQualities[0]);
  });

  it("keeps a large PNG with transparency rather than flattening it", () => {
    // JPEG has no alpha; flattening a transparent screenshot onto black is a
    // visible change the user did not ask for.
    const decision = decideNormalization({
      size: { width: 1_500, height: 1_500, base64Bytes: 2_000_000 },
      mediaType: "image/png",
      hasTransparency: true,
    });
    assert.deepEqual(decision, { kind: "keep" });
  });

  it("resizes an image wider than the limit", () => {
    const decision = decideNormalization({
      size: { width: 3_000, height: 2_000, base64Bytes: 500_000 },
      mediaType: "image/png",
      hasTransparency: false,
    });
    assert.equal(decision.kind, "resize");
    if (decision.kind !== "resize") return;
    assert.equal(decision.width, limits.maxWidth);
    assert.equal(decision.height, Math.round((2_000 * limits.maxWidth) / 3_000));
  });

  it("resizes an image taller than the limit", () => {
    const decision = decideNormalization({
      size: { width: 1_000, height: 4_000, base64Bytes: 500_000 },
      mediaType: "image/jpeg",
      hasTransparency: false,
    });
    assert.equal(decision.kind, "resize");
    if (decision.kind !== "resize") return;
    assert.equal(decision.height, limits.maxHeight);
  });

  it("resizes an image whose base64 exceeds the byte limit", () => {
    const decision = decideNormalization({
      size: { width: 500, height: 500, base64Bytes: limits.maxBase64Bytes + 1 },
      mediaType: "image/jpeg",
      hasTransparency: false,
    });
    // It fits the dimensions but not the bytes, so it is resized down.
    assert.equal(decision.kind, "resize");
  });

  it("rejects invalid dimensions", () => {
    for (const size of [
      { width: 0, height: 100, base64Bytes: 10 },
      { width: 100, height: 0, base64Bytes: 10 },
      { width: -1, height: 100, base64Bytes: 10 },
    ]) {
      const decision = decideNormalization({
        size,
        mediaType: "image/png",
        hasTransparency: false,
      });
      assert.deepEqual(decision, { kind: "reject", reason: "dimensions_invalid" });
    }
  });

  it("keeps a tiny PNG by pixel count even above the byte passthrough", () => {
    // A 200x200 PNG is small in pixels; the pixel rule is a second chance for a
    // noisy image that compresses badly.
    const decision = decideNormalization({
      size: { width: 200, height: 200, base64Bytes: 500_000 },
      mediaType: "image/png",
      hasTransparency: false,
    });
    assert.deepEqual(decision, { kind: "keep" });
  });
});

describe("resizeAttempts", () => {
  it("starts at the first scaled size", () => {
    const attempts = resizeAttempts(4_000, 2_000, limits);
    assert.deepEqual(attempts[0], { width: 2_000, height: 1_000 });
  });

  it("shrinks by the step factor each time", () => {
    const attempts = resizeAttempts(4_000, 2_000, limits);
    assert.equal(attempts[1]?.width, Math.floor(2_000 * IMAGE_NORMALIZE.scaleStep));
  });

  it("never repeats a size", () => {
    const attempts = resizeAttempts(100, 100, limits);
    const seen = new Set<string>();
    for (const attempt of attempts) {
      const key = `${attempt.width}x${attempt.height}`;
      assert.equal(seen.has(key), false, key);
      seen.add(key);
    }
  });

  it("terminates at 1x1", () => {
    const attempts = resizeAttempts(4_000, 4_000, limits);
    const last = attempts.at(-1);
    assert.equal(last?.width, 1);
    assert.equal(last?.height, 1);
  });

  it("respects the attempt cap", () => {
    const attempts = resizeAttempts(100_000, 100_000, limits);
    assert.ok(attempts.length <= IMAGE_NORMALIZE.maxResizeAttempts);
  });

  it("returns a single attempt for an image already within the limit", () => {
    const attempts = resizeAttempts(100, 100, limits);
    assert.equal(attempts.length >= 1, true);
    assert.deepEqual(attempts[0], { width: 100, height: 100 });
  });
});

describe("base64Length", () => {
  it("rounds up to a multiple of four", () => {
    assert.equal(base64Length(1), 4);
    assert.equal(base64Length(3), 4);
    assert.equal(base64Length(4), 8);
  });

  it("is zero for zero bytes", () => {
    assert.equal(base64Length(0), 0);
  });
});

describe("limits", () => {
  it("matches the reference numbers", () => {
    assert.equal(IMAGE_NORMALIZE.maxWidth, 2_000);
    assert.equal(IMAGE_NORMALIZE.maxHeight, 2_000);
    assert.equal(IMAGE_NORMALIZE.maxBase64Bytes, 5 * 1024 * 1024);
    assert.deepEqual([...IMAGE_NORMALIZE.jpegQualities], [80, 70, 55, 40]);
  });
});
