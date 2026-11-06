// A record shows what was checked and who was passed over, not only who decided (spec §8.3, §8.5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyRecord } from "../src/index.ts";
import type { Money, Receipt, Routing, TransactionRecord } from "../src/index.ts";
import { buildWorld, tripPlan } from "./fixtures.ts";

const usd = (value: number): Money => ({ value, currency: "USD" });
const id = (name: string) => `human://acme.com/${name}`;

const receiptOf = (record: TransactionRecord) => record.receipts.find((r) => r.branchId === "approval:finance" && r.phase === "prepare") as Receipt;
const routingOf = (record: TransactionRecord) => receiptOf(record).detail?.routing as Routing;
const human = (r: Routing, name: string) => r.humans.find((h) => h.id === id(name));

test("records who was asked, who was eligible, and who was excluded by which rule", async () => {
  const w = buildWorld();
  const record = await w.coordinator.run(tripPlan());
  const r = routingOf(record);

  assert.equal(record.state, "COMMITTED");
  assert.deepEqual(r.planTotals, [usd(1000)]);
  assert.deepEqual(r.checked, [usd(1000)]);
  assert.deepEqual(human(r, "alice"), { id: id("alice"), result: "asked" });
  assert.deepEqual(human(r, "bob"), { id: id("bob"), result: "eligible" });
  assert.deepEqual(human(r, "dana"), { id: id("dana"), result: "excluded", rule: "separation-of-duties" });
  assert.deepEqual(human(r, "erin"), { id: id("erin"), result: "excluded", rule: "authority", detail: "limit 500 USD < 1000 USD" });
  assert.deepEqual(verifyRecord(record, w.keyring), { ok: true, problems: [] });
});

test("the record still shows every exclusion when nobody was eligible", async () => {
  // The dev.to case: "Bob was excluded" and "it never reached Bob" must not look the same.
  const w = buildWorld();
  const plan = tripPlan({}, { requirement: { action: "approve.spend" } });
  plan.branches[0] = { ...plan.branches[0], amount: usd(25_000) };
  const record = await w.coordinator.run(plan);
  const r = routingOf(record);

  assert.equal(record.state, "ABORTED");
  assert.deepEqual(r.checked, [usd(25_588)]);
  assert.equal(human(r, "alice")?.rule, "authority");
  assert.equal(human(r, "alice")?.detail, "limit 10000 USD < 25588 USD");
  assert.equal(human(r, "erin")?.detail, "limit 500 USD < 25588 USD");
  assert.ok(r.humans.every((h) => h.result === "excluded"));
  assert.deepEqual(verifyRecord(record, w.keyring), { ok: true, problems: [] });
});

test("says the amount check was absent when the plan states no amounts", async () => {
  const w = buildWorld();
  const plan = tripPlan({}, { requirement: { action: "approve.spend" } });
  plan.branches = plan.branches.map(({ amount: _amount, ...b }) => b);
  const record = await w.coordinator.run(plan);
  assert.equal(routingOf(record).checked, "absent");
});

test("a rejected plan says no check ran, and shows the requirement that failed", async () => {
  const w = buildWorld();
  const record = await w.coordinator.run(tripPlan({}, { requirement: { action: "approve.spend", amount: usd(100) } }));
  const r = routingOf(record);
  assert.equal(r.checked, "absent");
  assert.deepEqual(r.requirement.amount, usd(100));
  assert.deepEqual(r.planTotals, [usd(1000)]);
  assert.deepEqual(r.humans, []);
});

test("names the currency rule when a human has no authority in that currency", async () => {
  const w = buildWorld();
  const plan = tripPlan({}, { requirement: { action: "approve.spend" } });
  plan.branches[1] = { ...plan.branches[1], amount: { value: 588, currency: "EUR" } };
  const record = await w.coordinator.run(plan);
  assert.deepEqual(human(routingOf(record), "alice"), { id: id("alice"), result: "excluded", rule: "currency", detail: "no authority in EUR" });
});

test("names the assurance rule when a human has no passkey", async () => {
  const w = buildWorld({ passkeys: ["alice"], script: { [id("alice")]: { decision: "approve", passkey: "sign" } } });
  const record = await w.coordinator.run(tripPlan({}, { assurance: "human-signed" }));
  assert.equal(human(routingOf(record), "bob")?.rule, "assurance");
});

test("everyone in an escalation chain is recorded as asked", async () => {
  const w = buildWorld({ script: { [id("alice")]: "ignore", [id("carol")]: { decision: "approve" } } });
  const record = await w.coordinator.run(tripPlan());
  const r = routingOf(record);
  assert.equal(human(r, "alice")?.result, "asked");
  assert.equal(human(r, "carol")?.result, "asked");
  assert.deepEqual(verifyRecord(record, w.keyring), { ok: true, problems: [] });
});

test("verifyRecord flags an approver the routing doesn't list as asked", async () => {
  const w = buildWorld();
  const record = await w.coordinator.run(tripPlan());
  const r = routingOf(record);
  r.humans = r.humans.filter((h) => h.id !== id("alice"));
  assert.ok(verifyRecord(record, w.keyring).problems.includes(`approval by ${id("alice")}: not among the humans asked`));
});

test("verifyRecord flags routing that disagrees with the plan", async () => {
  const w = buildWorld();
  const record = await w.coordinator.run(tripPlan());
  routingOf(record).checked = [usd(100)];
  assert.ok(verifyRecord(record, w.keyring).problems.includes("group finance: routing does not match what the plan requires checking"));
});

test("verifyRecord flags an approval with no routing", async () => {
  const w = buildWorld();
  const record = await w.coordinator.run(tripPlan());
  delete receiptOf(record).detail!.routing;
  assert.ok(verifyRecord(record, w.keyring).problems.includes(`approval by ${id("alice")}: no routing in the gateway's prepare receipt`));
});

test("pseudonyms hide humans who were not asked, and the record still verifies", async () => {
  const w = buildWorld({ pseudonym: (h) => `anon:${h.split("/").pop()!.length}` });
  const record = await w.coordinator.run(tripPlan());
  const r = routingOf(record);

  assert.deepEqual(human(r, "alice"), { id: id("alice"), result: "asked" });
  assert.equal(human(r, "erin"), undefined);
  assert.deepEqual(r.humans.find((h) => h.rule === "authority"), { id: "anon:4", result: "excluded", rule: "authority" });
  assert.deepEqual(verifyRecord(record, w.keyring), { ok: true, problems: [] });
});
