import assert from "node:assert/strict";
import { test } from "node:test";
import { HatpError, createHumanGateway, createSigner, planDigest, signCard, verifyRecord } from "../src/index.ts";
import type { Plan, RecoveryOption, TransactionRecord } from "../src/index.ts";
import { buildWorld, tripPlan } from "./fixtures.ts";

test("commits everything when all participants and the approver say yes", async () => {
  const w = buildWorld();
  const record = await w.coordinator.run(tripPlan());

  assert.equal(record.state, "COMMITTED");
  assert.deepEqual(w.effects, ["calendar:created", "payments:charged", "airline:ticketed:14C", "hotel:booked"]);
  assert.equal(record.approvals[0].approver, "human://acme.com/alice");
  assert.equal(record.approvals[0].planDigest, record.planDigest);
  assert.deepEqual(verifyRecord(record, w.keyring), { ok: true, problems: [] });
});

test("orders phase 2 as compensate → final → holds, after a durable decision", async () => {
  const w = buildWorld();
  const record = await w.coordinator.run(tripPlan());
  const types = record.events.map((e) => (e.type === "committed" ? `committed:${e.data.branchId}` : e.type));
  const decision = types.indexOf("decision");
  assert.ok(decision > 0 && decision < types.indexOf("committed:calendar"));
  assert.ok(types.indexOf("committed:calendar") < types.indexOf("committed:charge"));
  assert.ok(types.indexOf("committed:charge") < types.indexOf("committed:flight"));
  assert.equal(w.log.entries.length, record.events.length);
});

test("one participant voting no releases every hold and withdraws the human ask", async () => {
  const w = buildWorld({ hotelAvailable: false, script: { "human://acme.com/alice": { decision: "approve", afterMs: 200 } } });
  const record = await w.coordinator.run(tripPlan());

  assert.equal(record.state, "ABORTED");
  assert.equal(record.branches.hotel, "VOTED_NO");
  assert.ok(w.effects.some((e) => e.startsWith("airline:released")));
  assert.ok(!w.effects.some((e) => e.includes("charged") || e.includes("ticketed") || e.includes("calendar")));
  assert.equal(record.approvals.length, 0, "the approver was withdrawn before deciding");
  assert.ok(verifyRecord(record, w.keyring).ok);
});

test("a human rejection aborts the whole transaction", async () => {
  const w = buildWorld({ script: { "human://acme.com/alice": { decision: "reject" } } });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.state, "ABORTED");
  assert.equal(record.approvals[0].decision, "reject");
  assert.ok(!w.effects.some((e) => e.includes("charged")));
});

test("escalates to the delegate when the first approver misses their SLA", async () => {
  // alice is ranked first but ignores the ask; her delegate carol approves.
  const w = buildWorld({ script: { "human://acme.com/alice": "ignore", "human://acme.com/carol": { decision: "approve" } } });
  const record = await w.coordinator.run(tripPlan());

  assert.equal(record.state, "COMMITTED");
  const a = record.approvals[0];
  assert.equal(a.approver, "human://acme.com/carol");
  assert.deepEqual(a.routedVia, ["human://acme.com/role/finance-approver", "human://acme.com/alice", "human://acme.com/carol"]);
  assert.match(a.routingReason ?? "", /alice did not decide within SLA/);
});

test("never asks the person the agent acts for (separation of duties) or anyone without authority", async () => {
  const w = buildWorld({ script: { "human://acme.com/alice": "ignore", "human://acme.com/carol": "ignore", "human://acme.com/bob": { decision: "approve" } } });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.state, "COMMITTED");
  assert.ok(!w.asked.includes("human://acme.com/dana"), "requester must not approve own spend");
  assert.ok(!w.asked.includes("human://acme.com/erin"), "erin's $500 limit is below the $1000 requirement");
});

