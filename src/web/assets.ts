/**
 * Static browser assets.
 *
 * The client is plain HTML/CSS/JavaScript under `src/web/static`, so the server
 * only has to read files from one directory. The important part is the path
 * check: an asset request must not be able to leave that directory, on any
 * platform, whatever encoding the browser sent.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type WebAsset = Readonly<{ body: Uint8Array; contentType: string }>;

export type WebAssetSource = Readonly<{
  /** Read one request pathname; null when the asset does not exist or is unsafe. */
  read(pathname: string): Promise<WebAsset | null>;
}>;

export type WebAssetSourceOptions = Readonly<{
  root: string;
  log?: (message: string) => void;
}>;

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/**
 * Media types for the client's file kinds.
 *
 * `map` is JSON even though browsers load it as a source map, and unknown
 * extensions are bytes rather than a guess: serving a wrong type changes how the
 * browser parses a file, so an unknown extension must not claim one.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export function createAssetSource(options: WebAssetSourceOptions): WebAssetSource {
  const root = path.resolve(options.root);
  const log = options.log ?? (() => undefined);
  return {
    read: async (pathname) => {
      const target = resolveTarget(root, pathname);
      if (target === null) {
        log(`asset path rejected: ${pathname}`);
        return null;
      }
      return readAsset(target, log);
    },
  };
}

/**
 * The assets shipped with the build.
 *
 * The URL is relative to the emitted module, so the same expression finds
 * `src/web/static` when running from source and `dist/web/static` after the
 * build copied the directory there.
 */
export function bundledAssetSource(): WebAssetSource {
  return createAssetSource({ root: fileURLToPath(new URL("./static/", import.meta.url)) });
}

async function readAsset(target: string, log: (message: string) => void): Promise<WebAsset | null> {
  let file = target;
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      file = path.join(file, "index.html");
    } else if (!info.isFile()) {
      return null;
    }
  } catch (error) {
    if (isMissing(error)) return null;
    log(`asset stat failed for ${target}: ${describeError(error)}`);
    return null;
  }
  try {
    const body = await readFile(file);
    return { body, contentType: contentTypeFor(file) };
  } catch (error) {
    if (isMissing(error)) return null;
    log(`asset read failed for ${file}: ${describeError(error)}`);
    return null;
  }
}

/**
 * Resolve a request pathname below `root`, or null when it must not be served.
 *
 * The path is decoded first so no encoding can smuggle a separator: `..`,
 * backslashes (Windows separators), NUL and drive-qualified segments all fail the
 * same check. Resolving afterwards and re-testing the prefix keeps the invariant
 * even if a future change forgets a segment check.
 */
function resolveTarget(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\u0000") || decoded.includes("\\")) return null;
  if (!decoded.startsWith("/")) return null;
  const segments = decoded.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  for (const segment of segments) {
    if (segment === "..") return null;
    // Windows rejects ':' in file names, but it qualifies the segment as a path
    // (a drive or an NTFS stream), which is never one of our assets.
    if (segment.includes(":")) return null;
  }
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" ? code : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
