// The gateway sees only amounts a plan declares; participants check them against the real cost (spec §5.1, §7.1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { HatpError, plannedAmount, summarize, verifyRecord } from "../src/index.ts";
import type { Money, Plan, Routing, TransactionRecord } from "../src/index.ts";
import { buildWorld, tripPlan } from "./fixtures.ts";

const usd = (value: number): Money => ({ value, currency: "USD" });
const voteCode = (record: TransactionRecord, branchId: string) => record.receipts.find((r) => r.branchId === branchId && r.phase === "prepare" && r.outcome === "no")?.detail?.code;
const planInvalid = (e: unknown) => e instanceof HatpError && e.code === "PLAN_INVALID";

test("a settling charge plans the sum of the branches it pays for", () => {
  const plan = tripPlan();
  assert.deepEqual(plannedAmount(plan, plan.branches[3]), usd(1000));
  assert.deepEqual(plannedAmount(plan, plan.branches[0]), usd(412));
  assert.equal(plannedAmount(plan, plan.branches[2]), undefined);
});

test("a charge that matches what it settles commits", async () => {
  const w = buildWorld({ chargeAmount: usd(1000) });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.state, "COMMITTED");
  assert.deepEqual(verifyRecord(record, w.keyring), { ok: true, problems: [] });
});

test("a charge with no declared amount is refused at prepare", async () => {
  // The hole #39 left: the plan totals $1000 and hides a $25,000 charge in an amountless branch.
  const w = buildWorld({ chargeAmount: usd(25_000) });
  const plan = tripPlan();
  delete plan.branches[3].settles;
  const record = await w.coordinator.run(plan);
  assert.equal(record.state, "ABORTED");
  assert.equal(voteCode(record, "charge"), "AMOUNT_UNDERSTATED");
  assert.ok(!w.effects.includes("payments:charged"));
});

test("settles can't hide a cost above what it settles", async () => {
  const w = buildWorld({ chargeAmount: usd(25_000) });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.state, "ABORTED");
  assert.equal(voteCode(record, "charge"), "AMOUNT_UNDERSTATED");
  assert.ok(!w.effects.includes("payments:charged"));
});

test("a cost within tolerance passes, and just above it doesn't", async () => {
  const plan = () => tripPlan({ tolerance: { amountPercent: 2 } });
  assert.equal((await buildWorld({ chargeAmount: usd(1020) }).coordinator.run(plan())).state, "COMMITTED");
  assert.equal((await buildWorld({ chargeAmount: usd(1021) }).coordinator.run(plan())).state, "ABORTED");
});

test("a charge in another currency is refused", async () => {
  const w = buildWorld({ chargeAmount: { value: 900, currency: "EUR" } });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(voteCode(record, "charge"), "AMOUNT_UNDERSTATED");
});

test("a hold on a branch with no amount is released when it's refused", async () => {
  const w = buildWorld();
  const plan = tripPlan();
  delete plan.branches[3].settles;
  delete plan.branches[0].amount;
  const record = await w.coordinator.run(plan);
  assert.equal(voteCode(record, "flight"), "AMOUNT_UNDERSTATED");
  assert.ok(w.effects.some((e) => e.startsWith("airline:released")));
});

test("settles follows a quote that changed a held amount", async () => {
  const w = buildWorld({ airlineQuote: 400, airlineHoldPrice: 400 });
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "approval-first" }));
  assert.equal(record.state, "COMMITTED");
  assert.deepEqual(plannedAmount(record.plan, record.plan.branches[3]), usd(988));
});

test("a held amount well below plan is the coordinator's to catch", async () => {
  const w = buildWorld({ airlineQuote: 400, airlineHoldPrice: 300 });
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "approval-first", tolerance: { amountPercent: 2 } }));
  assert.equal(record.state, "ABORTED");
  assert.ok(record.events.some((e) => e.data.code === "AMOUNT_CHANGED"));
});

