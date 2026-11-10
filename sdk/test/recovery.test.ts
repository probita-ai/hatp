// Coordinator recovery from the decision log (spec §6.1): presumed abort without a logged commit,
// and phase 2 finished with the logged decision when there is one.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCoordinator, createSigner, FileLog, MemoryLog, readFileLog, verifyRecord } from "../src/index.ts";
import type { LogItem, Participant, TxnEvent, TxnLog } from "../src/index.ts";
import { buildWorld, tripPlan } from "./fixtures.ts";

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
// Short deadlines, so the crashed coordinator's leftover timers end quickly.
const plan = () => tripPlan({ prepareOrder: "parallel", deadline: inMs(1500) }, { decideBy: inMs(1200) });

/** A coordinator that dies right after `when` is logged: its log stops there, as a real crash's would. */
function crashing(when: (e: TxnEvent) => boolean, store: TxnLog = new MemoryLog(), o: Parameters<typeof buildWorld>[0] = {}) {
  let dead = false;
  const log: TxnLog = {
    append: (t, e) => { if (!dead) store.append(t, e); },
    keep: (t, item: LogItem) => { if (!dead) store.keep?.(t, item); },
  };
  const w = buildWorld({ ...o, coordinator: { log, onEvent: (e) => { if (!dead && when(e)) { dead = true; throw new Error("coordinator crashed"); } } } });
  return { w, store };
}

/**
 * A coordinator that goes silent in phase 2: its log stops after `when`, and its call to the payments
 * server never returns. A throw there would be caught as a commit failure, which is not a crash.
 */
function stalling(when: (e: TxnEvent) => boolean, o: Parameters<typeof buildWorld>[0] = {}) {
  let dead = false;
  const store = new MemoryLog();
  const log: TxnLog = {
    append: (t, e) => { if (!dead) store.append(t, e); if (when(e)) dead = true; },
    keep: (t, item: LogItem) => { if (!dead) store.keep(t, item); },
  };
  const w: ReturnType<typeof buildWorld> = buildWorld({
    ...o,
    coordinator: {
      log,
      participants: (id) => {
        const real = [w.airline, w.hotel, w.calendar, w.payments, w.gateway].find((p) => p.id === id);
        return real === w.payments ? ({ ...w.payments, commit: () => new Promise(() => {}) } as Participant) : real;
      },
    },
  });
  return { w, store };
}

const settle = async (check: () => boolean) => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

/** A different coordinator, with its own key, taking over from the same log. */
function replacement(w: ReturnType<typeof buildWorld>) {
  const signer = createSigner("agent://acme.com/coordinator-2");
  w.keyring.add(signer.publicJwk);
  return createCoordinator({ id: signer.id, signer, participants: (id) => [w.airline, w.hotel, w.calendar, w.payments, w.gateway].find((p) => p.id === id), gateways: { "acme.com": w.gateway.id }, keyring: w.keyring });
}

test("a crash after the commit decision: the replacement finishes phase 2 with the logged decision", async () => {
  const { w, store } = crashing((e) => e.type === "decision" && e.data.decision === "commit");
  await assert.rejects(w.coordinator.run(plan()), /crashed/);
  assert.deepEqual(w.effects, [], "nothing was committed before the crash");

  const [record] = await replacement(w).recover((store as MemoryLog).lines);
  assert.equal(record.state, "COMMITTED");
  assert.deepEqual(w.effects, ["calendar:created", "payments:charged", "airline:ticketed:14C", "hotel:booked"]);
  assert.equal(record.decision?.issuer, "agent://acme.com/coordinator", "the original signed decision is presented unchanged");
  assert.ok(record.events.some((e) => e.type === "recovered"));
  assert.deepEqual(verifyRecord(record, w.keyring), { ok: true, problems: [] }, "one hash chain across both coordinators, and every receipt");
});

test("a crash before any decision is a presumed abort: holds are released, asks withdrawn", async () => {
  const { w, store } = crashing((e) => e.type === "voted" && e.data.branchId === "flight", undefined, { script: { "human://acme.com/alice": "ignore" } });
  await assert.rejects(w.coordinator.run(plan()), /crashed/);

  const [record] = await replacement(w).recover((store as MemoryLog).lines);
  assert.equal(record.state, "ABORTED");
  assert.equal(record.decision?.decision, "abort");
  assert.equal(record.decision?.issuer, "agent://acme.com/coordinator-2", "the abort is the replacement's own decision");
  assert.ok(w.effects.some((e) => e.startsWith("airline:released")), "the seat hold was released");
  assert.ok(!w.effects.some((e) => /ticketed|booked|charged|created/.test(e)));
  await settle(() => w.gateway.inspect().inflight.length === 0); // the withdrawn ask winds down a moment later
  assert.deepEqual(w.gateway.inspect().inflight, [], "the open ask was withdrawn");
});

test("a crash midway through phase 2: committed branches aren't committed again", async () => {
  const { w, store } = stalling((e) => e.type === "committed" && e.data.branchId === "calendar");
  void w.coordinator.run(plan()); // never finishes: it is stuck calling the payments server
  await settle(() => w.effects.length > 0);
  assert.deepEqual(w.effects, ["calendar:created"]);

  const [record] = await replacement(w).recover(store.lines);
  assert.equal(record.state, "COMMITTED");
  assert.equal(w.effects.filter((e) => e === "calendar:created").length, 1);
  assert.deepEqual(verifyRecord(record, w.keyring), { ok: true, problems: [] });
});

test("a final step that fails during recovery rolls back what was committed", async () => {
  const { w, store } = stalling((e) => e.type === "committed" && e.data.branchId === "calendar", { paymentsFail: true });
  void w.coordinator.run(plan());
  await settle(() => w.effects.length > 0);

  const [record] = await replacement(w).recover(store.lines);
  assert.ok(["ABORTED", "NEEDS_ATTENTION"].includes(record.state), record.state);
  assert.ok(w.effects.includes("calendar:deleted:EVT-1"), "the calendar entry was compensated with its logged token");
  assert.ok(!w.effects.includes("airline:ticketed:14C"));
});

test("recovery works from a file, and finished transactions are left alone", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "hatp-log-")), "decisions.jsonl");
  const { w } = crashing((e) => e.type === "decision" && e.data.decision === "commit", new FileLog(path));
  await assert.rejects(w.coordinator.run(plan()), /crashed/);

  const takeover = replacement(w);
  const [record] = await takeover.recover(readFileLog(path));
  assert.equal(record.state, "COMMITTED");
  assert.deepEqual(await takeover.recover((w.log as MemoryLog).lines), [], "the fixture's own log has nothing unfinished");
});

test("a run that fails partway stops renewing holds and leaves the rest to recovery", async () => {
  // The log can't be written once the flight has voted (a full disk, say). Leases are 1 s, so a
  // renewal left running would fire within half a second.
  let renewals = 0;
  const failing: TxnLog = { append: (_t, e) => { if (e.type === "voted" && e.data.branchId === "flight") throw new Error("disk full"); } };
  const w: ReturnType<typeof buildWorld> = buildWorld({
    leaseSeconds: 1,
    coordinator: {
      log: failing,
      participants: (id) => {
        const real = [w.airline, w.hotel, w.calendar, w.payments, w.gateway].find((p) => p.id === id);
        return real === w.airline ? ({ ...w.airline, renew: async (req) => { renewals++; return w.airline.renew!(req); } } as Participant) : real;
      },
    },
  });
  await assert.rejects(w.coordinator.run(plan()), /disk full/);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(renewals, 0, "no timer outlived the failed run");
});
