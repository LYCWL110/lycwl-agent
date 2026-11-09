#!/usr/bin/env node
/**
 * Footprint measurement (mirrors Miyu's docs/plan/low-footprint.md method).
 *
 * What this measures, and what it does not:
 *
 * - It measures this Harness's own process: heap growth across turns, retained
 *   memory after a turn settles, peak, and CPU time. It does not measure a real
 *   terminal's rendering cost or a real provider's latency.
 * - The provider is a stub that returns immediately. That is deliberate: it
 *   isolates Harness overhead from network variance. A real provider run would
 *   measure the network, not this code.
 * - Tool calls are exercised through a stub executor with realistic payload
 *   sizes, so the tool-output path is included without needing disk or processes.
 *
 * Usage:
 *   node tools/measure-footprint.mjs            # default 5 turns
 *   node tools/measure-footprint.mjs --turns 20
 *   node tools/measure-footprint.mjs --tool-bytes 200000
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { JsonlCheckpointStore } from "../src/adapters/persistence/jsonl-checkpoint-store.ts";
import { JsonlEventLog } from "../src/adapters/persistence/jsonl-event-log.ts";
import { createSpillStore } from "../src/adapters/persistence/spill-store.ts";
import { RuntimeCoordinator } from "../src/application/coordinator/runtime-coordinator.ts";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const TURNS = argValue("--turns", 5);
const TOOL_BYTES = argValue("--tool-bytes", 40_000);
const TOOL_CALLS_PER_TURN = argValue("--tool-calls", 2);
const SETTLE_MS = argValue("--settle-ms", 300);
const IDLE_MS = argValue("--idle-ms", 0);

const digests = {
  async sha256Canonical(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  },
};
const ids = { create: () => randomUUID() };

/** Read this process's memory and CPU from the platform. */
function readFootprint() {
  // On Windows there is no /proc. Use the process module, which reports the same
  // numbers the task manager shows for this process.
  const usage = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
  };
}

const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const ms = (value) => `${value.toFixed(0)} ms`;

function printRow(label, value) {
  process.stdout.write(`  ${label.padEnd(28)} ${value}\n`);
}

function printFootprint(label, current, baseline) {
  process.stdout.write(`${label}\n`);
  printRow("RSS", mb(current.rss));
  printRow("heapUsed", mb(current.heapUsed));
  printRow("heapTotal", mb(current.heapTotal));
  printRow("external", mb(current.external));
  printRow("arrayBuffers", mb(current.arrayBuffers));
  if (baseline !== undefined) {
    printRow("RSS delta", `${mb(current.rss - baseline.rss)}`);
    printRow("heapUsed delta", `${mb(current.heapUsed - baseline.heapUsed)}`);
    printRow(
      "CPU delta",
      `${ms(current.cpuUserMs + current.cpuSystemMs - (baseline.cpuUserMs + baseline.cpuSystemMs))}`,
    );
  }
  process.stdout.write("\n");
}

/**
 * A tool executor whose result size is controlled.
 *
 * The payload is real text of the requested size, so the tool-output path
 * (bounded excerpt, attachment decision, event recording) runs exactly as it
 * would with a real tool. Nothing is written to disk by this executor itself.
 */
function stubTools(payloadBytes, callCounter) {
  const text = "x".repeat(payloadBytes);
  return {
    getDefinition(toolName) {
      if (toolName !== "probe") return null;
      return {
        name: "probe",
        version: "1",
        sideEffectClass: "read_only",
        requiresApproval: false,
        concurrencySafe: true,
      };
    },
    async preview() {
      return null;
    },
    async requiresApproval() {
      return false;
    },
    discardApproval() {},
    async execute() {
      callCounter.count += 1;
      return { status: "succeeded", text };
    },
  };
}

/**
 * A provider that asks for N tool calls and then finishes.
 *
 * It returns a small response on purpose: this measures Harness overhead, so the
 * provider's own payload must not dominate the number.
 */