test("quorum 2 requires two distinct approvers", async () => {
  const w = buildWorld({ script: { "human://acme.com/alice": { decision: "approve" }, "human://acme.com/bob": { decision: "approve" } } });
  const record = await w.coordinator.run(tripPlan({}, { quorum: { required: 2 } }));
  assert.equal(record.state, "COMMITTED");
  assert.deepEqual(record.approvals.map((a) => a.approver).sort(), ["human://acme.com/alice", "human://acme.com/bob"]);
});

test("a failing irreversible step compensates earlier steps and releases holds", async () => {
  const w = buildWorld({ paymentsFail: true });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.state, "ABORTED");
  assert.equal(record.branches.calendar, "COMPENSATED");
  assert.ok(w.effects.includes("calendar:deleted:EVT-1"));
  assert.ok(w.effects.some((e) => e.startsWith("airline:released")) && w.effects.includes("hotel:released"));
  assert.ok(!w.effects.some((e) => e.includes("ticketed") || e === "hotel:booked"));
});

test("rejects plans with more than one irreversible step", async () => {
  const w = buildWorld();
  const plan = tripPlan();
  plan.branches.push({ ...plan.branches[3], branchId: "charge2" });
  await assert.rejects(w.coordinator.run(plan), (e: unknown) => e instanceof HatpError && e.code === "PLAN_INVALID" && /compensate|split the plan/.test(e.message));
});

test("approval-first: humans approve quoted prices, and a price jump at hold time aborts", async () => {
  const w = buildWorld({ airlineQuote: 400, airlineHoldPrice: 460 });
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "approval-first", tolerance: { amountPercent: 2 } }));
  assert.equal(record.plan.branches[0].amount?.value, 400, "quote replaced the planned amount before signing");
  assert.equal(record.approvals[0].planDigest, record.planDigest);
  assert.equal(record.state, "ABORTED");
  assert.ok(record.events.some((e) => e.data.code === "AMOUNT_CHANGED"));
  assert.ok(w.effects.some((e) => e.startsWith("airline:released")), "the overpriced hold was released");
});

test("renews short leases before committing", async () => {
  const w = buildWorld({ leaseSeconds: 5 });
  const record = await w.coordinator.run(tripPlan());
  assert.ok(record.events.some((e) => e.type === "renewed"));
});

test("tampering with a record is detected offline", async () => {
  const w = buildWorld();
  const record = await w.coordinator.run(tripPlan());
  const tampered = structuredClone(record);
  tampered.plan.branches[0].amount = { value: 1, currency: "USD" };
  tampered.events.splice(2, 1);
  const result = verifyRecord(tampered, w.keyring);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("signature")));
  assert.ok(result.problems.some((p) => p.includes("hash chain")));
});

test("directory refuses cards that are not signed by a trusted issuer", () => {
  const w = buildWorld();
  const rogue = createSigner("https://evil.example");
  const card = signCard({ id: "human://acme.com/mallory", displayName: "m", org: "acme.com", roles: ["finance-approver"], authority: [{ action: "approve.spend" }], channels: ["web"], keys: [], issuer: rogue.id }, rogue);
  assert.throws(() => w.directory.add(card), /no valid issuer signature/);
});

test("chooses parallel when the escalation chain fits inside the shortest hold", async () => {
  const w = buildWorld({ airlineMaxHoldSeconds: 3600 });
  const record = await w.coordinator.run(tripPlan());
  const chosen = record.events.find((e) => e.type === "prepare-order")!;
  assert.equal(chosen.data.prepareOrder, "parallel");
  assert.equal(record.plan.prepareOrder, "parallel", "the chosen mode is part of the signed plan");
  assert.equal(record.state, "COMMITTED");
});

test("switches to approval-first when a hold would expire before the humans decide", async () => {
  const w = buildWorld({ airlineMaxHoldSeconds: 20 });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.events.find((e) => e.type === "prepare-order")!.data.prepareOrder, "approval-first");
  assert.ok(record.events.some((e) => e.type === "quoted"));
  assert.equal(record.state, "COMMITTED");
});

