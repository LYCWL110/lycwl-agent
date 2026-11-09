import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { ProviderImage } from "../../ports/model-provider.ts";

/**
 * Image attachment for a user turn.
 *
 * An image is read from disk and sent inline as base64, because none of the three
 * protocols accepts a local path and a URL would let the provider fetch content the
 * user never approved.
 *
 * Three limits exist for different reasons:
 *
 * - **Size**: base64 inflates by a third and the bytes travel in every request that
 *   includes the turn, so a large image is expensive on every round, not once.
 * - **Media type**: decided by the file's magic bytes, never by its extension. An
 *   extension is a claim the file makes about itself, and the provider trusts the
 *   declared type.
 * - **Location**: the resolved path must stay inside the workspace, the same rule
 *   every other file tool follows. A symlink is followed before the check so it
 *   cannot be used to escape.
 */

export const IMAGE_LIMITS = Object.freeze({
  /** Raw bytes before base64. */
  maxBytes: 5 * 1024 * 1024,
  /** At most this many images on one turn. */
  maxImages: 4,
});

export type ImageFailure =
  | "invalid_path"
  | "outside_workspace"
  | "not_found"
  | "too_large"
  | "unsupported_type"
  | "too_many"
  | "read_failed";

export type ImageLoadResult =
  | Readonly<{ ok: true; images: readonly ProviderImage[] }>
  | Readonly<{ ok: false; code: ImageFailure }>;

export type ImageLoader = Readonly<{
  load: (relativePaths: readonly string[]) => Promise<ImageLoadResult>;
}>;

export function createImageLoader(options: Readonly<{ workspaceRoot: string }>): ImageLoader {
  const root = path.resolve(options.workspaceRoot);

  return {
    async load(relativePaths) {
      if (relativePaths.length === 0) return { ok: true, images: [] };
      if (relativePaths.length > IMAGE_LIMITS.maxImages) return { ok: false, code: "too_many" };

      const images: ProviderImage[] = [];
      for (const supplied of relativePaths) {
        if (supplied.length === 0) return { ok: false, code: "invalid_path" };

        const candidate = path.resolve(root, supplied);
        if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
          return { ok: false, code: "outside_workspace" };
        }

        let resolved: string;
        try {
          // Follow a symlink before the boundary check, so a link inside the
          // workspace cannot point outside it.
          resolved = await realpath(candidate);
        } catch {
          return { ok: false, code: "not_found" };
        }
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
          return { ok: false, code: "outside_workspace" };
        }

        let info: Awaited<ReturnType<typeof stat>>;
        try {
          info = await stat(resolved);
        } catch {
          return { ok: false, code: "not_found" };
        }
        if (!info.isFile()) return { ok: false, code: "not_found" };
        if (info.size > IMAGE_LIMITS.maxBytes) return { ok: false, code: "too_large" };

        let bytes: Buffer;
        try {
          bytes = await readFile(resolved);
        } catch {
          return { ok: false, code: "read_failed" };
        }

        const mediaType = detectMediaType(bytes);
        if (mediaType === null) return { ok: false, code: "unsupported_type" };
        images.push({ mediaType, base64: bytes.toString("base64") });
      }
      return { ok: true, images };
    },
  };
}

/**
 * Identify the image format from its magic bytes.
 *
 * The extension is deliberately ignored: a `.png` that is actually a JPEG would be
 * declared wrongly and rejected by the provider, and a `.txt` that is actually an
 * image would be refused for no reason.
 */
export function detectMediaType(
  bytes: Uint8Array,
): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  // GIF: "GIF87a" or "GIF89a"
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}
