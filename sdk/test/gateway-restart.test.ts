// A Human Gateway that restarts keeps its deferred votes, withdrawn asks and late decisions (stateLog, recover).
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHumanGateway, GatewayFileLog, planDigest, readGatewayLog } from "../src/index.ts";
import type { GatewayLogItem, HumanChannel, HumanDecision, PrepareRequest } from "../src/index.ts";
import { buildWorld, tripPlan } from "./fixtures.ts";

const alice = "human://acme.com/alice";
const bob = "human://acme.com/bob";
const carol = "human://acme.com/carol";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const memory = () => { const items: GatewayLogItem[] = []; return { items, append: (i: GatewayLogItem) => void items.push(i) }; };

function prepareReq(o: { decideInMs?: number } = {}): PrepareRequest {
  const plan = tripPlan({ prepareOrder: "parallel" }, o.decideInMs ? { decideBy: new Date(Date.now() + o.decideInMs).toISOString() } : {});
  return { txnId: plan.txnId, branchId: "approval:finance", planDigest: planDigest(plan), plan, leaseSeconds: 60 };
}

/** The same gateway identity, started again: a new process with an empty memory. */
function restart(w: ReturnType<typeof buildWorld>, decide: (human: string) => HumanDecision | undefined, stateLog = memory()) {
  const asked: string[] = [];
  const answer = (human: string, signal: AbortSignal) => new Promise<HumanDecision>((resolve, reject) => {
    asked.push(human);
    signal.addEventListener("abort", () => reject(new Error("withdrawn")), { once: true });
    const d = decide(human);
    if (d) setTimeout(() => resolve(d), 5);
  });
  const channel: HumanChannel = { deliver: (_a, h, s) => answer(h.id, s) };
  const gateway = createHumanGateway({ id: w.gateway.id, signer: w.gatewaySigner, directory: w.directory, channel, msPerSecond: 10, pending: { afterMs: 0, pollAfterSeconds: 0.03 }, stateLog });
  return { gateway, asked, stateLog };
}

test("a deferred vote decided before the restart is answered again by status, and nobody is asked twice", async () => {
  const log = memory();
  const w = buildWorld({ script: { [alice]: { decision: "approve", afterMs: 20 } }, gatewayPending: { afterMs: 0 }, stateLog: log });
  const req = prepareReq();
  assert.equal((await w.gateway.prepare(req)).vote, "pending");
  // Polled, not a fixed sleep: under a loaded test run the 20 ms decision can land late.
  for (let i = 0; i < 100 && (await w.gateway.status!(req)).vote !== "yes"; i++) await wait(20);
  assert.equal((await w.gateway.status!(req)).vote, "yes");
  assert.deepEqual(log.items.map((i) => i.kind), ["pending", "vote"]);

  const after = restart(w, () => undefined);
  assert.deepEqual(after.gateway.recover(log.items), { votes: [`${req.txnId}/${req.branchId}`], reasked: [], withdrawn: 0, late: 0 });
  const vote = await after.gateway.status!(req);
  assert.equal(vote.vote, "yes");
  assert.deepEqual(vote.approvals?.map((a) => a.approver), [alice]);
  assert.equal((await after.gateway.prepare(req)).vote, "yes", "a repeated prepare gets the same vote");
  assert.deepEqual(after.asked, []);
});

test("a vote still open at the restart is asked again, under the same signed deadline", async () => {
  const log = memory();
  const w = buildWorld({ script: { [alice]: "ignore", [bob]: "ignore", [carol]: "ignore" }, gatewayPending: { afterMs: 0 }, stateLog: log });
  const req = prepareReq();
  assert.equal((await w.gateway.prepare(req)).vote, "pending");

  // The old process dies with its asks open. The new one has alice approve.
  const after = restart(w, (h) => (h === alice ? { decision: "approve", method: "web" } : undefined));
  const r = after.gateway.recover(log.items);
  assert.deepEqual(r.reasked, [`${req.txnId}/${req.branchId}`]);
  assert.equal((await after.gateway.status!(req)).vote, "pending");
  await wait(60);
  const vote = await after.gateway.status!(req);
  assert.equal(vote.vote, "yes");
  assert.ok(after.asked.includes(alice));
  assert.ok(after.stateLog.items.some((i) => i.kind === "vote"), "the new outcome is logged by the new process");
});

test("a transaction that ended, or a deadline that passed, is not brought back", async () => {
  const log = memory();
  const w = buildWorld({ script: { [alice]: { decision: "approve", afterMs: 10 } }, gatewayPending: { afterMs: 0 }, stateLog: log });
  const ended = prepareReq();
  await w.gateway.prepare(ended);
  await wait(50);
  await w.gateway.commit({ txnId: ended.txnId, branchId: ended.branchId, planDigest: ended.planDigest, decisionRecord: { type: "hatp.decision", txnId: ended.txnId, planDigest: ended.planDigest, decision: "commit", decidedAt: new Date().toISOString(), issuer: "agent://acme.com/coordinator" } });
  const expired: GatewayLogItem = { kind: "pending", key: "txn_old/approval:finance", req: prepareReq(), until: Date.now() - 1 };

  const after = restart(w, () => undefined);
  assert.deepEqual(after.gateway.recover([...log.items, expired]), { votes: [], reasked: [], withdrawn: 0, late: 0 });
  await assert.rejects(after.gateway.status!(ended), /TXN_UNKNOWN/);
  assert.deepEqual(after.asked, []);
});

test("withdrawn asks and late decisions survive a restart", async () => {
  const log = memory();
  const w = buildWorld({ script: { [alice]: "ignore", [bob]: "ignore", [carol]: "ignore" }, gatewayMsPerSecond: 1000, stateLog: log });
  const record = await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }, { decideBy: new Date(Date.now() + 100).toISOString() }));
  assert.equal(record.state, "ABORTED");
  const [ask] = w.voteAsks;
  const first = w.gateway.recordLate(ask.askId, { decision: "reject", method: "email" });

  const after = restart(w, () => undefined);
  const r = after.gateway.recover(log.items);
  assert.equal(r.late, 1);
  assert.ok(r.withdrawn >= 1);
  assert.deepEqual(after.gateway.lateDecisions({ txnId: record.plan.txnId }), [first]);
  const second = after.gateway.recordLate(ask.askId, { decision: "approve", method: "slack-sso" });
  assert.equal(second.withdrawnBecause, "deadline");
  assert.equal(after.gateway.lateDecisions({ txnId: record.plan.txnId }).length, 2);
});

test("GatewayFileLog round-trips, and a torn last line is skipped", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "hatp-gw-")), "gateway.log");
  const w = buildWorld({ script: { [alice]: { decision: "approve", afterMs: 20 } }, gatewayPending: { afterMs: 0 }, stateLog: new GatewayFileLog(path) });
  const req = prepareReq();
  await w.gateway.prepare(req);
  await wait(80);
  appendFileSync(path, '{"kind":"vote","key":"torn'); // a crash mid-write
  const items = readGatewayLog(path);
  assert.deepEqual(items.map((i) => i.kind), ["pending", "vote"]);
  const after = restart(w, () => undefined);
  after.gateway.recover(items);
  assert.equal((await after.gateway.status!(req)).vote, "yes");
});
