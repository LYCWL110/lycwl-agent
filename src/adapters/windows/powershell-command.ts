import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type PowerShellCapturePaths = Readonly<{ stdoutPath: string; stderrPath: string }>;

export function createPowerShellCapturePaths(): PowerShellCapturePaths {
  const token = randomBytes(12).toString("hex");
  return {
    stdoutPath: path.join(tmpdir(), `lycwl-out-${token}.log`),
    stderrPath: path.join(tmpdir(), `lycwl-err-${token}.log`),
  };
}

export function powershellExecutable(): string {
  const executable = path.join(
    process.env["SystemRoot"] ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!existsSync(executable)) throw new Error("powershell_unavailable");
  return executable;
}

export function powershellCommand(command: string, stdout: string, stderr: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = [
    "$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "$global:LASTEXITCODE = 0",
    `& {\n${command}\n} 1> ${quote(stdout)} 2> ${quote(stderr)}`,
    "$succeeded = $?",
    "if (-not $succeeded -and $LASTEXITCODE -eq 0) { exit 1 }",
    "exit $LASTEXITCODE",
  ].join("\n");
  return `"${powershellExecutable()}" -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}
