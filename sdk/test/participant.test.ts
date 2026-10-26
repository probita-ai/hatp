import assert from "node:assert/strict";
import { test } from "node:test";
import { createResourceParticipant, createSigner, planDigest } from "../src/index.ts";
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
