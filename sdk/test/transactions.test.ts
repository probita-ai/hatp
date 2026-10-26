import assert from "node:assert/strict";
import { test } from "node:test";
import { HatpError, createHumanGateway, createSigner, planDigest, signCard, verifyRecord } from "../src/index.ts";
import type { Plan } from "../src/index.ts";
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
  await assert.rejects(w.coordinator.run(plan), (e: unknown) => e instanceof HatpError && e.code === "PLAN_INVALID");
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