test("an explicit prepareOrder is never overridden", async () => {
  const w = buildWorld({ airlineMaxHoldSeconds: 20 });
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  assert.ok(!record.events.some((e) => e.type === "prepare-order"));
  assert.equal(record.plan.prepareOrder, "parallel");
});

// With the default 40 s margin, a 41 s hold leaves the humans 1 s, well inside the signed 30 s decideBy.
const tightWorld = (afterMs: number) =>
  buildWorld({ airlineMaxHoldSeconds: 41, gatewayMsPerSecond: 1000, script: { "human://acme.com/alice": { decision: "approve", afterMs } } });

test("a hold's horizon tightens the human deadline, and a decision inside it commits", async () => {
  const w = tightWorld(100);
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  const tightened = record.events.find((e) => e.type === "deadline-tightened")!;
  assert.equal(tightened.data.hold, "flight");
  assert.ok(Date.parse(tightened.data.decideBy as string) < Date.parse(record.plan.approvals![0].decideBy));
  assert.ok(record.receipts.some((r) => r.phase === "tighten" && r.outcome === "tightened"));
  assert.equal(record.state, "COMMITTED");
});

test("a human who would decide after the hold ends is cut off at the tightened deadline", async () => {
  const w = tightWorld(2000);
  const started = Date.now();
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  assert.ok(Date.now() - started < 1900, "did not wait for the late decision");
  assert.equal(record.state, "ABORTED");
  assert.ok(record.events.some((e) => e.type === "voted" && e.data.code === "DEADLINE_EXCEEDED"));
  assert.ok(w.effects.some((e) => e.startsWith("airline:released")));
});

test("the coordinator enforces the tightened deadline when the gateway can't", async () => {
  const w = tightWorld(2000);
  w.gateway.tighten = undefined;
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  assert.equal(record.state, "ABORTED");
  assert.match(String(record.events.find((e) => e.data.code === "DEADLINE_EXCEEDED")?.data.message), /flight hold ends before a decision/);
});

test("the gateway refuses to extend a signed decideBy", async () => {
  const w = buildWorld();
  const plan = tripPlan();
  const later = new Date(Date.parse(plan.approvals![0].decideBy) + 60_000).toISOString();
  await assert.rejects(
    w.gateway.tighten!({ txnId: plan.txnId, branchId: "approval:finance", planDigest: planDigest(plan), plan, decideBy: later }),
    (e: HatpError) => e.code === "INVALID_STATE",
  );
});

test("a tighten for a finished group is dropped once its signed decideBy passes", async () => {
  let clock = Date.now();
  const w = buildWorld();
  const gateway = createHumanGateway({ id: "mcp://gateway.acme.com/hatp", signer: createSigner("mcp://gateway.acme.com/hatp"), directory: w.directory, channel: { deliver: () => new Promise(() => {}) }, now: () => clock });
  const tighten = (p: Plan) => gateway.tighten!({ txnId: p.txnId, branchId: "approval:finance", planDigest: planDigest(p), plan: p, decideBy: new Date(clock).toISOString() });

  const late = tripPlan();
  await tighten(late); // arrives after the group finished: no prepare will ever clear it
  assert.deepEqual(gateway.inspect().cutoffs, [`${late.txnId}/approval:finance`]);

  clock = Date.parse(late.approvals![0].decideBy) + 1;
  const next = tripPlan({}, { decideBy: new Date(clock + 60_000).toISOString() });
  await tighten(next);
  assert.deepEqual(gateway.inspect().cutoffs, [`${next.txnId}/approval:finance`]);
});

// The airline grants 0.4 s leases; the approver answers on a real-time SLA clock.
const shortLeaseWorld = (afterMs: number) =>
  buildWorld({ airlineMaxLeaseSeconds: 0.4, gatewayMsPerSecond: 1000, script: { "human://acme.com/alice": { decision: "approve", afterMs } } });

// Delays the airline's renewals until its lease has lapsed, so it releases the hold for real.
function loseHoldOnRenew(w: ReturnType<typeof buildWorld>, times: number) {
  const renew = w.airline.renew!.bind(w.airline);
  w.airline.renew = async (req) => {
    if (times-- > 0) await new Promise((r) => setTimeout(r, 500));
    return renew(req);
  };
}

