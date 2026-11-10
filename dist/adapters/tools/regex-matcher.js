import { Worker } from "node:worker_threads";
export async function createRegexMatcher(pattern, caseSensitive, signal, timeoutMs = 30_000) {
    const worker = new Worker(new URL("./regex-worker.ts", import.meta.url), {
        workerData: { pattern, caseSensitive },
        resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    let stopped = false;
    let failureCode = "search_cancelled";
    let termination = null;
    let rejectPending = null;
    let receive = null;
    const stop = async () => {
        if (stopped) {
            await termination;
            return;
        }
        stopped = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        termination = worker.terminate();
        await termination;
    };
    const fail = (code) => {
        if (!stopped)
            failureCode = code;
        const reject = rejectPending;
        void stop().then(() => reject?.(new Error(failureCode)));
    };
    const abort = () => fail("search_cancelled");
    const timer = setTimeout(() => fail("search_timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    worker.on("error", () => fail("regex_worker_failed"));
    worker.on("exit", () => {
        if (!stopped)
            fail("regex_worker_failed");
    });
    worker.on("message", (message) => {
        if (message.error !== undefined)
            fail("invalid_pattern");
        else
            receive?.(message);
    });
    const wait = () => new Promise((resolve, reject) => {
        rejectPending = reject;
        receive = (message) => {
            rejectPending = null;
            receive = null;
            resolve(message);
        };
        if (stopped || signal?.aborted)
            fail(failureCode);
    });
    await wait();
    return {
        async match(lines) {
            const result = wait();
            if (!stopped)
                worker.postMessage({ lines });
            return (await result).indexes;
        },
        close: stop,
    };
}
