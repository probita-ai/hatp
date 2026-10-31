import assert from "node:assert/strict";
import { test } from "node:test";
import { createResourceParticipant, createSigner, HatpError, planDigest } from "../src/index.ts";
import type { Plan } from "../src/index.ts";
import { tripPlan } from "./fixtures.ts";

// A hold-tier airline on a fake clock.
function airline(maxHoldSeconds?: number) {
  const clock = { t: Date.parse("2026-10-25T18:00:00Z") };
  const participant = createResourceParticipant({
    id: "mcp://airline.example/hatp",
    signer: createSigner("mcp://airline.example/hatp"),
    maxLeaseSeconds: 600,
    maxHoldSeconds,
    now: () => clock.t,
    operations: {
      book_seat: {
        tier: "hold",
        async quote() { return { amount: { value: 412, currency: "USD" } }; },
        async prepare() { return { ok: true, holdRef: "HLD-1" }; },
        async commit() { return {}; },
      },
    },
  });
  return { participant, clock };
}

const request = (plan: Plan, leaseSeconds: number) => ({ txnId: plan.txnId, branchId: "flight", planDigest: planDigest(plan), plan, leaseSeconds });

test("a capped hold reports its horizon and signs it into the prepare receipt", async () => {
  const { participant } = airline(1800);
  const vote = await participant.prepare(request(tripPlan(), 1200));

  assert.equal(vote.leaseExpiresAt, "2026-10-25T18:10:00.000Z", "lease capped by maxLeaseSeconds");
  assert.equal(vote.holdHorizon, "2026-10-25T18:30:00.000Z");
  assert.equal(vote.receipt.detail?.holdHorizon, vote.holdHorizon);
});

test("renewals stop at the horizon", async () => {
  const { participant, clock } = airline(900);
  const plan = tripPlan();
  await participant.prepare(request(plan, 600));

  clock.t += 8 * 60_000;
  const r = await participant.renew!(request(plan, 600));
  assert.equal(r.leaseExpiresAt, "2026-10-25T18:15:00.000Z", "renewal clamped to the horizon, not 18:18");
});

test("a lease never starts past the horizon", async () => {
  const { participant } = airline(300);
  const vote = await participant.prepare(request(tripPlan(), 600));
  assert.equal(vote.leaseExpiresAt, vote.holdHorizon);
});

test("an uncapped participant reports no horizon", async () => {
  const { participant } = airline();
  const vote = await participant.prepare(request(tripPlan(), 600));
  assert.equal(vote.holdHorizon, undefined);
});

test("quotes report the hold cap as a duration", async () => {
  const { participant } = airline(1800);
  const q = await participant.quote!(request(tripPlan(), 600));
  assert.equal(q.maxHoldSeconds, 1800);
});

test("a released hold can be prepared again; a live one cannot", async () => {
  const { participant, clock } = airline();
  const plan = tripPlan();
  const first = await participant.prepare(request(plan, 60));
  assert.equal((await participant.prepare(request(plan, 60))).receipt, first.receipt, "idempotent while the hold is live");

  clock.t += 61_000;
  const again = await participant.prepare(request(plan, 60));
  assert.notEqual(again.receipt, first.receipt);
  assert.equal(again.leaseExpiresAt, new Date(clock.t + 60_000).toISOString());
  assert.equal(participant.inspect()[`${plan.txnId}/flight`], "PREPARED");
});

test("a commit retried while the first is still running joins it: the effect runs once", async () => {
  let runs = 0;
  const signer = createSigner("mcp://payments.acme.com/hatp");
  const payments = createResourceParticipant({
    id: signer.id, signer,
    operations: { charge_card: { tier: "final", async prepare() { return { ok: true }; }, async commit() { runs++; await new Promise((r) => setTimeout(r, 30)); return {}; } } },
  });
  const plan = tripPlan();
  const req = { txnId: plan.txnId, branchId: "charge", planDigest: planDigest(plan), plan, leaseSeconds: 60 };
  await payments.prepare(req);
  const decisionRecord = { type: "hatp.decision" as const, txnId: plan.txnId, planDigest: req.planDigest, decision: "commit" as const, decidedAt: new Date().toISOString(), issuer: "agent://acme.com/coordinator" };
  const [a, b] = await Promise.all([payments.commit({ ...req, decisionRecord }), payments.commit({ ...req, decisionRecord })]);
  assert.equal(runs, 1);
  assert.equal(a.receipt, b.receipt);
});

test("a handler that throws is a definite COMMIT_FAILED", async () => {
  const signer = createSigner("mcp://payments.acme.com/hatp");
  const payments = createResourceParticipant({
    id: signer.id, signer,
    operations: { charge_card: { tier: "final", async prepare() { return { ok: true }; }, async commit() { throw new Error("card declined"); } } },
  });
  const plan = tripPlan();
  const req = { txnId: plan.txnId, branchId: "charge", planDigest: planDigest(plan), plan, leaseSeconds: 60 };
  await payments.prepare(req);
  const decisionRecord = { type: "hatp.decision" as const, txnId: plan.txnId, planDigest: req.planDigest, decision: "commit" as const, decidedAt: new Date().toISOString(), issuer: "agent://acme.com/coordinator" };
  await assert.rejects(payments.commit({ ...req, decisionRecord }), (e: HatpError) => e.code === "COMMIT_FAILED" && /card declined/.test(e.message));
});

test("holds-first: an uncapped hold ends at its first lease, and a commit after that is refused", async () => {
  const { participant, clock } = airline();
  const plan = tripPlan({ prepareOrder: "holds-first" });
  const vote = await participant.prepare(request(plan, 300));
  assert.equal(vote.holdHorizon, vote.leaseExpiresAt, "the first lease is the end the humans sign");

  clock.t += 4 * 60_000;
  const r = await participant.renew!(request(plan, 300));
  assert.equal(r.leaseExpiresAt, vote.leaseExpiresAt, "renewal does not run past the signed end");

  clock.t += 2 * 60_000;
  const decisionRecord = { type: "hatp.decision" as const, txnId: plan.txnId, planDigest: planDigest(plan), decision: "commit" as const, decidedAt: new Date(clock.t).toISOString(), issuer: "agent://acme.com/coordinator" };
  await assert.rejects(participant.commit({ txnId: plan.txnId, branchId: "flight", planDigest: planDigest(plan), decisionRecord }), (e: HatpError) => e.code === "HOLD_EXPIRED");
});