test("renews holds while the human decides", async () => {
  const w = shortLeaseWorld(1000);
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  const types = record.events.map((e) => (e.type === "renewed" ? `renewed:${e.data.branchId}` : e.type));
  assert.ok(types.indexOf("renewed:flight") < types.indexOf("approval"), "renewed before the approval arrived");
  assert.equal(record.state, "COMMITTED");
  assert.ok(!w.effects.some((e) => e.startsWith("airline:released")));
});

test("a hold lost while waiting is placed again, and the approval still counts", async () => {
  const w = shortLeaseWorld(1200);
  loseHoldOnRenew(w, 1);
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  assert.equal(record.events.filter((e) => e.type === "hold-lost").length, 1);
  assert.ok(w.effects.includes("airline:released:HLD-1"), "the participant released the lapsed hold");
  assert.ok(record.receipts.some((r) => r.phase === "prepare" && r.detail?.holdRef === "HLD-2"), "a new hold was placed");
  assert.equal(record.state, "COMMITTED");
  assert.ok(w.effects.includes("airline:ticketed:14C"));
});

test("a hold lost a second time aborts and withdraws the ask", async () => {
  const w = shortLeaseWorld(3000);
  loseHoldOnRenew(w, 2);
  const started = Date.now();
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  assert.ok(Date.now() - started < 2500, "did not wait for the human");
  assert.equal(record.state, "ABORTED");
  assert.ok(record.events.some((e) => e.type === "voted" && e.data.branchId === "flight" && e.data.code === "HOLD_EXPIRED"));
  assert.equal(record.approvals.length, 0);
});

// The payments server (the final step) runs `script` per commit attempt instead of its plain commit.
function scriptPayments(w: ReturnType<typeof buildWorld>, script: ((commit: () => Promise<unknown>) => Promise<unknown>)[]) {
  const commit = w.payments.commit.bind(w.payments);
  let attempt = 0;
  w.payments.commit = (req) => script[Math.min(attempt++, script.length - 1)](() => commit(req)) as ReturnType<typeof commit>;
}
const lost = new Error("socket hang up");

test("a final step whose response is lost is in doubt, then resolved by retrying: charged once, nothing voided", async () => {
  const w = buildWorld({ coordinator: { inDoubtRetryMs: 10 } });
  scriptPayments(w, [async (commit) => { await commit(); throw lost; }, (commit) => commit()]);
  const record = await w.coordinator.run(tripPlan());

  assert.equal(record.state, "COMMITTED");
  assert.equal(w.effects.filter((e) => e === "payments:charged").length, 1);
  assert.ok(w.effects.includes("airline:ticketed:14C"));
  assert.ok(!w.effects.some((e) => e.startsWith("airline:released")), "the card-paid seat was not voided");
  assert.deepEqual(record.events.filter((e) => e.type === "in-doubt" || e.type === "resolved").map((e) => e.type), ["in-doubt", "resolved"]);
  assert.ok(verifyRecord(record, w.keyring).ok);
});

test("a final step in doubt that turns out to have failed rolls back as usual", async () => {
  const w = buildWorld({ paymentsFail: true, coordinator: { inDoubtRetryMs: 10 } });
  scriptPayments(w, [async () => { throw lost; }, (commit) => commit()]);
  const record = await w.coordinator.run(tripPlan());

  assert.equal(record.state, "ABORTED");
  assert.equal(record.events.find((e) => e.type === "resolved")?.data.outcome, "failed");
  assert.ok(w.effects.some((e) => e.startsWith("airline:released")));
  assert.equal(record.branches.calendar, "COMPENSATED");
});

