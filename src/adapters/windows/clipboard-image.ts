import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { filterChildEnvironment } from "../../domain/process/shell.ts";
import type { ProviderImage } from "../../ports/model-provider.ts";

/**
 * Read an image from the Windows clipboard.
 *
 * A terminal paste carries text only: the clipboard image never reaches stdin, so
 * Ctrl+V in a TUI cannot see it. The image has to be read from the system clipboard
 * through the platform API.
 *
 * PowerShell is used rather than a native binding because `System.Windows.Forms`
 * already decodes every format the clipboard can hold and re-encodes to PNG, which
 * removes the need to handle DIB, DIBV5 and PNG separately. The cost is a process
 * spawn per paste attempt, which is acceptable: a paste happens when the user acts,
 * not in a loop.
 *
 * The child process gets the filtered environment, like every other child.
 */

const run = promisify(execFile);

export const CLIPBOARD_TIMEOUT_MS = 10_000;

/** Raw bytes a pasted image may have before base64 inflation. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Ask the clipboard for an image and return it as PNG.
 *
 * The script prints a base64 PNG on stdout, or nothing when the clipboard holds no
 * image. It never prints an error to stdout, so an empty result is unambiguous.
 */
const READ_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -eq $null) { exit 0 }
try {
  $ms = New-Object System.IO.MemoryStream
  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  if ($bytes.Length -gt ${MAX_IMAGE_BYTES}) { Write-Output "TOO_LARGE"; exit 0 }
  [Convert]::ToBase64String($bytes)
} finally {
  $img.Dispose()
}
`;

export type ClipboardResult =
  | Readonly<{ kind: "image"; image: ProviderImage }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "too_large" }>
  | Readonly<{ kind: "unavailable" }>;

export type ClipboardReader = Readonly<{
  readImage: () => Promise<ClipboardResult>;
}>;

export type ClipboardReaderOptions = Readonly<{
  /** The already-filtered environment for the child process. */
  environment: Readonly<Record<string, string>>;
  /** Injected for tests. */
  execute?: (
    command: string,
    args: readonly string[],
    options: Readonly<{ env: Record<string, string>; timeout: number }>,
  ) => Promise<{ stdout: string }>;
}>;

export function createClipboardReader(options: ClipboardReaderOptions): ClipboardReader {
  const execute =
    options.execute ??
    (async (command, args, execOptions) => {
      const result = await run(command, [...args], {
        env: execOptions.env,
        timeout: execOptions.timeout,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { stdout: result.stdout };
    });

  return {
    async readImage() {
      if (process.platform !== "win32") return { kind: "unavailable" };
      try {
        const { stdout } = await execute(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", READ_SCRIPT],
          // Filtered here as well as at the call site, so this adapter is safe to
          // call with any environment rather than relying on its caller.
          {
            env: filterChildEnvironment(options.environment).environment as Record<string, string>,
            timeout: CLIPBOARD_TIMEOUT_MS,
          },
        );
        const trimmed = stdout.trim();
        if (trimmed.length === 0) return { kind: "empty" };
        if (trimmed === "TOO_LARGE") return { kind: "too_large" };
        // The script always encodes PNG, so the media type is known without sniffing.
        if (!isBase64(trimmed)) return { kind: "unavailable" };
        return { kind: "image", image: { mediaType: "image/png", base64: trimmed } };
      } catch {
        // A missing PowerShell, a locked clipboard or a timeout all mean the same
        // thing to the caller: no image is available right now.
        return { kind: "unavailable" };
      }
    },
  };
}

/** Cheap shape check: base64 is the only thing the script is allowed to print. */
function isBase64(value: string): boolean {
  if (value.length < 4 || value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/u.test(value);
}
