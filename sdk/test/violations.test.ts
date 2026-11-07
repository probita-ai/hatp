// Planted violations (spec Appendix B): each transaction is built to break one rule, and the evidence must
// show which rule stopped it. A rule that was never approached and a rule that held look the same in a
// pass rate, so every case here goes past the limit on purpose.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { planDigest, verifyRecord } from "../src/index.ts";
import type { Approval, Branch, Money, Plan, Receipt, Routing, TransactionRecord } from "../src/index.ts";
import { buildWorld, tripPlan } from "./fixtures.ts";

const usd = (value: number): Money => ({ value, currency: "USD" });
const id = (name: string) => `human://acme.com/${name}`;
const noAmount = { requirement: { action: "approve.spend" } };

/** A branch that spends without a participant reporting the cost, so only the rule under test can stop it. */
const spend = (branchId: string, amount: Money): Branch => ({ branchId, participant: "mcp://calendar.acme.com/hatp", tier: "compensate", operation: { tool: "create_event", arguments: {} }, amount });

const gatewayReceipt = (r: TransactionRecord) => r.receipts.find((x) => x.branchId === "approval:finance" && x.phase === "prepare") as Receipt;
const routing = (r: TransactionRecord) => gatewayReceipt(r).detail?.routing as Routing;
const human = (r: TransactionRecord, name: string) => routing(r).humans.find((h) => h.id === id(name));
const abortCode = (r: TransactionRecord) => r.events.find((e) => e.type === "decision")?.data.code;

/** Everything a violation must leave true: it aborted, nothing took effect, and the record is honest. */
function stopped(w: ReturnType<typeof buildWorld>, r: TransactionRecord) {
  assert.equal(r.state, "ABORTED");
  assert.deepEqual(w.effects.filter((e) => !e.includes("released")), []);
  assert.deepEqual(verifyRecord(r, w.keyring), { ok: true, problems: [] });
}

/** A plan the coordinator refuses, sent straight to the gateway, which can't assume a coordinator checked it. */
async function refusedByBoth(plan: Plan) {
  const w = buildWorld();
  await assert.rejects(buildWorld().coordinator.run(structuredClone(plan)), /PLAN_INVALID/);
  const vote = await w.gateway.prepare({ txnId: plan.txnId, branchId: "approval:finance", planDigest: planDigest(plan), plan, leaseSeconds: 60 });
  assert.equal(vote.vote, "no");
  assert.equal(vote.receipt.detail?.code, "PLAN_INVALID");
  assert.equal((vote.receipt.detail?.routing as Routing).checked, "absent");
  assert.deepEqual(w.asked, []);
  return "PLAN_INVALID";
}

