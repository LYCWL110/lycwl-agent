import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";
import { SEARCH_LEDGER_LIMITS } from "../../src/domain/web/search-ledger.ts";

let root = "";
let ledgerDir = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-search-"));
  ledgerDir = path.join(root, "ledger");
  await mkdir(ledgerDir, { recursive: true });
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

/** A resolver standing in for the credential boundary; never a real key. */
async function credential(): Promise<string | null> {
  return "tvly-test-not-a-real-key";
}

function tools(overrides: Record<string, unknown> = {}) {
  return createWorkspaceTools({
    workspaceRoot: root,
    approvals: { decide: async () => "approved" },
    ids: { create: () => "id" },
    enableWrites: false,
    enableProcesses: false,
    enableWeb: true,
    searchLedgerDirectory: ledgerDir,
    resolveSearchApiKey: credential,
    ...overrides,
  });
}

async function ledgerLines(): Promise<string[]> {
  try {
    const raw = await readFile(path.join(ledgerDir, "search-ledger.jsonl"), "utf8");
    return raw.split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

describe("web_search without a configured backend", () => {
  it("fails closed and writes no reservation when no credential boundary is composed", async () => {
    const t = tools({ sessionId: "s-1", runId: "r-1", resolveSearchApiKey: undefined });
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "web_search",
      arguments: { query: "typescript" },
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.safeCode, "search_backend_not_configured");
    assert.deepEqual(await ledgerLines(), []);
  });

  it("fails closed without a reservation when the vault has no key", async () => {
    const t = tools({
      sessionId: "s-1b",
      runId: "r-1b",
      resolveSearchApiKey: async () => null,
    });
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "web_search",
      arguments: { query: "typescript" },
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.safeCode, "search_backend_not_configured");
    // Nothing was sent, so no quota slot may be consumed.
    assert.deepEqual(await ledgerLines(), []);
  });

  it("treats a vault failure as a non-send", async () => {
    const t = tools({
      sessionId: "s-1c",
      runId: "r-1c",
      resolveSearchApiKey: async () => {
        throw new Error("vault_unavailable");
      },
    });
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "web_search",
      arguments: { query: "typescript" },
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.safeCode, "search_backend_not_configured");
    assert.deepEqual(await ledgerLines(), []);
  });
});

describe("web_search reservation ordering", () => {
  it("reserves before attempting the request", async () => {
    const t = tools({ sessionId: "s-2", runId: "r-2" });
    await t.execute({
      toolCallId: "c1",
      toolName: "web_search",
      arguments: { query: "reservation ordering" },
    });

    const lines = await ledgerLines();
    assert.equal(lines.length >= 1, true, "a reservation must exist");

    const first = JSON.parse(lines[0] ?? "{}") as { kind?: string };
    assert.equal(first.kind, "reserved", "the first entry must be the reservation");
  });

  it("records an uncertain charge when the request cannot be confirmed", async () => {
    const t = tools({ sessionId: "s-3", runId: "r-3" });
    await t.execute({
      toolCallId: "c1",
      toolName: "web_search",
      arguments: { query: "uncertain charge case" },
    });

    const lines = await ledgerLines();
    const kinds = lines.map((line) => (JSON.parse(line) as { kind: string }).kind);
    assert.equal(kinds.includes("reserved"), true);
    // Either the call reached the vendor (reported) or it is uncertain; it must
    // never silently disappear.
    assert.equal(kinds.includes("reported") || kinds.includes("uncertain"), true);
  });

  it("binds the reservation to the invocation, not the query text", async () => {
    const runId = "run-identity";
    const t = tools({ sessionId: "s-ident", runId });

    // Two different calls with the identical query must be two reservations.
    await t.execute({ toolCallId: "call-a", toolName: "web_search", arguments: { query: "same" } });
    await t.execute({ toolCallId: "call-b", toolName: "web_search", arguments: { query: "same" } });

    const reservations = (await ledgerLines())
      .map((line) => JSON.parse(line) as { reservationId: string; kind: string; runId: string })
      .filter((entry) => entry.kind === "reserved" && entry.runId === runId)
      .map((entry) => entry.reservationId);

    assert.equal(reservations.length, 2);
    assert.notEqual(reservations[0], reservations[1], "identical queries are distinct calls");
  });

  it("refuses once the per-Run limit is exhausted", async () => {
    const runId = "run-limited";
    const t = tools({ sessionId: "s-4", runId });

    for (let index = 0; index < SEARCH_LEDGER_LIMITS.callsPerRun; index += 1) {
      await t.execute({
        toolCallId: `c-${index}`,
        toolName: "web_search",
        arguments: { query: `query number ${index}` },
      });
    }

    const over = await t.execute({
      toolCallId: "c-over",
      toolName: "web_search",
      arguments: { query: "one too many" },
    });

    assert.equal(over.status, "failed");
    if (over.status !== "failed") return;
    assert.equal(over.safeCode, "search_run_limit");
  });
});

describe("web_search ledger failure is fail-closed", () => {
  it("refuses to search when the ledger is corrupt", async () => {
    const corruptDir = path.join(root, "corrupt-ledger");
    await mkdir(corruptDir, { recursive: true });
    await writeFile(path.join(corruptDir, "search-ledger.jsonl"), "broken\n", "utf8");

    const t = tools({
      sessionId: "s-5",
      runId: "r-5",
      searchLedgerDirectory: corruptDir,
    });
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "web_search",
      arguments: { query: "corrupt ledger case" },
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.safeCode, "search_ledger_corrupt");
  });
});
