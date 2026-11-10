// Deferred votes (spec §7.1, §7.7): a gateway answers "pending" and the coordinator polls status.
import assert from "node:assert/strict";
import { test } from "node:test";
import { planDigest, verifyRecord } from "../src/index.ts";
import type { Participant, TransactionRecord } from "../src/index.ts";
import { buildWorld, tripPlan } from "./fixtures.ts";

const id = (name: string) => `human://acme.com/${name}`;
// SLAs of 5 s become 500 ms, so a human who takes 150 ms decides well within it.
const slow = (decision: "approve" | "reject", afterMs = 150) => ({ script: { [id("alice")]: { decision, afterMs } }, gatewayMsPerSecond: 100 });
const pending = (pollAfterSeconds = 0.03) => ({ gatewayPending: { afterMs: 20, pollAfterSeconds } });
const gatewayReceipts = (r: TransactionRecord) => r.receipts.filter((x) => x.branchId === "approval:finance").map((x) => x.outcome);

test("a slow decision is a pending vote, then the coordinator polls it in", async () => {
  const w = buildWorld({ ...slow("approve"), ...pending() });
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  assert.equal(record.state, "COMMITTED");
  assert.ok(record.events.some((e) => e.type === "pending" && e.data.branchId === "approval:finance"));
  assert.deepEqual(gatewayReceipts(record).slice(0, 2), ["pending", "yes"], "the signed pending receipt, then the decision");
  assert.equal(record.approvals[0].approver, id("alice"));
  assert.deepEqual(verifyRecord(record, w.keyring), { ok: true, problems: [] });
});

test("a decision inside afterMs comes back from prepare, with no pending vote", async () => {
  const w = buildWorld({ ...slow("approve", 1), gatewayPending: { afterMs: 300, pollAfterSeconds: 0.03 } });
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  assert.equal(record.state, "COMMITTED");
  assert.ok(!record.events.some((e) => e.type === "pending"));
});

test("a rejection that arrives while pending aborts the transaction", async () => {
  const w = buildWorld({ ...slow("reject"), ...pending() });
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  assert.equal(record.state, "ABORTED");
  assert.equal(record.events.find((e) => e.type === "decision")?.data.code, "REJECTED");
  assert.ok(!w.effects.some((e) => !e.includes("released")));
});

test("an abort elsewhere ends the wait at once, and the open ask is withdrawn", async () => {
  // Polls are 5 s apart. The hotel says no after 100 ms; the run must not wait out the poll.
  const w: ReturnType<typeof buildWorld> = buildWorld({
    script: { [id("alice")]: "ignore" }, gatewayMsPerSecond: 100, ...pending(5),
    coordinator: {
      participants: (p) => {
        const real = [w.airline, w.hotel, w.calendar, w.payments, w.gateway].find((x) => x.id === p);
        if (real !== w.hotel) return real;
        return { ...w.hotel, prepare: async (req) => { await new Promise((r) => setTimeout(r, 100)); return { ...(await w.hotel.prepare(req)), vote: "no", reason: { code: "UNAVAILABLE", message: "sold out" } }; } } as Participant;
      },
    },
  });
  const started = Date.now();
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  assert.equal(record.state, "ABORTED");
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.deepEqual(w.gateway.inspect().inflight, [], "the ask was withdrawn");
});

test("a group deadline that passes while pending is heard at the deadline, not at the next poll", async () => {
  // decideBy is 300 ms away and polls are 5 s apart.
  const w = buildWorld({ script: { [id("alice")]: "ignore", [id("bob")]: "ignore", [id("carol")]: "ignore" }, gatewayMsPerSecond: 100, ...pending(5) });
  const plan = tripPlan({ prepareOrder: "parallel" }, { decideBy: new Date(Date.now() + 300).toISOString() });
  const started = Date.now();
  const record = await w.coordinator.run(plan);
  assert.equal(record.state, "ABORTED");
  assert.equal(record.events.find((e) => e.type === "decision")?.data.code, "DEADLINE_EXCEEDED");
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test("a repeated prepare asks nobody twice, and status answers until the outcome", async () => {
  const w = buildWorld({ script: { [id("alice")]: "ignore" }, gatewayMsPerSecond: 100, ...pending() });
  const plan = tripPlan({ prepareOrder: "parallel" });
  const req = { txnId: plan.txnId, branchId: "approval:finance", planDigest: planDigest(plan), plan, leaseSeconds: 60 };
  assert.equal((await w.gateway.prepare(req)).vote, "pending");
  const asked = w.asked.length;
  assert.equal((await w.gateway.prepare(req)).vote, "pending");
  assert.equal(w.asked.length, asked, "no second round of asks");
  assert.equal((await w.gateway.status!(req)).vote, "pending");
  await assert.rejects(w.gateway.status!({ ...req, branchId: "approval:nope" }), /TXN_UNKNOWN/);
  await w.gateway.abort({ ...req, decisionRecord: { type: "hatp.decision", txnId: plan.txnId, planDigest: req.planDigest, decision: "abort", decidedAt: new Date().toISOString(), issuer: "x" } });
  // The withdrawn asks wind down a moment later.
  for (let i = 0; i < 50 && w.gateway.inspect().inflight.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(w.gateway.inspect().inflight, []);
  assert.equal((await w.gateway.prepare(req)).vote, "no", "after the abort the branch is no longer pending");
});

test("a participant that votes pending but serves no status is a no", async () => {
  const w: ReturnType<typeof buildWorld> = buildWorld({
    ...slow("approve"), ...pending(),
    coordinator: {
      participants: (p) => {
        const real = [w.airline, w.hotel, w.calendar, w.payments, w.gateway].find((x) => x.id === p);
        if (real !== w.gateway) return real;
        const { status: _status, ...noStatus } = w.gateway;
        return noStatus as Participant;
      },
    },
  });
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  assert.equal(record.state, "ABORTED");
  assert.equal(record.events.find((e) => e.type === "decision")?.data.code, "NOT_SUPPORTED");
});

test("a transport error while polling is retried, not taken as a no", async () => {
  let failures = 1;
  const w: ReturnType<typeof buildWorld> = buildWorld({
    ...slow("approve"), ...pending(),
    coordinator: {
      participants: (p) => {
        const real = [w.airline, w.hotel, w.calendar, w.payments, w.gateway].find((x) => x.id === p);
        if (real !== w.gateway) return real;
        return { ...w.gateway, status: async (req) => { if (failures-- > 0) throw new Error("socket hang up"); return w.gateway.status!(req); } } as Participant;
      },
    },
  });
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  assert.equal(record.state, "COMMITTED");
  assert.ok(record.events.some((e) => e.type === "status-failed"));
});
