// The authority check runs on amounts the gateway derives from the plan, not on what the agent stated (spec §6.3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { authorityAmounts, createSigner, Directory, HatpError, signCard } from "../src/index.ts";
import type { ApprovalGroup, Branch, HumanCard, Money, Plan, TransactionRecord } from "../src/index.ts";
import { buildWorld, tripPlan } from "./fixtures.ts";

const usd = (value: number): Money => ({ value, currency: "USD" });
const eur = (value: number): Money => ({ value, currency: "EUR" });
const spend = (branchId: string, amount: Money): Branch => ({ branchId, participant: "mcp://airline.example/hatp", tier: "hold", operation: { tool: "book_seat", arguments: {} }, amount });

function amounts(branches: Money[], stated?: Money, tolerance?: number) {
  const plan = tripPlan({ branches: branches.map((m, i) => spend(`b${i}`, m)), tolerance: tolerance === undefined ? undefined : { amountPercent: tolerance } }, { requirement: { action: "approve.spend", amount: stated } }) as Plan;
  return authorityAmounts(plan, plan.approvals![0] as ApprovalGroup);
}

/** The code the gateway voted no with, from its signed receipt. */
const voteCode = (record: TransactionRecord) => record.receipts.find((r) => r.branchId === "approval:finance" && r.outcome === "no")?.detail?.code;

const planInvalid = (e: unknown) => e instanceof HatpError && e.code === "PLAN_INVALID";

test("derives the amount from the branches, per currency", () => {
  assert.deepEqual(amounts([usd(412), usd(588)]), [usd(1000)]);
  assert.deepEqual(amounts([usd(400), eur(300)]), [usd(400), eur(300)]);
});

test("includes tolerance, without requiring the stated amount to", () => {
  assert.deepEqual(amounts([usd(1000)], usd(1000), 2), [usd(1020)]);
});

test("a requirement above the plan total still applies", () => {
  assert.deepEqual(amounts([usd(1000)], usd(5000), 2), [usd(5000)]);
});

test("rejects a requirement below the plan total", () => {
  assert.throws(() => amounts([usd(25_000)], usd(100)), planInvalid);
});

test("rejects a plan spending a currency the requirement doesn't name", () => {
  assert.throws(() => amounts([usd(100), eur(100)], usd(1000)), planInvalid);
});

test("an under-stated requirement is rejected before anyone is asked", async () => {
  const w = buildWorld();
  const record = await w.coordinator.run(tripPlan({}, { requirement: { action: "approve.spend", amount: usd(100) } }));
  assert.equal(record.state, "ABORTED");
  assert.equal(voteCode(record), "PLAN_INVALID");
  assert.deepEqual(w.asked, []);
  assert.deepEqual(w.effects, ["airline:released:HLD-1", "hotel:released"], "holds placed in parallel are released, nothing commits");
});

test("a mixed-currency plan is rejected when the requirement names one currency", async () => {
  const w = buildWorld();
  const plan = tripPlan();
  plan.branches[1] = { ...plan.branches[1], amount: eur(588) };
  const record = await w.coordinator.run(plan);
  assert.equal(record.state, "ABORTED");
  assert.equal(voteCode(record), "PLAN_INVALID");
  assert.deepEqual(w.asked, []);
});

test("leaving the amount out of the requirement doesn't skip the check", async () => {
  // Erin's limit is $500, the plan spends $1000, and the script approves as Erin if she is ever asked.
  const w = buildWorld({ script: { "human://acme.com/alice": "ignore", "human://acme.com/bob": "ignore", "human://acme.com/carol": { decision: "approve" }, "human://acme.com/erin": { decision: "approve" } } });
  const record = await w.coordinator.run(tripPlan({}, { requirement: { action: "approve.spend" } }));
  assert.equal(record.state, "COMMITTED");
  assert.ok(!w.asked.includes("human://acme.com/erin"), "erin's $500 limit is below the plan total");
});

test("a plan above every approver's authority reaches nobody", async () => {
  const w = buildWorld();
  const plan = tripPlan({}, { requirement: { action: "approve.spend" } });
  plan.branches[0] = { ...plan.branches[0], amount: usd(25_000) };
  const record = await w.coordinator.run(plan);
  assert.equal(record.state, "ABORTED");
  assert.equal(voteCode(record), "AUTHORITY_INSUFFICIENT");
  assert.deepEqual(w.asked, []);
});

test("authority in one currency does not cover another, and each currency must be covered", () => {
  const issuer = createSigner("https://directory.acme.com");
  const dir = new Directory([issuer.publicJwk]);
  const card = (name: string, authority: HumanCard["authority"]) =>
    signCard({ id: `human://acme.com/${name}`, displayName: name, org: "acme.com", roles: ["approver"], authority, channels: ["web"], keys: [], issuer: issuer.id }, issuer);
  dir.add(card("usd-only", [{ action: "approve.spend", maxAmount: usd(1000) }]));
  dir.add(card("both", [{ action: "approve.spend", maxAmount: usd(1000) }, { action: "approve.spend", maxAmount: eur(1000) }]));
  const { candidates } = dir.resolve({ address: "human://acme.com/role/approver", requirement: { action: "approve.spend" }, amounts: [usd(500), eur(500)] });
  assert.deepEqual(candidates.map((c) => c.id), ["human://acme.com/both"]);
});
