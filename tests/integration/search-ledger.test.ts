import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createSearchLedger, makeReservationId } from "../../src/adapters/windows/search-ledger.ts";
import {
  canReserve,
  computeLedgerState,
  isChargeUncertain,
  type LedgerEntry,
  reportedChargeUsd,
  SEARCH_LEDGER_LIMITS,
  utcMonthOf,
  validateTransition,
} from "../../src/domain/web/search-ledger.ts";

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-ledger-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

let counter = 0;
function reservation(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  counter += 1;
  return {
    reservationId: `r-${counter}`,
    utcMonth: "2026-11",
    kind: "reserved",
    runId: "run-1",
    sessionId: "session-1",
    recordedAtUtc: "2026-11-04T00:00:00.000Z",
    chargeUsd: null,
    ...overrides,
  };
}

describe("search ledger rules", () => {
  it("counts reservations per month and per Run", () => {
    const entries = [
      reservation({ runId: "run-1" }),
      reservation({ runId: "run-1" }),
      reservation({ runId: "run-2" }),
      reservation({ runId: "run-2", utcMonth: "2026-10" }),
    ];
    assert.deepEqual(computeLedgerState(entries, "2026-11", "run-1"), {
      reservedInMonth: 3,
      reservedInRun: 2,
    });
  });

  it("refuses a reservation beyond the per-Run limit", () => {
    const entries = Array.from({ length: SEARCH_LEDGER_LIMITS.callsPerRun }, () =>
      reservation({ runId: "run-x" }),
    );
    assert.deepEqual(
      canReserve(entries, {
        reservationId: "new",
        utcMonth: "2026-11",
        runId: "run-x",
        sessionId: "session-1",
        recordedAtUtc: "2026-11-04T00:00:00.000Z",
      }),
      { ok: false, code: "run_limit" },
    );
  });

  it("refuses a reservation beyond the monthly limit", () => {
    const entries = Array.from({ length: SEARCH_LEDGER_LIMITS.callsPerUtcMonth }, (_, index) =>
      reservation({ runId: `run-${index}` }),
    );
    assert.deepEqual(
      canReserve(entries, {
        reservationId: "new",
        utcMonth: "2026-11",
        runId: "run-fresh",
        sessionId: "session-1",
        recordedAtUtc: "2026-11-04T00:00:00.000Z",
      }),
      { ok: false, code: "monthly_limit" },
    );
  });

  it("never lets a reservation be duplicated", () => {
    const entries = [reservation({ reservationId: "same" })];
    assert.deepEqual(
      canReserve(entries, {
        reservationId: "same",
        utcMonth: "2026-11",
        runId: "run-1",
        sessionId: "session-1",
        recordedAtUtc: "2026-11-04T00:00:00.000Z",
      }),
      { ok: false, code: "duplicate_reservation" },
    );
  });

  it("allows reserved -> possibly_sent -> reported", () => {
    const base = reservation({ reservationId: "chain" });
    let entries: LedgerEntry[] = [base];

    const sent = { ...base, kind: "possibly_sent" as const };
    const sentResult = validateTransition(entries, sent);
    assert.equal(sentResult.ok, true);
    entries = [base, sent];

    const reported = { ...base, kind: "reported" as const, chargeUsd: 0.002 };
    assert.equal(validateTransition(entries, reported).ok, true);
  });

  it("refuses to report a charge as zero when it is unknown", () => {
    const base = reservation({ reservationId: "chain2" });
    const reported = { ...base, kind: "reported" as const, chargeUsd: null };
    assert.deepEqual(validateTransition([base], reported), {
      ok: false,
      code: "invalid_entry",
    });
  });

  it("refuses a state entry for an unknown reservation", () => {
    assert.deepEqual(
      validateTransition([], {
        ...reservation({ reservationId: "ghost" }),
        kind: "reported",
        chargeUsd: 1,
      }),
      { ok: false, code: "unknown_reservation" },
    );
  });

  it("treats an uncertain reservation as not retryable", () => {
    const base = reservation({ reservationId: "unc" });
    const uncertain = { ...base, kind: "uncertain" as const };
    assert.equal(isChargeUncertain([base, uncertain], "unc"), true);
    assert.equal(isChargeUncertain([base], "unc"), false);
  });

  it("sums only reported charges", () => {
    const entries = [
      { ...reservation(), kind: "reported" as const, chargeUsd: 0.01 },
      { ...reservation(), kind: "reported" as const, chargeUsd: 0.02 },
      reservation({ kind: "uncertain" }),
    ];
    assert.equal(Math.round(reportedChargeUsd(entries, "2026-11") * 1000) / 1000, 0.03);
  });

  it("derives the UTC month from the timestamp", () => {
    assert.equal(utcMonthOf("2026-11-04T00:00:00.000Z"), "2026-11");
  });
});

