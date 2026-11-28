import { parentPort, workerData } from "node:worker_threads";
const { pattern, caseSensitive } = workerData;
try {
    const expression = new RegExp(pattern, caseSensitive ? "u" : "iu");
    parentPort?.postMessage({ ready: true });
    parentPort?.on("message", ({ lines }) => {
        const indexes = [];
        for (const [index, line] of lines.entries())
            if (expression.test(line))
                indexes.push(index);
        parentPort?.postMessage({ indexes });
    });
}
catch {
    parentPort?.postMessage({ error: "invalid_pattern" });
}