function stubProvider(toolCallsPerTurn, perTurn) {
  return {
    async complete(request) {
      const turn = perTurn.count;
      // Count tool results only since the current turn's user message. Counting the
      // whole conversation would keep seeing earlier turns' results and never stop.
      const alreadyCalled = countToolResultsSinceTurnStart(request.conversation, turn);
      if (alreadyCalled < toolCallsPerTurn) {
        const callIndex = alreadyCalled;
        return {
          kind: "completed",
          text: `turn ${turn} step ${callIndex}`,
          toolCalls: [
            {
              // The arguments carry the turn and step, so every call is distinct.
              // Identical repeated calls are what the no-progress detector exists to
              // catch, and it would stop this measurement at the second turn.
              providerToolCallId: `call-${turn}-${callIndex}`,
              toolName: "probe",
              arguments: { turn, step: callIndex, nonce: randomUUID() },
            },
          ],
        };
      }
      return { kind: "completed", text: `turn ${turn} complete`, toolCalls: [] };
    },
  };
}

/**
 * Count tool results belonging to the current turn.
 *
 * The conversation is a flat list of user/assistant/tool_result items, so the
 * turn boundary is the last user message that starts the current task.
 */
function countToolResultsSinceTurnStart(conversation, turn) {
  const marker = `measure turn ${turn}`;
  let start = -1;
  for (let index = 0; index < conversation.length; index += 1) {
    const item = conversation[index];
    if (item.kind === "user" && typeof item.text === "string" && item.text.includes(marker)) {
      start = index;
    }
  }
  let count = 0;
  for (let index = start + 1; index < conversation.length; index += 1) {
    if (conversation[index]?.kind === "tool_result") count += 1;
  }
  return count;
}

const appendStats = { calls: 0 };

/**
 * Count appends and surface the underlying failure.
 *
 * The coordinator reduces any append error to `session_persistence_failed`, which
 * hides the cause; this reports the real code so a measurement failure is
 * diagnosable rather than mysterious.
 */
function wrapLog(inner) {
  return {
    append: async (input) => {
      appendStats.calls += 1;
      try {
        return await inner.append(input);
      } catch (error) {
        process.stderr.write(`append failed [${input.type}]: ${error?.message}\n`);
        throw error;
      }
    },
    read: (sessionId) => inner.read(sessionId),
    readWithRecovery: (sessionId) => inner.readWithRecovery(sessionId),
    acquireSessionOwnership: (sessionId) => inner.acquireSessionOwnership(sessionId),
  };
}

async function runOneTurn(coordinator, turn) {
  const started = Date.now();
  const result = await coordinator.run(`measure turn ${turn}`);
  return {
    status: result.status,
    safeCode: result.safeCode ?? null,
    elapsedMs: Date.now() - started,
  };
}

