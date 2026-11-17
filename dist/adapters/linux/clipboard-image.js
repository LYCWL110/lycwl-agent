import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IMAGE_NORMALIZE } from "../../domain/media/image-normalize.js";
import { filterChildEnvironment } from "../../domain/process/shell.js";
const run = promisify(execFile);
export function createClipboardReader(options) {
    const environment = filterChildEnvironment(options.environment, {}, { platform: "linux" })
        .environment;
    const execute = options.execute ??
        (async (command, args, env) => {
            const { stdout } = await run(command, [...args], {
                env,
                timeout: 10_000,
                maxBuffer: IMAGE_NORMALIZE.maxBase64Bytes,
                encoding: "buffer",
            });
            return stdout;
        });
    return {
        async readImage() {
            const wayland = Boolean(environment["WAYLAND_DISPLAY"]);
            const executable = wayland ? "wl-paste" : "xclip";
            if (!wayland && !environment["DISPLAY"])
                return { kind: "unavailable" };
            try {
                const bytes = await execute(executable, wayland
                    ? ["--no-newline", "--type", "image/png"]
                    : ["-selection", "clipboard", "-t", "image/png", "-o"], environment);
                if (bytes.length === 0)
                    return { kind: "empty" };
                if (bytes.length < 24 ||
                    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
                    bytes.toString("ascii", 12, 16) !== "IHDR")
                    return { kind: "unavailable" };
                const base64 = bytes.toString("base64");
                if (base64.length > IMAGE_NORMALIZE.maxBase64Bytes ||
                    bytes.readUInt32BE(16) > IMAGE_NORMALIZE.maxWidth ||
                    bytes.readUInt32BE(20) > IMAGE_NORMALIZE.maxHeight)
                    return { kind: "too_large" };
                return { kind: "image", image: { mediaType: "image/png", base64 } };
            }
            catch (error) {
                const code = error.code;
                return {
                    kind: code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "too_large" : "unavailable",
                };
            }
        },
    };
}