describe("durable search ledger", () => {
  it("reserves and reads back entries", async () => {
    const ledger = createSearchLedger({ directory: path.join(root, "a") });
    const reserved = await ledger.reserve({
      reservationId: "r-1",
      utcMonth: "2026-11",
      runId: "run-1",
      sessionId: "session-1",
      recordedAtUtc: "2026-11-04T00:00:00.000Z",
    });

    assert.equal(reserved.ok, true);
    const all = await ledger.readAll();
    assert.equal(all.ok, true);
    if (!all.ok) return;
    assert.equal(all.value.length, 1);
  });

  it("refuses a second reservation beyond the Run limit", async () => {
    const directory = path.join(root, "b");
    const ledger = createSearchLedger({ directory });
    for (let index = 0; index < SEARCH_LEDGER_LIMITS.callsPerRun; index += 1) {
      const result = await ledger.reserve({
        reservationId: `run1-${index}`,
        utcMonth: "2026-11",
        runId: "run-1",
        sessionId: "session-1",
        recordedAtUtc: "2026-11-04T00:00:00.000Z",
      });
      assert.equal(result.ok, true);
    }
    const over = await ledger.reserve({
      reservationId: "run1-over",
      utcMonth: "2026-11",
      runId: "run-1",
      sessionId: "session-1",
      recordedAtUtc: "2026-11-04T00:00:00.000Z",
    });
    assert.deepEqual(over, { ok: false, code: "run_limit" });
  });

  it("fails closed on a corrupt ledger instead of resetting the count", async () => {
    const directory = path.join(root, "c");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "search-ledger.jsonl"), "not json\n", "utf8");

    const ledger = createSearchLedger({ directory });
    assert.deepEqual(await ledger.readAll(), { ok: false, code: "ledger_corrupt" });
    assert.deepEqual(
      await ledger.reserve({
        reservationId: "x",
        utcMonth: "2026-11",
        runId: "run-1",
        sessionId: "session-1",
        recordedAtUtc: "2026-11-04T00:00:00.000Z",
      }),
      { ok: false, code: "ledger_corrupt" },
    );
  });

  it("reports a locked ledger rather than proceeding unlocked", async () => {
    const directory = path.join(root, "d");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "search-ledger.lock"), "", "utf8");

    const ledger = createSearchLedger({ directory });
    const result = await ledger.reserve({
      reservationId: "x",
      utcMonth: "2026-11",
      runId: "run-1",
      sessionId: "session-1",
      recordedAtUtc: "2026-11-04T00:00:00.000Z",
    });
    assert.deepEqual(result, { ok: false, code: "ledger_unreadable" });
  });

  it("records an uncertain charge and keeps it non-retryable", async () => {
    const directory = path.join(root, "e");
    const ledger = createSearchLedger({ directory });
    const base = {
      reservationId: "unc-1",
      utcMonth: "2026-11",
      runId: "run-1",
      sessionId: "session-1",
      recordedAtUtc: "2026-11-04T00:00:00.000Z",
    };
    await ledger.reserve(base);
    const uncertain = await ledger.record({ ...base, kind: "uncertain", chargeUsd: null });
    assert.equal(uncertain.ok, true);
    assert.equal(await ledger.isUncertain("unc-1"), true);
  });

  it("builds a deterministic reservation id", () => {
    const id = makeReservationId({
      sessionId: "s",
      runId: "r",
      toolCallId: "c",
      query: "q",
    });
    const again = makeReservationId({
      sessionId: "s",
      runId: "r",
      toolCallId: "c",
      query: "q",
    });
    assert.equal(id, again);
    assert.equal(id.length, 32);
  });
});
