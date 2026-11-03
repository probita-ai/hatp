// Commit fails closed if what a dry run relied on changed since prepare (spec §7.1, §7.3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createResourceParticipant, createSigner, HatpError, planDigest, verifyRecord } from "../src/index.ts";
import type { Decision } from "../src/index.ts";
import { buildWorld, tripPlan } from "./fixtures.ts";

test("unchanged preconditions: commit goes ahead, and the prepare receipt records them", async () => {
  const w = buildWorld({ calendarVersions: [{ version: "7", scope: "calendar.write" }] });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.state, "COMMITTED");
  const vote = record.receipts.find((r) => r.branchId === "calendar" && r.phase === "prepare")!;
  assert.deepEqual(vote.detail?.preconditions, [{ resource: "calendar://dana", version: "7", scope: "calendar.write" }]);
  assert.ok(verifyRecord(record, w.keyring).ok);
});

test("a target changed before commit: nothing happens anywhere", async () => {
  const w = buildWorld({ calendarVersions: [{ version: "7" }, { version: "8" }] });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.state, "ABORTED");
  assert.equal(record.branches.calendar, "FAILED");
  assert.deepEqual(w.effects, ["airline:released:HLD-1", "hotel:released"]);
  const rollback = record.events.find((e) => e.type === "rollback")!;
  assert.match(String(rollback.data.message), /PRECONDITION_CHANGED: calendar:\/\/dana changed from version 7 to 8/);
});

test("the final step's target changed: earlier steps are compensated, and the charge never runs", async () => {
  const w = buildWorld({ paymentsVersions: [{ version: "a" }, { version: "b" }] });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.state, "ABORTED");
  assert.equal(record.branches.charge, "FAILED");
  assert.equal(record.branches.calendar, "COMPENSATED");
  assert.ok(!w.effects.includes("payments:charged"));
  assert.ok(w.effects.includes("calendar:deleted:EVT-1"));
});

test("a changed credential scope also refuses the commit", async () => {
  const w = buildWorld({ calendarVersions: [{ version: "7", scope: "calendar.write" }, { version: "7", scope: "calendar.admin" }] });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.state, "ABORTED");
  assert.match(String(record.events.find((e) => e.type === "rollback")!.data.message), /scope changed/);
});

// Direct participant calls, for what the coordinator would never send.
function oneBranch(commit: () => Promise<{ compensationToken?: string }>) {
  const p = createResourceParticipant({
    id: "mcp://crm.example/hatp",
    signer: createSigner("mcp://crm.example/hatp"),
    operations: {
      update: {
        tier: "compensate",
        async prepare() { return { ok: true, preconditions: [{ resource: "crm://acct/1", version: "3" }] }; },
        commit,
        async compensate() {},
      },
    },
  });
  const plan = { ...tripPlan(), approvals: [], branches: [{ branchId: "crm", participant: p.id, tier: "compensate" as const, operation: { tool: "update", arguments: {} } }] };
  const digest = planDigest(plan);
  const decision: Decision = { type: "hatp.decision", txnId: plan.txnId, planDigest: digest, decision: "commit", decidedAt: new Date().toISOString(), issuer: "agent://acme.com/coordinator" } as Decision;
  return { p, req: { txnId: plan.txnId, branchId: "crm", planDigest: digest, decisionRecord: decision }, plan, digest };
}

test("a commit that carries other preconditions than prepare returned is refused", async () => {
  const { p, req, plan, digest } = oneBranch(async () => ({ compensationToken: "T" }));
  const vote = await p.prepare({ txnId: plan.txnId, branchId: "crm", planDigest: digest, plan, leaseSeconds: 60 });
  assert.deepEqual(vote.preconditions, [{ resource: "crm://acct/1", version: "3" }]);
  await assert.rejects(p.commit({ ...req, preconditions: [{ resource: "crm://acct/1", version: "4" }] }), (e: HatpError) => e.code === "INVALID_STATE");
  await assert.rejects(p.commit(req), (e: HatpError) => e.code === "INVALID_STATE"); // dropped altogether
  const r = await p.commit({ ...req, preconditions: vote.preconditions });
  assert.equal(r.compensationToken, "T");
});

test("a conditional write that finds a new version keeps its PRECONDITION_CHANGED code", async () => {
  const { p, req, plan, digest } = oneBranch(async () => { throw new HatpError("PRECONDITION_CHANGED", "ifVersion 3 failed"); });
  const vote = await p.prepare({ txnId: plan.txnId, branchId: "crm", planDigest: digest, plan, leaseSeconds: 60 });
  await assert.rejects(p.commit({ ...req, preconditions: vote.preconditions }), (e: HatpError) => e.code === "PRECONDITION_CHANGED");
});