test("a final step still in doubt when the holds run out escalates without voiding them", async () => {
  // The airline holds for 41 s; with the 40 s margin the coordinator must decide within about 1 s.
  const w = buildWorld({ airlineMaxHoldSeconds: 41, coordinator: { inDoubtRetryMs: 10 } });
  scriptPayments(w, [async () => { throw lost; }]);
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));

  assert.equal(record.state, "NEEDS_ATTENTION");
  assert.equal(record.branches.charge, "IN_DOUBT");
  assert.equal(record.branches.flight, "PREPARED", "the hold is left for a human to capture or void");
  assert.ok(!w.effects.some((e) => e.startsWith("airline:released") || e === "payments:charged"));
  assert.ok(record.events.some((e) => e.type === "escalated"));
  assert.ok(record.events.filter((e) => e.type === "in-doubt-retry").length > 1, "kept retrying until the limit");
});

// ---- a NO vote releases every hold (#3) ----

for (const [why, setup] of [
  ["the approver rejects", () => ({ w: buildWorld({ script: { "human://acme.com/alice": { decision: "reject" } } }), plan: tripPlan() })],
  ["a hold can't be placed", () => ({ w: buildWorld({ hotelAvailable: false }), plan: tripPlan() })],
  ["the final step can't run", () => {
    const plan = tripPlan();
    plan.branches[3].operation.tool = "wire_money"; // the payments server doesn't offer it, so it votes no
    return { w: buildWorld(), plan };
  }],
] as const) {
  test(`a NO vote releases every hold: ${why}`, async () => {
    const { w, plan } = setup();
    const record = await w.coordinator.run(plan);

    assert.equal(record.state, "ABORTED");
    for (const p of [w.airline, w.hotel]) {
      const held = Object.entries(p.inspect()).filter(([k, state]) => k.startsWith(plan.txnId) && state === "PREPARED");
      assert.deepEqual(held, [], `${p.id} still holds something`);
    }
    assert.ok(w.effects.some((e) => e.startsWith("airline:released")), "the seat hold was released");
    assert.ok(!w.effects.some((e) => /ticketed|booked|charged|calendar:created/.test(e)), "nothing took effect");
    assert.ok(verifyRecord(record, w.keyring).ok);
  });
}

// ---- escalation lead time (#30) ----

// The airline holds for an hour plus 41 s. With a one-hour lead and the 40 s margin, about 1 s is left.
const leadPlan = (overrides: Partial<Plan> = {}) => tripPlan({ prepareOrder: "parallel", escalation: { leadSeconds: 3600 }, ...overrides });

test("an in-doubt final step escalates leadSeconds before the shortest hold ends", async () => {
  const w = buildWorld({ airlineMaxHoldSeconds: 3641, coordinator: { inDoubtRetryMs: 10, latePollMs: 0 } });
  scriptPayments(w, [async () => { throw lost; }]);
  const started = Date.now();
  const record = await w.coordinator.run(leadPlan());

  assert.ok(Date.now() - started < 3000, "did not wait out the hold");
  assert.equal(record.state, "NEEDS_ATTENTION");
  const horizon = Date.parse(record.receipts.find((r) => r.branchId === "flight" && r.phase === "prepare")!.detail!.holdHorizon as string);
  const escalated = record.events.find((e) => e.type === "escalated")!;
  assert.ok(horizon - Date.parse(escalated.at) >= 3600_000, "a human has the lead time before the hold ends");
  assert.equal(escalated.data.leadSeconds, 3600);
  assert.equal(record.plan.escalation?.leadSeconds, 3600, "the lead time is in the signed plan");
  assert.equal(record.approvals[0].planDigest, record.planDigest);
});

test("the human deadline also leaves the lead time", async () => {
  const w = buildWorld({ airlineMaxHoldSeconds: 3641 });
  const record = await w.coordinator.run(leadPlan());
  const horizon = Date.parse(record.receipts.find((r) => r.branchId === "flight" && r.phase === "prepare")!.detail!.holdHorizon as string);
  const tightened = record.events.find((e) => e.type === "deadline-tightened")!;
  assert.ok(Date.parse(tightened.data.decideBy as string) <= horizon - 3640_000);
  assert.equal(record.state, "COMMITTED");
});

