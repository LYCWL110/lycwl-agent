import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createBoundedProcessOutput, } from "../windows/bounded-process-output.js";
// A separate group leader observes IPC disconnect. Descendants that deliberately
// create another session are outside this boundary.
const WORKER = `
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
function terminate() {
  try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); }
}
process.on('disconnect', terminate);
process.once('message', request => {
  const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', request.command], {
    cwd: request.cwd, env: process.env, stdio: ['ignore', 'inherit', 'inherit']
  });
  child.once('error', () => process.send?.({ failed: true }, terminate));
  child.once('close', (code, signal) => {
    process.send?.({ exitCode: code ?? (128 + (constants.signals[signal] ?? 9)) }, terminate);
  });
});
`;
export function createProcessSupervisor(options = {}) {
    const running = new Map();
    function killGroup(pid) {
        try {
            process.kill(-pid, "SIGKILL");
        }
        catch (error) {
            if (error.code !== "ESRCH")
                throw error;
        }
    }
    function start(request) {
        const output = createBoundedProcessOutput(options.ownedKeys);
        if (output.snapshot().deliveryBlocked !== null)
            return { ok: false, code: "pipe_setup_failed" };
        let child;
        try {
            const environment = Object.fromEntries(Object.entries(request.environment).filter(([name]) => !["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"].includes(name) &&
                !name.startsWith("BASH_FUNC_")));
            child = spawn(process.execPath, ["--input-type=commonjs", "-e", WORKER], {
                cwd: request.cwd,
                env: environment,
                detached: true,
                stdio: ["ignore", "pipe", "pipe", "ipc"],
            });
        }
        catch {
            return { ok: false, code: "process_create_failed" };
        }
        // spawn failures are asynchronous even when no PID is assigned.
        child.on("error", () => {
            output.fail();
        });
        const pid = child.pid;
        if (pid === undefined)
            return { ok: false, code: "process_create_failed" };
        let resolveDone = () => undefined;
        const done = new Promise((resolve) => {
            resolveDone = resolve;
        });
        const entry = { output, closed: false, failed: false, exitCode: null, done };
        running.set(pid, entry);
        child.on("message", (message) => {
            if (typeof message !== "object" || message === null)
                return;
            if ("exitCode" in message && typeof message.exitCode === "number")
                entry.exitCode = message.exitCode;
            if ("failed" in message)
                entry.failed = true;
        });
        for (const stream of ["stdout", "stderr"]) {
            child[stream]?.on("data", (bytes) => {
                output.push(stream, bytes);
                if (output.stopped())
                    killGroup(pid);
            });
            child[stream]?.on("error", () => {
                output.fail();
                killGroup(pid);
            });
        }
        child.once("close", () => {
            entry.closed = true;
            output.finish(!entry.failed &&
                child.stdout?.readableEnded === true &&
                child.stderr?.readableEnded === true);
            resolveDone();
        });
        child.send({ command: request.command, cwd: request.cwd }, (error) => {
            if (error) {
                entry.failed = true;
                output.fail();
                killGroup(pid);
            }
        });
        return { ok: true, handle: { processId: pid } };
    }
    function readOutput(pid) {
        return running.get(pid)?.output.snapshot() ?? createBoundedProcessOutput().snapshot();
    }
    async function stop(pid) {
        const entry = running.get(pid);
        if (!entry)
            return readOutput(pid);
        if (!entry.closed)
            killGroup(pid);
        if (!entry.closed)
            await Promise.race([entry.done, delay(5_000, undefined, { ref: false })]);
        if (!entry.closed)
            throw new Error("process_termination_unconfirmed");
        const output = entry.output.snapshot();
        running.delete(pid);
        return output;
    }
    async function runToCompletion(request) {
        if (request.signal?.aborted)
            return { kind: "failed", code: "process_cancelled" };
        const started = start({ ...request, executionId: "foreground" });
        if (!started.ok)
            return { kind: "failed", code: started.code };
        const pid = started.handle.processId;
        const entry = running.get(pid);
        if (entry === undefined)
            return { kind: "failed", code: "process_create_failed" };
        const deadline = Date.now() + request.timeoutMs;
        let timedOut = false;
        let cancelled = false;
        try {
            while (!entry.closed) {
                cancelled = request.signal?.aborted === true;
                timedOut = !cancelled && Date.now() >= deadline;
                if (cancelled || timedOut || entry.output.stopped()) {
                    killGroup(pid);
                    await Promise.race([entry.done, delay(2_000, undefined, { ref: false })]);
                    if (!entry.closed)
                        return { kind: "failed", code: "wait_failed" };
                    break;
                }
                await Promise.race([entry.done, delay(25)]);
            }
            if (entry.failed)
                return { kind: "failed", code: "process_create_failed" };
            if (entry.exitCode === null && !cancelled && !timedOut && !entry.output.stopped())
                return { kind: "failed", code: "wait_failed" };
            return {
                kind: "completed",
                ...entry.output.snapshot(),
                processId: pid,
                exitCode: entry.exitCode ?? 1,
                timedOut,
                cancelled,
            };
        }
        finally {
            await stop(pid);
        }
    }
    return {
        start,
        stop,
        readOutput,
        runToCompletion,
        isAlive: (pid) => running.get(pid)?.closed === false,
        exitCodeOf: (pid) => running.get(pid)?.exitCode ?? null,
    };
}
