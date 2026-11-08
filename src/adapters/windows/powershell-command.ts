import { existsSync } from "node:fs";
import path from "node:path";

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

export function powershellCommand(command: string): string {
  const script = [
    "try { $OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { exit 125 }",
    "$ProgressPreference = 'SilentlyContinue'",
    "$global:LASTEXITCODE = 0",
    `& {\n${command}\n}`,
    "$succeeded = $?",
    "if (-not $succeeded -and $LASTEXITCODE -eq 0) { exit 1 }",
    "exit $LASTEXITCODE",
  ].join("\n");
  const quoted = `"${script.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, "$&$&")}"`;
  return `"${powershellExecutable()}" -NoProfile -NonInteractive -OutputFormat Text -Command ${quoted}`;
}
