import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IMAGE_NORMALIZE } from "../../domain/media/image-normalize.ts";
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

/** The base64 payload limit the script enforces. */
export const MAX_IMAGE_BYTES = IMAGE_NORMALIZE.maxBase64Bytes;

/**
 * Ask the clipboard for an image and return it as PNG.
 *
 * The script prints a base64 PNG on stdout, or nothing when the clipboard holds no
 * image. It never prints an error to stdout, so an empty result is unambiguous.
 */
/**
 * Ask the clipboard for an image, shrinking it to fit the provider limits.
 *
 * The script prints base64 on stdout, or one of two sentinels: nothing when the
 * clipboard holds no image, `TOO_LARGE` when even the smallest attempt exceeds the
 * limit. It never prints an error to stdout, so an empty result is unambiguous.
 *
 * The shrink policy mirrors domain/media/image-normalize.ts: pass a small image
 * through untouched, otherwise scale in 0.75 steps and re-encode as JPEG at
 * decreasing quality. A transparent image keeps PNG, because JPEG has no alpha and
 * flattening it onto black is a visible change the user did not ask for.
 */
const READ_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -eq $null) { exit 0 }
$maxW = ${IMAGE_NORMALIZE.maxWidth}
$maxH = ${IMAGE_NORMALIZE.maxHeight}
$maxB64 = ${IMAGE_NORMALIZE.maxBase64Bytes}
$pngPassB64 = ${IMAGE_NORMALIZE.pngPassthroughMaxBase64Bytes}
$smallPixels = ${IMAGE_NORMALIZE.smallPngMaxPixels}
$qualities = @(${IMAGE_NORMALIZE.jpegQualities.join(",")})
$transparencyThreshold = ${IMAGE_NORMALIZE.transparencyFraction}

function ConvertTo-Base64($bitmap, $format, $quality) {
  $ms = New-Object System.IO.MemoryStream
  if ($quality -gt 0) {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $params = New-Object System.Drawing.Imaging.EncoderParameters 1
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
    $bitmap.Save($ms, $codec, $params)
    $params.Dispose()
  } else {
    $bitmap.Save($ms, $format)
  }
  $bytes = $ms.ToArray()
  $ms.Dispose()
  return ,$bytes
}

function Test-Transparent($bitmap) {
  $cols = [int][Math]::Min([double]${IMAGE_NORMALIZE.transparencyGrid}, [double]$bitmap.Width)
  $rows = [int][Math]::Min([double]${IMAGE_NORMALIZE.transparencyGrid}, [double]$bitmap.Height)
  $transparent = 0
  for ($r = 0; $r -lt $rows; $r++) {
    $y = [Math]::Floor((($r + 0.5) * $bitmap.Height) / $rows)
    for ($c = 0; $c -lt $cols; $c++) {
      $x = [Math]::Floor((($c + 0.5) * $bitmap.Width) / $cols)
      if ($bitmap.GetPixel([int]$x, [int]$y).A -lt 250) { $transparent++ }
    }
  }
  if (($cols * $rows) -eq 0) { return $false }
  return ($transparent / ($cols * $rows)) -gt $transparencyThreshold
}

function Resize-Bitmap($source, $w, $h) {
  $target = New-Object System.Drawing.Bitmap ([int]$w), ([int]$h)
  $graphics = [System.Drawing.Graphics]::FromImage($target)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.DrawImage($source, 0, 0, [int]$w, [int]$h)
  $graphics.Dispose()
  return $target
}

try {
  $png = ConvertTo-Base64 $img ([System.Drawing.Imaging.ImageFormat]::Png) 0
  $pngB64 = [Convert]::ToBase64String($png)
  $fits = ($img.Width -le $maxW) -and ($img.Height -le $maxH) -and ($pngB64.Length -le $maxB64)
  $smallPng = ($pngB64.Length -le $pngPassB64) -or (($img.Width * $img.Height) -le $smallPixels)
  if ($fits -and $smallPng) { Write-Output $pngB64; exit 0 }
  $transparent = Test-Transparent $img
  if ($fits) {
    if ($transparent) { Write-Output $pngB64; exit 0 }
    foreach ($q in $qualities) {
      $jpeg = ConvertTo-Base64 $img ([System.Drawing.Imaging.ImageFormat]::Jpeg) $q
      if ($jpeg.Length -lt $png.Length) {
        $b64 = [Convert]::ToBase64String($jpeg)
        if ($b64.Length -le $maxB64) { Write-Output ('JPEG:' + $b64); exit 0 }
      }
    }
    Write-Output $pngB64; exit 0
  }
  $scaleW = [double]$maxW / [double]$img.Width
  $scaleH = [double]$maxH / [double]$img.Height
  $scale = [Math]::Min(1.0, [Math]::Min($scaleW, $scaleH))
  $w = [Math]::Max(1.0, [Math]::Round($img.Width * $scale))
  $h = [Math]::Max(1.0, [Math]::Round($img.Height * $scale))
  $current = $img
  $owned = $false
  for ($attempt = 0; $attempt -lt ${IMAGE_NORMALIZE.maxResizeAttempts}; $attempt++) {
    if ($attempt -gt 0) {
      $w = if ($w -eq 1) { 1 } else { [Math]::Max(1.0, [Math]::Floor($w * ${IMAGE_NORMALIZE.scaleStep})) }
      $h = if ($h -eq 1) { 1 } else { [Math]::Max(1.0, [Math]::Floor($h * ${IMAGE_NORMALIZE.scaleStep})) }
    }
    $resized = Resize-Bitmap $img $w $h
    $transparent = Test-Transparent $resized
    $chosen = $null
    $isJpeg = $false
    if ($transparent) {
      $candidate = ConvertTo-Base64 $resized ([System.Drawing.Imaging.ImageFormat]::Png) 0
      $b64 = [Convert]::ToBase64String($candidate)
      if ($b64.Length -le $maxB64) { $chosen = $b64 }
    } else {
      foreach ($q in $qualities) {
        $candidate = ConvertTo-Base64 $resized ([System.Drawing.Imaging.ImageFormat]::Jpeg) $q
        $b64 = [Convert]::ToBase64String($candidate)
        if ($b64.Length -le $maxB64) { $chosen = $b64; $isJpeg = $true; break }
      }
    }
    $resized.Dispose()
    if ($chosen -ne $null) {
      if ($isJpeg) { Write-Output ('JPEG:' + $chosen) } else { Write-Output $chosen }
      exit 0
    }
    if ($w -eq 1 -and $h -eq 1) { break }
  }
  Write-Output 'TOO_LARGE'
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
        // The script prefixes JPEG results, because the type cannot be inferred from
        // the base64 itself. An unprefixed result is PNG.
        const jpeg = trimmed.startsWith("JPEG:");
        const payload = jpeg ? trimmed.slice("JPEG:".length) : trimmed;
        if (!isBase64(payload)) return { kind: "unavailable" };
        return {
          kind: "image",
          image: { mediaType: jpeg ? "image/jpeg" : "image/png", base64: payload },
        };
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
