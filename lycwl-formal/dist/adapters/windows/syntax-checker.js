import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isCheckableSource, parseCheckerFailure, SYNTAX_CHECK_LIMITS, } from "../../domain/mutation/syntax-check.js";
import { filterChildEnvironment } from "../../domain/process/shell.js";
export function createSyntaxChecker(options) {
    const run = options.run ?? defaultRun(options.tscEntry);
    return {
        async check(absolutePath) {
            if (!isCheckableSource(absolutePath)) {
                return { kind: "skipped", reason: "not_supported" };
            }
            let size;
            try {
                const info = await stat(absolutePath);
                if (!info.isFile())
                    return { kind: "skipped", reason: "not_supported" };
                size = info.size;
            }
            catch {
                // The file is gone, which the caller will notice; a check is meaningless.
                return { kind: "skipped", reason: "not_supported" };
            }
            if (size > SYNTAX_CHECK_LIMITS.maxFileBytes) {
                return { kind: "skipped", reason: "too_large" };
            }
            // An empty type-roots directory keeps @types out of the result. It is created
            // per call rather than kept around, so nothing is left behind.
            const emptyTypes = await mkdtemp(path.join(tmpdir(), "lycwl-types-")).catch(() => null);
            if (emptyTypes === null)
                return { kind: "skipped", reason: "checker_unavailable" };
            try {
                const result = await run([
                    options.tscEntry,
                    "--noEmit",
                    "--pretty",
                    "false",
                    "--skipLibCheck",
                    "--typeRoots",
                    emptyTypes,
                    "--target",
                    "es2022",
                    "--module",
                    "esnext",
                    "--moduleResolution",
                    "bundler",
                    absolutePath,
                ], {
                    timeoutMs: SYNTAX_CHECK_LIMITS.timeoutMs,
                    // Filtered here as well as at the call site, so this adapter is safe to
                    // call with any environment rather than relying on its caller.
                    env: filterChildEnvironment(options.environment, {}, { platform: process.platform === "linux" ? "linux" : "win32" }).environment,
                });
                if (result.timedOut)
                    return { kind: "skipped", reason: "checker_unavailable" };
                // 0 is clean. Anything else is a report; tsc uses 1 and 2 for different
                // failure kinds and both mean "this file does not compile".
                if (result.code === 0)
                    return { kind: "ok" };
                const parsed = parseCheckerFailure(result.stdout);
                return { kind: "failed", message: parsed.message, line: parsed.line };
            }
            catch {
                return { kind: "skipped", reason: "checker_unavailable" };
            }
            finally {
                await rm(emptyTypes, { recursive: true, force: true }).catch(() => undefined);
            }
        },
    };
}
/**
 * Default runner.
 *
 * The child gets no stdin and its output is bounded: a tsc run that somehow emits
 * megabytes must not become a memory problem of its own.
 */
function defaultRun(tscEntry) {
    return (args, options) => new Promise((resolve) => {
        let settled = false;
        const child = spawn(process.execPath, [...args], {
            env: options.env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        let stdout = "";
        const append = (chunk) => {
            // 64 KiB is far more than a single-file diagnostic needs.
            if (stdout.length < 65_536)
                stdout += chunk.toString("utf8");
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            try {
                child.kill();
            }
            catch {
                // Already gone.
            }
            resolve({ code: null, stdout, timedOut: true });
        }, options.timeoutMs);
        timer.unref?.();
        child.on("error", () => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: null, stdout, timedOut: false });
        });
        child.on("exit", (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, stdout, timedOut: false });
        });
    });
}
/** Locate typescript's bin/tsc relative to the running package. */
export function defaultTscEntry(packageRoot) {
    return path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");
}
