import { createClipboardReader as linuxClipboard } from "../adapters/linux/clipboard-image.ts";
import { linuxDirectories } from "../adapters/linux/directories.ts";
import * as linuxFs from "../adapters/linux/filesystem.ts";
import { createClipboardReader as windowsClipboard } from "../adapters/windows/clipboard-image.ts";
import { defaultConfigDirectory } from "../adapters/windows/config-store.ts";
import { powershellCommand, powershellExecutable } from "../adapters/windows/powershell-command.ts";
import { createWindowsFileReader } from "../adapters/windows/windows-directory-reader.ts";
import { createWindowsFsAdapter } from "../adapters/windows/windows-fs-adapter.ts";
import { createWindowsMutationAdapter } from "../adapters/windows/windows-mutation-adapter.ts";
import { createWindowsWriteAdapter } from "../adapters/windows/windows-write-adapter.ts";

if (process.platform !== "linux" && process.platform !== "win32")
  throw new Error(`Unsupported platform: ${process.platform}`);
export const hostPlatform = process.platform;

export function platformDirectories() {
  if (hostPlatform === "linux") return linuxDirectories();
  const config = defaultConfigDirectory(process.env["LOCALAPPDATA"]);
  return { config, state: config };
}

export const createClipboardReader = hostPlatform === "linux" ? linuxClipboard : windowsClipboard;
export const createFsAdapter =
  hostPlatform === "linux" ? linuxFs.createLinuxFsAdapter : createWindowsFsAdapter;
export const createFileReader =
  hostPlatform === "linux" ? linuxFs.createLinuxFileReader : createWindowsFileReader;
export const createWriteAdapter =
  hostPlatform === "linux" ? linuxFs.createLinuxWriteAdapter : createWindowsWriteAdapter;
export const createMutationAdapter =
  hostPlatform === "linux" ? linuxFs.createLinuxMutationAdapter : createWindowsMutationAdapter;
export const shellExecutable = () =>
  hostPlatform === "linux" ? "/bin/bash" : powershellExecutable();
export const shellCommand = (command: string) =>
  hostPlatform === "linux"
    ? JSON.stringify(["/bin/bash", "--noprofile", "--norc", "-c", command])
    : powershellCommand(command);
