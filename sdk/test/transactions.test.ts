import assert from "node:assert/strict";
import { test } from "node:test";
import { HatpError, createSigner, signCard, verifyRecord } from "../src/index.ts";
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