/** Surface the underlying cause instead of the coordinator's generic code. */
process.on("unhandledRejection", (error) => {
  process.stderr.write(`unhandled: ${error?.stack ?? error}\n`);
});

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "lycwl-footprint-"));
  const sessionId = "ws-footprint";

  process.stdout.write(
    [
      "lycwl-agent footprint measurement",
      "",
      `  turns                 ${TURNS}`,
      `  tool calls per turn   ${TOOL_CALLS_PER_TURN}`,
      `  tool payload bytes    ${TOOL_BYTES}`,
      `  provider              stub (no network)`,
      `  data directory        ${root}`,
      "",
    ].join("\n"),
  );

  const callCounter = { count: 0 };
  const perTurn = { count: 0 };
  const coordinator = new RuntimeCoordinator({
    provider: stubProvider(TOOL_CALLS_PER_TURN, perTurn),
    tools: stubTools(TOOL_BYTES, callCounter),
    approvals: { decide: async () => "approved" },
    eventLog: wrapLog(new JsonlEventLog(root, ids, digests)),
    checkpoints: new JsonlCheckpointStore(root, digests),
    ids,
    nowUtc: () => new Date().toISOString(),
    suspendOnApproval: false,
    sessionId,
    spillStore: createSpillStore({
      sessionDirectory: path.join(root, "sessions", sessionId),
      workspaceRoot: root,
    }),
  });

  const afterSetup = readFootprint();
  printFootprint("after construction", afterSetup);

  const turnTimings = [];
  let peakRss = afterSetup.rss;

  for (let turn = 1; turn <= TURNS; turn += 1) {
    perTurn.count = turn;
    const outcome = await runOneTurn(coordinator, turn);
    if (outcome.status !== "completed") {
      const pending = coordinator.pendingApprovalView();
      process.stderr.write(
        `turn ${turn} ended ${outcome.status}:${outcome.safeCode ?? ""} pendingApproval=${pending === null ? "none" : pending.toolName}\n`,
      );
    }
    turnTimings.push(outcome);
    const now = readFootprint();
    if (now.rss > peakRss) peakRss = now.rss;
    // RSS minus the parts V8 accounts for is native memory the heap report does
    // not cover: Buffers held outside arrayBuffers, native handles, allocator
    // retention. Tracking it separately is what makes the growth attributable.
    // With --expose-gc, collect before measuring so retained memory is separated
    // from memory V8 simply has not returned to the OS yet.
    if (typeof globalThis.gc === "function") {
      globalThis.gc();
      const collected = readFootprint();
      process.stdout.write(
        `        after gc: rss ${mb(collected.rss)}  heapUsed ${mb(collected.heapUsed)}  heapTotal ${mb(collected.heapTotal)}\n`,
      );
    }
    const accounted = now.heapTotal + now.external;
    const native = now.rss - accounted;
    process.stdout.write(
      `turn ${String(turn).padStart(2)}  ${outcome.status.padEnd(9)}  ${ms(outcome.elapsedMs).padStart(9)}  rss ${mb(now.rss).padStart(8)}  heap ${mb(now.heapUsed).padStart(8)}  ext ${mb(now.external).padStart(7)}  ab ${mb(now.arrayBuffers).padStart(7)}  native ${mb(native).padStart(8)}\n`,
    );
  }

  // Real use is intermittent: the process sits idle while the user reads a reply.
  // V8's memory reducer returns idle pages on that timescale, so an idle window is
  // measured separately from the post-turn number.
  if (IDLE_MS > 0) {
    const beforeIdle = readFootprint();
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
    const afterIdle = readFootprint();
    process.stdout.write(
      `idle ${IDLE_MS}ms: rss ${mb(beforeIdle.rss)} -> ${mb(afterIdle.rss)}  heapTotal ${mb(beforeIdle.heapTotal)} -> ${mb(afterIdle.heapTotal)}\n\n`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const afterTurns = readFootprint();
  printFootprint(`after ${TURNS} turns (settled ${SETTLE_MS}ms)`, afterTurns, afterSetup);

  // The event log is the durable trail; its size is the on-disk cost of the run.
  let logBytes = 0;
  try {
    const info = await stat(path.join(root, "sessions", sessionId, "events.jsonl"));
    logBytes = info.size;
  } catch {
    logBytes = -1;
  }

  const totalMs = turnTimings.reduce((sum, entry) => sum + entry.elapsedMs, 0);
  const cpuTotal = afterTurns.cpuUserMs + afterTurns.cpuSystemMs;
  const cpuSetup = afterSetup.cpuUserMs + afterSetup.cpuSystemMs;

  process.stdout.write("summary\n");
  printRow("peak RSS", mb(peakRss));
  printRow("RSS growth over turns", mb(afterTurns.rss - afterSetup.rss));
  printRow("heapUsed growth over turns", mb(afterTurns.heapUsed - afterSetup.heapUsed));
  printRow("RSS growth per turn", mb((afterTurns.rss - afterSetup.rss) / TURNS));
  printRow("CPU over all turns", ms(cpuTotal - cpuSetup));
  printRow("CPU per turn", ms((cpuTotal - cpuSetup) / TURNS));
  printRow("wall per turn", ms(totalMs / TURNS));
  printRow("tool calls executed", String(callCounter.count));
  printRow("events.jsonl", logBytes < 0 ? "(missing)" : mb(logBytes));
  printRow("log bytes per turn", logBytes < 0 ? "(missing)" : `${Math.round(logBytes / TURNS)} B`);
  process.stdout.write("\n");

  const failures = turnTimings.filter((entry) => entry.status !== "completed");
  if (failures.length > 0) {
    process.stdout.write(
      `non-completed turns: ${failures.map((f) => `${f.status}:${f.safeCode}`).join(", ")}\n`,
    );
  }

  printRow("append calls", String(appendStats.calls));

  await coordinator.closeSession("measure-close");
  await rm(root, { recursive: true, force: true });
}

await main();
