import { parentPort, workerData } from "node:worker_threads";

const { pattern, caseSensitive } = workerData as { pattern: string; caseSensitive: boolean };
try {
  const expression = new RegExp(pattern, caseSensitive ? "u" : "iu");
  parentPort?.postMessage({ ready: true });
  parentPort?.on("message", ({ lines }: { lines: readonly string[] }) => {
    const indexes: number[] = [];
    for (const [index, line] of lines.entries()) if (expression.test(line)) indexes.push(index);
    parentPort?.postMessage({ indexes });
  });
} catch {
  parentPort?.postMessage({ error: "invalid_pattern" });
}