test("the coordinator's default lead time is written into the plan before it is signed", async () => {
  const w = buildWorld({ coordinator: { escalationLeadSeconds: 600 } });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.plan.escalation?.leadSeconds, 600);
  assert.equal(record.approvals[0].planDigest, record.planDigest);
  assert.equal(record.state, "COMMITTED");
});

test("a hold too short for the lead time aborts before anything commits", async () => {
  const w = buildWorld({ airlineMaxHoldSeconds: 600 });
  const record = await w.coordinator.run(leadPlan());
  assert.equal(record.state, "ABORTED");
  assert.match(String(record.events.find((e) => e.data.code === "DEADLINE_EXCEEDED")?.data.message), /escalated 3600s ahead/);
  assert.ok(w.effects.some((e) => e.startsWith("airline:released")));
  assert.ok(!w.effects.some((e) => e.includes("charged")));
});

// ---- late outcome after escalation (#31) ----

// The payments server stops answering until `online` is set; `answer` is what it says then.
function lateWorld(o: Parameters<typeof buildWorld>[0] = {}) {
  let late!: (v: { record: TransactionRecord; recovery: RecoveryOption[] }) => void;
  const settled = new Promise<{ record: TransactionRecord; recovery: RecoveryOption[] }>((r) => (late = r));
  const w = buildWorld({ airlineMaxHoldSeconds: 41, ...o, coordinator: { inDoubtRetryMs: 10, latePollMs: 20, onLateOutcome: (record, recovery) => late({ record, recovery }), ...o.coordinator } });
  const link = { online: false };
  const commit = w.payments.commit.bind(w.payments);
  w.payments.commit = async (req) => {
    if (!link.online) throw lost;
    return commit(req);
  };
  return { w, link, settled };
}

test("a late answer after escalation is recorded, and recovery is offered, not performed", async () => {
  const { w, link, settled } = lateWorld();
  const first = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  assert.equal(first.state, "NEEDS_ATTENTION");
  link.online = true; // the airline-paid charge finally answers

  const { record, recovery } = await settled;
  const late = record.events.find((e) => e.type === "late-outcome")!;
  assert.equal(late.data.outcome, "committed");
  assert.deepEqual(late.data.holds, { flight: "live", hotel: "live" });
  assert.equal(record.branches.charge, "COMMITTED");
  assert.equal(record.state, "NEEDS_ATTENTION", "a human still decides what happens next");
  assert.ok(record.receipts.some((r) => r.branchId === "charge" && r.phase === "commit"), "the late result carries the participant's receipt");
  assert.deepEqual(recovery.map((r) => r.kind), ["capture-holds", "undo-final"]);
  assert.equal(w.effects.filter((e) => e === "payments:charged").length, 1);
  assert.ok(!w.effects.some((e) => e.startsWith("airline:") || e.startsWith("hotel:")), "no capture and no void on its own");
  assert.ok(verifyRecord(record, w.keyring).ok);
  await w.coordinator.idle();
});

for (const [cap, payerPresent] of [[500, false], [400, true]] as const) {
  test(`a hold that lapsed meanwhile is offered as a linked transaction; consent up to ${cap} → payer present: ${payerPresent}`, async () => {
    const { w, link, settled } = lateWorld();
    const plan = tripPlan({ prepareOrder: "parallel", recovery: { offSessionReauth: { consented: true, maxAmount: { value: cap, currency: "USD" }, mandateRef: "pm_123" } } });
    await w.coordinator.run(plan);
    w.airline.renew = async () => { throw new HatpError("HOLD_EXPIRED", "authorization lapsed"); };
    link.online = true;

    const { record, recovery } = await settled;
    assert.deepEqual(record.events.find((e) => e.type === "late-outcome")!.data.holds, { flight: "lapsed", hotel: "live" });
    assert.deepEqual(recovery.find((r) => r.kind === "linked-transaction"), { kind: "linked-transaction", recoveryOf: plan.txnId, branches: ["flight"], payerPresent });
    assert.deepEqual(recovery.find((r) => r.kind === "capture-holds"), { kind: "capture-holds", branches: ["hotel"] });
    await w.coordinator.idle();
  });
}

