/**
 * Image normalization policy.
 *
 * A pasted screenshot is often 3000+ pixels wide and several megabytes, which is
 * both expensive to send and larger than most providers accept. Refusing it means
 * the user has to resize by hand before the agent can look at it. This module holds
 * the policy for shrinking it instead.
 *
 * The numbers follow OpenCode's `image/photon-normalize.ts`:
 *
 * - 2000x2000 and 5 MiB base64 are the limits.
 * - A PNG that already fits is left alone when it is small, because re-encoding a
 *   small PNG to JPEG loses quality for no useful size win.
 * - An image that does not fit is scaled down in 0.75 steps and re-encoded as JPEG
 *   at decreasing quality, stopping at the first result that fits.
 * - Transparency blocks the JPEG path: JPEG has no alpha channel, and flattening a
 *   transparent screenshot onto black is a visible change the user did not ask for.
 *
 * The policy is data, not behavior. The adapter that runs PowerShell embeds these
 * numbers in its script, so a change here changes the script without touching the
 * execution path.
 */

export const IMAGE_NORMALIZE = Object.freeze({
  /** Largest width or height sent to a provider. */
  maxWidth: 2_000,
  maxHeight: 2_000,
  /** Limit on the base64 payload, not the raw bytes. */
  maxBase64Bytes: 5 * 1024 * 1024,
  /** A PNG at or below this size is passed through even if it could shrink. */
  pngPassthroughMaxBase64Bytes: 384 * 1024,
  /** A PNG at or below this pixel count is passed through. */
  smallPngMaxPixels: 256 * 256,
  /** Scale factor applied per attempt when an image does not fit. */
  scaleStep: 0.75,
  /** Attempts before giving up; 0.75^32 is far below any real limit. */
  maxResizeAttempts: 32,
  /** JPEG qualities tried in order. */
  jpegQualities: [80, 70, 55, 40] as const,
  /** Alpha samples above this fraction keep the image out of the JPEG path. */
  transparencyFraction: 0.05,
  /** Grid used to sample alpha, so a huge image is not scanned in full. */
  transparencyGrid: 64,
});

export type NormalizeLimits = Readonly<{
  maxWidth: number;
  maxHeight: number;
  maxBase64Bytes: number;
}>;

export const DEFAULT_NORMALIZE_LIMITS: NormalizeLimits = {
  maxWidth: IMAGE_NORMALIZE.maxWidth,
  maxHeight: IMAGE_NORMALIZE.maxHeight,
  maxBase64Bytes: IMAGE_NORMALIZE.maxBase64Bytes,
};

export type ImageSize = Readonly<{ width: number; height: number; base64Bytes: number }>;

export type NormalizeDecision =
  | Readonly<{ kind: "keep" }>
  | Readonly<{ kind: "resize"; width: number; height: number }>
  | Readonly<{ kind: "recompress"; quality: number }>
  | Readonly<{ kind: "reject"; reason: "too_large_after_resize" | "dimensions_invalid" }>;

/**
 * Decide what to do with an image before sending it.
 *
 * The order matters and mirrors the reference: a small PNG that fits is left alone,
 * a fitting image is only recompressed when that actually makes it smaller, and an
 * image that does not fit is resized first.
 */
export function decideNormalization(input: {
  size: ImageSize;
  mediaType: string;
  /** True when more than the threshold of sampled pixels are transparent. */
  hasTransparency: boolean;
  limits?: NormalizeLimits;
}): NormalizeDecision {
  const limits = input.limits ?? DEFAULT_NORMALIZE_LIMITS;
  const { width, height, base64Bytes } = input.size;
  if (width <= 0 || height <= 0) return { kind: "reject", reason: "dimensions_invalid" };

  const fits =
    width <= limits.maxWidth && height <= limits.maxHeight && base64Bytes <= limits.maxBase64Bytes;
  const smallPng =
    base64Bytes <= IMAGE_NORMALIZE.pngPassthroughMaxBase64Bytes ||
    width * height <= IMAGE_NORMALIZE.smallPngMaxPixels;

  if (fits && (input.mediaType !== "image/png" || smallPng)) return { kind: "keep" };

  if (fits) {
    // It fits but is a large PNG. JPEG only helps when there is no alpha to lose.
    return input.hasTransparency
      ? { kind: "keep" }
      : { kind: "recompress", quality: IMAGE_NORMALIZE.jpegQualities[0] };
  }

  const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  // A target that is still enormous means the limits are unusable, not that the
  // image is bad; rejecting is honest rather than looping.
  if (targetWidth > limits.maxWidth || targetHeight > limits.maxHeight) {
    return { kind: "reject", reason: "too_large_after_resize" };
  }
  return { kind: "resize", width: targetWidth, height: targetHeight };
}

/**
 * The successive sizes to try, starting from the first scaled target.
 *
 * Each step is 0.75 of the previous, deduplicated, and stops once both dimensions
 * reach 1. The list is finite so a caller can iterate it without a loop guard.
 */
export function resizeAttempts(
  width: number,
  height: number,
  limits: NormalizeLimits = DEFAULT_NORMALIZE_LIMITS,
): readonly Readonly<{ width: number; height: number }>[] {
  const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height);
  const attempts: { width: number; height: number }[] = [];
  let current = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
  for (let step = 0; step < IMAGE_NORMALIZE.maxResizeAttempts; step += 1) {
    if (step > 0) {
      current = {
        width:
          current.width === 1
            ? 1
            : Math.max(1, Math.floor(current.width * IMAGE_NORMALIZE.scaleStep)),
        height:
          current.height === 1
            ? 1
            : Math.max(1, Math.floor(current.height * IMAGE_NORMALIZE.scaleStep)),
      };
    }
    if (
      attempts.some((entry) => entry.width === current.width && entry.height === current.height)
    ) {
      break;
    }
    attempts.push({ ...current });
    if (current.width === 1 && current.height === 1) break;
  }
  return attempts;
}

/** Base64 length of a byte count, including padding. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}