const violations: { id: string; section: string; code: string; rule: string; plant(): Promise<string> }[] = [
  {
    id: "V1", section: "§6.3", code: "AUTHORITY_INSUFFICIENT", rule: "a request above every approver's authority",
    async plant() {
      const w = buildWorld();
      const plan = tripPlan({}, noAmount);
      plan.branches = [spend("a", usd(25_000))];
      const r = await w.coordinator.run(plan);
      stopped(w, r);
      assert.deepEqual(w.asked, []);
      assert.deepEqual(routing(r).checked, [usd(25_000)]);
      assert.deepEqual(human(r, "erin"), { id: id("erin"), result: "excluded", rule: "authority", detail: "limit 500 USD < 25000 USD" });
      assert.equal(human(r, "alice")?.rule, "authority");
      return gatewayReceipt(r).detail?.code as string;
    },
  },
  {
    id: "V2", section: "§6.3", code: "PLAN_INVALID", rule: "a requirement under-stated against the plan total",
    async plant() {
      const w = buildWorld();
      const r = await w.coordinator.run(tripPlan({}, { requirement: { action: "approve.spend", amount: usd(100) } }));
      stopped(w, r);
      assert.deepEqual(w.asked, []);
      assert.deepEqual(routing(r).requirement.amount, usd(100));
      assert.deepEqual(routing(r).planTotals, [usd(1000)]);
      assert.equal(routing(r).checked, "absent");
      return gatewayReceipt(r).detail?.code as string;
    },
  },
  {
    id: "V3", section: "§6.3", code: "AUTHORITY_INSUFFICIENT", rule: "a plan in a currency no approver has authority in",
    async plant() {
      const w = buildWorld();
      const plan = tripPlan({}, noAmount);
      plan.branches = [spend("a", { value: 100, currency: "EUR" })];
      const r = await w.coordinator.run(plan);
      stopped(w, r);
      assert.deepEqual(human(r, "alice"), { id: id("alice"), result: "excluded", rule: "currency", detail: "no authority in EUR" });
      return gatewayReceipt(r).detail?.code as string;
    },
  },
  {
    id: "V4", section: "§4.4", code: "AUTHORITY_INSUFFICIENT", rule: "the requester as the only eligible approver",
    async plant() {
      const w = buildWorld();
      const r = await w.coordinator.run(tripPlan({}, { address: id("dana") }));
      stopped(w, r);
      assert.deepEqual(w.asked, []);
      assert.deepEqual(routing(r).humans, [{ id: id("dana"), result: "excluded", rule: "separation-of-duties" }]);
      return gatewayReceipt(r).detail?.code as string;
    },
  },
  {
    id: "V5", section: "§8.4", code: "PLAN_MISMATCH", rule: "an approval reused for a different plan digest",
    async plant() {
      const earlier = await buildWorld().coordinator.run(tripPlan());
      const stale: Approval = earlier.approvals[0];
      const w: ReturnType<typeof buildWorld> = buildWorld({
        coordinator: {
          participants: (p) => {
            const real = [w.airline, w.hotel, w.calendar, w.payments, w.gateway].find((x) => x.id === p);
            return real === w.gateway ? { ...w.gateway, prepare: async (req) => ({ ...(await w.gateway.prepare(req)), approvals: [stale] }) } : real;
          },
        },
      });
      const r = await w.coordinator.run(tripPlan());
      assert.equal(r.state, "ABORTED");
      assert.deepEqual(w.effects.filter((e) => !e.includes("released")), []);
      assert.deepEqual(r.approvals, [], "the stale approval is not kept as if it counted");
      const tampered = structuredClone(earlier);
      tampered.approvals[0].planDigest = r.planDigest;
      assert.ok(verifyRecord(tampered, w.keyring).problems.length > 0);
      return abortCode(r) as string;
    },
  },
  {
    id: "V6", section: "§5.4", code: "HOLD_EXPIRED", rule: "a commit after a signed hold end",
    async plant() {
      // The human's decision lands too close to the end signed in the plan: the clock jumps while they decide.
      let skew = 0;
      const w: ReturnType<typeof buildWorld> = buildWorld({
        airlineMaxHoldSeconds: 600,
        coordinator: {
          now: () => Date.now() + skew,
          participants: (p) => {
            const real = [w.airline, w.hotel, w.calendar, w.payments, w.gateway].find((x) => x.id === p);
            if (real !== w.gateway) return real;
            return { ...w.gateway, prepare: async (req) => { const vote = await w.gateway.prepare(req); skew = 580_000; return vote; } };
          },
        },
      });
      const r = await w.coordinator.run(tripPlan({ prepareOrder: "holds-first", deadline: new Date(Date.now() + 3_600_000).toISOString() }));
      assert.equal(r.state, "ABORTED");
      assert.ok(r.approvals.length > 0, "the human did approve");
      assert.ok(r.plan.holds?.branches.flight.expiresAt, "the hold's end is in the signed plan");
      assert.deepEqual(w.effects.filter((e) => !e.includes("released")), []);
      return abortCode(r) as string;
    },
  },
  {
    id: "V7", section: "§7.1", code: "AMOUNT_UNDERSTATED", rule: "a charge with no declared amount",
    async plant() {
      const w = buildWorld({ chargeAmount: usd(25_000) });
      const plan = tripPlan();
      delete plan.branches[3].settles;
      const r = await w.coordinator.run(plan);
      stopped(w, r);
      return abortCode(r) as string;
    },
  },
  {
    id: "V8", section: "§7.1", code: "AMOUNT_UNDERSTATED", rule: "a settling charge above what it settles",
    async plant() {
      const w = buildWorld({ chargeAmount: usd(25_000) });
      const r = await w.coordinator.run(tripPlan());
      stopped(w, r);
      assert.deepEqual(r.plan.branches[3].settles, ["flight", "hotel"]);
      return abortCode(r) as string;
    },
  },
  {
    id: "V9", section: "§5.1", code: "PLAN_INVALID", rule: "a negative amount offsetting a real cost",
    async plant() {
      const plan = tripPlan({}, noAmount);
      plan.branches = [spend("a", usd(25_000)), spend("b", usd(-24_900))];
      return refusedByBoth(plan);
    },
  },
  {
    id: "V10", section: "§5.1", code: "PLAN_INVALID", rule: "a negative tolerance shrinking the total",
    async plant() {
      const plan = tripPlan({ tolerance: { amountPercent: -99 } }, noAmount);
      plan.branches = [spend("a", usd(25_000))];
      return refusedByBoth(plan);
    },
  },
  {
    id: "V11", section: "§5.1", code: "PLAN_INVALID", rule: "a negative quote written into the plan after validation",
    async plant() {
      const w = buildWorld({ airlineQuote: -24_000, airlineHoldPrice: -24_000 });
      const r = await w.coordinator.run(tripPlan({ prepareOrder: "approval-first" }, noAmount));
      stopped(w, r);
      assert.deepEqual(w.asked, []);
      assert.equal(r.plan.branches[0].amount?.value, -24_000, "the quote did reach the plan");
      return gatewayReceipt(r).detail?.code as string;
    },
  },
];

for (const v of violations) {
  test(`${v.id}: ${v.rule} is stopped by ${v.section}, and the evidence says ${v.code}`, async () => {
    assert.equal(await v.plant(), v.code);
  });
}

test("spec Appendix B lists exactly these violations", () => {
  const spec = readFileSync(new URL("../../spec/hatp-v0.1.md", import.meta.url), "utf8");
  const appendix = spec.slice(spec.indexOf("## Appendix B"));
  const rows = [...appendix.matchAll(/^\| (V\d+) \| (.+?) \| (§[\d.]+) \|.*`([A-Z_]+)`/gm)].map((m) => ({ id: m[1], rule: m[2], section: m[3], code: m[4] }));
  assert.deepEqual(rows, violations.map(({ id, rule, section, code }) => ({ id, rule: rule[0].toUpperCase() + rule.slice(1), section, code })));
});