test("a late answer that the final step failed offers a roll-back and undoes nothing itself", async () => {
  const { w, link, settled } = lateWorld({ paymentsFail: true });
  await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  link.online = true;

  const { record, recovery } = await settled;
  assert.equal(record.events.find((e) => e.type === "late-outcome")!.data.outcome, "failed");
  assert.equal(record.branches.charge, "FAILED");
  assert.deepEqual(recovery, [{ kind: "roll-back", branches: ["calendar", "flight", "hotel"] }]);
  assert.ok(!w.effects.some((e) => e.startsWith("calendar:deleted") || e.includes("released")));
  await w.coordinator.idle();
});

test("polling for a late answer gives up, and says so", async () => {
  const { w, settled } = lateWorld({ coordinator: { lateGiveUpSeconds: 0.1 } });
  await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }));
  const { record, recovery } = await settled;
  assert.equal(record.events.find((e) => e.type === "late-outcome")!.data.outcome, "unknown");
  assert.deepEqual(recovery, []);
  assert.equal(record.branches.charge, "IN_DOUBT");
  await w.coordinator.idle();
});

// ---- holds-first (#8) ----

test("holds-first: hold ends go into the signed plan, and the approval deadline is fitted inside them", async () => {
  const w = buildWorld({ airlineMaxHoldSeconds: 60 });
  const input = tripPlan({ prepareOrder: "holds-first" });
  const record = await w.coordinator.run(input);

  assert.equal(record.state, "COMMITTED");
  const held = record.plan.holds!;
  const flightVote = record.receipts.find((r) => r.branchId === "flight" && r.phase === "prepare")!;
  assert.equal(flightVote.planDigest, held.basePlanDigest, "the hold was placed before the holds block went in");
  assert.equal(held.branches.flight.expiresAt, flightVote.detail!.holdHorizon);
  assert.equal(held.branches.flight.holdRef, flightVote.detail!.holdRef);
  assert.ok(held.branches.hotel.expiresAt, "an uncapped hold signs its first lease");

  const decideBy = Date.parse(record.plan.approvals![0].decideBy);
  assert.ok(decideBy < Date.parse(input.approvals![0].decideBy), "the 30 s deadline was shortened");
  assert.ok(decideBy <= Date.parse(held.branches.flight.expiresAt!) - 40_000, "it leaves phase 2 and the margin");
  assert.equal(record.plan.escalation?.escalateBy, record.plan.approvals![0].decideBy, "the escalation deadline is signed too");
  assert.equal(record.approvals[0].planDigest, record.planDigest, "the human signed the plan with the holds in it");
  assert.ok(record.events.findIndex((e) => e.type === "holds-signed") < record.events.findIndex((e) => e.type === "approval"));
  assert.deepEqual(verifyRecord(record, w.keyring), { ok: true, problems: [] });
});

test("holds-first: when the holds leave too little time for the escalation chain, nobody is asked", async () => {
  // Real-time SLAs: alice, then her delegate carol, may take 5 s each. The airline leaves about 5 s.
  const w = buildWorld({ airlineMaxHoldSeconds: 45, gatewayMsPerSecond: 1000 });
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "holds-first" }));

  assert.equal(record.state, "ABORTED");
  assert.match(String(record.events.find((e) => e.data.code === "DEADLINE_EXCEEDED")?.data.message), /escalation chain may need/);
  assert.deepEqual(w.asked, []);
  assert.ok(w.effects.includes("hotel:released") && w.effects.some((e) => e.startsWith("airline:released")));
});

test("the initiator can't supply the holds block", async () => {
  const w = buildWorld();
  const plan = tripPlan({ prepareOrder: "holds-first", holds: { basePlanDigest: "sha256:x", branches: {} } });
  await assert.rejects(w.coordinator.run(plan), (e: HatpError) => e.code === "PLAN_INVALID");
});
