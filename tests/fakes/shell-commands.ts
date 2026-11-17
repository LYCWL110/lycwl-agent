/**
 * Platform-neutral shell commands for tests.
 *
 * The shell tool runs PowerShell on Windows and `/bin/bash` on Linux, so a test
 * that hard-codes PowerShell syntax only covers one host. These builders emit
 * the same behaviour in the host shell, letting one test file assert it on both.
 *
 * Only the command text differs; everything else — approval, supervision,
 * cancellation, output capture — is the shared code under test.
 */

export const IS_WINDOWS = process.platform === "win32";

/** Quotes a value for the host shell. Test values are plain text. */
function quote(value: string): string {
  return `'${value.replaceAll("'", IS_WINDOWS ? "''" : "'\\''")}'`;
}

export const shellCommands = {
  /** Writes a line to stdout. */
  echo(text: string): string {
    return IS_WINDOWS ? `Write-Output ${quote(text)}` : `printf '%s\\n' ${quote(text)}`;
  },

  /** Writes a line and exits with a status. */
  echoAndExit(text: string, code: number): string {
    return `${shellCommands.echo(text)}; exit ${code}`;
  },

  /** Writes a line to stderr. */
  echoToStderr(text: string): string {
    return IS_WINDOWS ? `Write-Error ${quote(text)}` : `printf '%s\\n' ${quote(text)} >&2`;
  },

  /** Writes a line, then keeps running: cancelling must stop it early. */
  echoThenSleep(text: string, seconds: number): string {
    return `${shellCommands.echo(text)}; ${shellCommands.sleep(seconds)}`;
  },

  /** Waits without producing output. */
  sleep(seconds: number): string {
    return IS_WINDOWS ? `Start-Sleep -Seconds ${seconds}` : `sleep ${seconds}`;
  },

  /** Waits a fraction of a second. */
  sleepMs(milliseconds: number): string {
    return IS_WINDOWS
      ? `Start-Sleep -Milliseconds ${milliseconds}`
      : `sleep ${(milliseconds / 1000).toFixed(3)}`;
  },

  /** Writes a file relative to the working directory. */
  writeFile(target: string, content: string): string {
    return IS_WINDOWS
      ? `Set-Content -LiteralPath ${quote(target)} -Value ${quote(content)}`
      : `printf '%s' ${quote(content)} > ${quote(target)}`;
  },

  /** Waits, then writes: cancelling the run must leave no file. */
  writeAfterDelay(seconds: number, target: string, content: string): string {
    return `${shellCommands.sleep(seconds)}; ${shellCommands.writeFile(target, content)}`;
  },

  /**
   * Starts a descendant that records its own pid and writes after a delay,
   * then keeps the parent alive. Cancelling must kill the descendant too.
   */
  descendantWriteAfterDelay(target: string, pidFile: string, content: string): string {
    const delayedWrite = shellCommands.writeAfterDelay(2, target, content);
    if (!IS_WINDOWS) {
      return `sh -c ${quote(delayedWrite)} & echo $! > ${quote(pidFile)}; sleep 20`;
    }
    const encoded = Buffer.from(delayedWrite, "utf16le").toString("base64");
    return [
      `$child = Start-Process -FilePath "$PSHOME\\powershell.exe" -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encoded}' -WindowStyle Hidden -PassThru`,
      `Set-Content -LiteralPath ${quote(pidFile)} -Value $child.Id`,
      "Start-Sleep -Seconds 20",
    ].join("; ");
  },

  /** Prints the absolute working directory. */
  printWorkingDirectory(): string {
    return IS_WINDOWS ? "Write-Output (Get-Location).Path" : "pwd";
  },

  /** Writes to stderr without a trailing newline. */
  writeErrorWithoutNewline(text: string): string {
    return IS_WINDOWS ? `[Console]::Error.Write(${quote(text)})` : `printf '%s' ${quote(text)} >&2`;
  },

  /** Repeats one character to stdout, without a trailing newline. */
  repeatToStdout(character: string, count: number): string {
    return IS_WINDOWS
      ? `[Console]::Out.Write(('${character}' * ${count}))`
      : `head -c ${count} /dev/zero | tr '\\0' '${character}'`;
  },

  /** Reads one environment variable from the child's environment. */
  readEnvironmentVariable(name: string): string {
    return IS_WINDOWS ? `Write-Output $env:${name}` : `printf '%s\\n' "$${name}"`;
  },

  /** Repeats one character, without a trailing newline. */
  repeat(character: string, count: number): string {
    return IS_WINDOWS
      ? `'${character}' * ${count}`
      : `head -c ${count} /dev/zero | tr '\\0' '${character}'`;
  },
};

/**
 * Bytes one echoed line occupies in the captured record, terminator included.
 *
 * PowerShell terminates a line with CRLF and bash with LF, so a page sized to
 * "exactly one line" is one byte wider on Windows. Tests that pin a cursor to
 * the first line use this instead of a literal.
 */
export function echoedLineBytes(text: string): number {
  return Buffer.byteLength(text) + (IS_WINDOWS ? 2 : 1);
}
