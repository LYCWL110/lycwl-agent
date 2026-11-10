import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLIPBOARD_TIMEOUT_MS,
  createClipboardReader,
  MAX_IMAGE_BYTES,
} from "../../src/adapters/windows/clipboard-image.ts";

/**
 * Clipboard image reading.
 *
 * A terminal paste carries text only, so the image has to come from the system
 * clipboard. The child process is injected: the point is to prove the result is
 * classified correctly and that a failure is not mistaken for an image.
 */

function reader(stdout: string, options: { throws?: boolean } = {}) {
  const calls: { command: string; args: readonly string[]; env: Record<string, string> }[] = [];
  const created = createClipboardReader({
    environment: { PATH: "/usr/bin", GITHUB_TOKEN: "secret" },
    execute: async (command, args, execOptions) => {
      calls.push({ command, args, env: execOptions.env });
      if (options.throws === true) throw new Error("powershell unavailable");
      return { stdout };
    },
  });
  return { reader: created, calls };
}

/** A base64 string whose length is a multiple of four. */
const VALID_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUg==";

describe("clipboard image reader", () => {
  it("returns an image when the clipboard holds one", async () => {
    const result = await reader(VALID_PNG_BASE64).reader.readImage();
    assert.equal(result.kind, "image");
    if (result.kind !== "image") return;
    // The script always re-encodes to PNG, so the type is known without sniffing.
    assert.equal(result.image.mediaType, "image/png");
    assert.equal(result.image.base64, VALID_PNG_BASE64);
  });

  it("trims surrounding whitespace from the child output", async () => {
    const result = await reader(`\n${VALID_PNG_BASE64}\n`).reader.readImage();
    assert.equal(result.kind, "image");
    if (result.kind !== "image") return;
    assert.equal(result.image.base64, VALID_PNG_BASE64);
  });

  it("reports an empty clipboard as empty, not as a failure", async () => {
    // Empty means the clipboard held text; the terminal's own paste already handled
    // that, so the caller should stay silent rather than warn.
    const result = await reader("").reader.readImage();
    assert.deepEqual(result, { kind: "empty" });
  });

  it("reports an oversized image", async () => {
    const result = await reader("TOO_LARGE").reader.readImage();
    assert.deepEqual(result, { kind: "too_large" });
  });

  it("refuses output that is not base64", async () => {
    // The script is only allowed to print base64 or the sentinel; anything else is a
    // malfunction and must not be passed to a provider as image data.
    const result = await reader("Error: clipboard is locked").reader.readImage();
    assert.deepEqual(result, { kind: "unavailable" });
  });

  it("reports an unavailable reader when the child fails", async () => {
    const result = await reader("", { throws: true }).reader.readImage();
    assert.deepEqual(result, { kind: "unavailable" });
  });

  it("invokes PowerShell with the filtered environment", async () => {
    const { reader: clipboard, calls } = reader(VALID_PNG_BASE64);
    await clipboard.readImage();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "powershell.exe");
    // The credential never reaches the child.
    assert.equal(calls[0]?.env["GITHUB_TOKEN"], undefined);
    assert.equal(calls[0]?.env["PATH"], "/usr/bin");
  });

  it("passes a bounded timeout", async () => {
    let timeout = 0;
    const clipboard = createClipboardReader({
      environment: {},
      execute: async (_command, _args, execOptions) => {
        timeout = execOptions.timeout;
        return { stdout: VALID_PNG_BASE64 };
      },
    });
    await clipboard.readImage();
    assert.equal(timeout, CLIPBOARD_TIMEOUT_MS);
  });

  it("keeps the size limit at five mebibytes", () => {
    assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
  });

  it("classifies a JPEG-prefixed result as image/jpeg", async () => {
    // The script prefixes JPEG because the type cannot be inferred from base64.
    const result = await reader(`JPEG:${VALID_PNG_BASE64}`).reader.readImage();
    assert.equal(result.kind, "image");
    if (result.kind !== "image") return;
    assert.equal(result.image.mediaType, "image/jpeg");
    assert.equal(result.image.base64, VALID_PNG_BASE64);
  });

  it("embeds the shrink policy in the generated script", async () => {
    // The script is a template literal; an uninterpolated placeholder would be sent
    // to PowerShell as literal text and silently disable the limits.
    let script = "";
    const clipboard = createClipboardReader({
      environment: {},
      execute: async (_command, args) => {
        script = args[args.length - 1] ?? "";
        return { stdout: "" };
      },
    });
    await clipboard.readImage();
    assert.match(script, /\$maxW = 2000/);
    assert.match(script, /\$maxH = 2000/);
    assert.match(script, /\$maxB64 = 5242880/);
    assert.equal(script.includes("${"), false, "no placeholder may survive");
  });
});