test("the coordinator aborts when a participant votes yes with a cost the plan never stated", async () => {
  // A participant that doesn't make the check itself: the calendar branch plans no amount.
  const w: ReturnType<typeof buildWorld> = buildWorld({
    coordinator: {
      participants: (id) => {
        const real = [w.airline, w.hotel, w.calendar, w.payments, w.gateway].find((p) => p.id === id);
        return real === w.calendar ? { ...w.calendar, prepare: async (req) => ({ ...(await w.calendar.prepare(req)), amount: usd(99) }) } : real;
      },
    },
  });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.state, "ABORTED");
  assert.ok(record.events.some((e) => e.data.code === "AMOUNT_CHANGED"));
});

const invalid: [string, (p: Plan) => void][] = [
  ["an empty settles", (p) => { p.branches[3].settles = []; }],
  ["a settling branch that states an amount", (p) => { p.branches[3].amount = usd(1000); }],
  ["a settled branch that doesn't exist", (p) => { p.branches[3].settles = ["flight", "nope"]; }],
  ["a settled branch with no amount", (p) => { p.branches[3].settles = ["calendar"]; }],
  ["a branch settled twice", (p) => { p.branches[3].settles = ["flight", "flight"]; }],
  ["settled branches in different currencies", (p) => { p.branches[1].amount = { value: 588, currency: "EUR" }; }],
];
for (const [name, breakIt] of invalid) {
  test(`rejects ${name}`, async () => {
    const plan = tripPlan();
    breakIt(plan);
    await assert.rejects(buildWorld().coordinator.run(plan), planInvalid);
  });
}

const usdTotals = (value: number) => [usd(value)];

test("an ask shows the most the approval allows, not just the planned total", () => {
  const plan = tripPlan({ tolerance: { amountPercent: 2 } });
  const summary = summarize(plan, plan.approvals![0]);
  assert.deepEqual(summary.totals, usdTotals(1000));
  assert.deepEqual(summary.maxTotals, usdTotals(1020));
});

test("with no tolerance the ceiling is the total", () => {
  const plan = tripPlan();
  const summary = summarize(plan, plan.approvals![0]);
  assert.deepEqual(summary.maxTotals, summary.totals);
});

test("the ceiling a human sees is the figure authority was checked against", async () => {
  const w = buildWorld();
  const plan = tripPlan({ tolerance: { amountPercent: 2 } }, { requirement: { action: "approve.spend" } });
  const record = await w.coordinator.run(plan);
  const routing = record.receipts.find((r) => r.branchId === "approval:finance" && r.phase === "prepare")?.detail?.routing as Routing;
  assert.deepEqual(summarize(record.plan, record.plan.approvals![0]).maxTotals, routing.checked);
});

test("holds-first: an ask shows the held amounts, and nothing can move", async () => {
  const w = buildWorld({ airlineHoldPrice: 410 });
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "holds-first", tolerance: { amountPercent: 2 } }));
  assert.equal(record.state, "COMMITTED");
  const summary = summarize(record.plan, record.plan.approvals![0]);
  assert.deepEqual(summary.lines[0].amount, usd(410));
  assert.deepEqual(summary.totals, usdTotals(998));
  assert.deepEqual(summary.maxTotals, usdTotals(998));
});

test("holds-first: tolerance still applies to amounts that aren't held", async () => {
  const plan = tripPlan({ prepareOrder: "holds-first", tolerance: { amountPercent: 2 } });
  plan.branches[2] = { ...plan.branches[2], amount: usd(100) };
  plan.approvals![0].requirement.amount = usd(1100);
  plan.holds = { basePlanDigest: "sha256:x", branches: { flight: { amount: usd(412) }, hotel: { amount: usd(588) } } };
  const summary = summarize(plan, plan.approvals![0]);
  assert.deepEqual(summary.totals, usdTotals(1100));
  assert.deepEqual(summary.maxTotals, usdTotals(1102));
});
