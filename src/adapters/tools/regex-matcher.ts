import { Worker } from "node:worker_threads";

export async function createRegexMatcher(
  pattern: string,
  caseSensitive: boolean,
  signal?: AbortSignal,
  timeoutMs = 30_000,
) {
  const worker = new Worker(new URL("./regex-worker.ts", import.meta.url), {
    workerData: { pattern, caseSensitive },
    resourceLimits: { maxOldGenerationSizeMb: 64 },
  });
  let stopped = false;
  let failureCode = "search_cancelled";
  let termination: Promise<number> | null = null;
  let rejectPending: ((error: Error) => void) | null = null;
  let receive: ((value: unknown) => void) | null = null;
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
  const fail = (code: string) => {
    if (!stopped) failureCode = code;
    const reject = rejectPending;
    void stop().then(() => reject?.(new Error(failureCode)));
  };
  const abort = () => fail("search_cancelled");
  const timer = setTimeout(() => fail("search_timeout"), timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  worker.on("error", () => fail("regex_worker_failed"));
  worker.on("exit", () => {
    if (!stopped) fail("regex_worker_failed");
  });
  worker.on("message", (message: { error?: string }) => {
    if (message.error !== undefined) fail("invalid_pattern");
    else receive?.(message);
  });
  const wait = <T>() =>
    new Promise<T>((resolve, reject) => {
      rejectPending = reject;
      receive = (message) => {
        rejectPending = null;
        receive = null;
        resolve(message as T);
      };
      if (stopped || signal?.aborted) fail(failureCode);
    });
  await wait<{ ready: true }>();
  return {
    async match(lines: readonly string[]) {
      const result = wait<{ indexes: number[] }>();
      if (!stopped) worker.postMessage({ lines });
      return (await result).indexes;
    },
    close: stop,
  };
}
