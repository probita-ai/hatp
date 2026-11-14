// Decisions that arrive after the gateway withdrew the ask (issue #101): recorded, signed, never counted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionDigest, createApprovalGate, HatpError, questionDigest, verifyObject, verifyRecord } from "../src/index.ts";
import type { Action, ActionApproval, Approval, Question } from "../src/index.ts";
import { buildWorld, tripPlan } from "./fixtures.ts";

const alice = "human://acme.com/alice";
const bob = "human://acme.com/bob";
const carol = "human://acme.com/carol";
const role = "human://acme.com/role/finance-approver";
const server = "https://payments.example";
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const nobody = { [alice]: "ignore", [bob]: "ignore", [carol]: "ignore" } as const;
const isCode = (code: string) => (e: unknown) => e instanceof HatpError && e.code === code;

test("an approve after the transaction's deadline is recorded, signed, and changes nothing", async () => {
  const w = buildWorld({ script: { ...nobody }, gatewayMsPerSecond: 1000 });
  const plan = tripPlan({ prepareOrder: "parallel" }, { decideBy: inMs(150) });
  const record = await w.coordinator.run(plan);
  assert.equal(record.state, "ABORTED");
  assert.equal(record.events.find((e) => e.type === "decision")?.data.code, "DEADLINE_EXCEEDED");

  const [ask] = w.voteAsks;
  const late = w.gateway.recordLate(ask.askId, { decision: "approve", method: "slack-sso" });
  assert.equal(late.type, "hatp.late-decision");
  assert.equal(late.counted, false);
  assert.equal(late.withdrawnBecause, "deadline");
  assert.equal(late.human, alice);
  assert.deepEqual(late.subject, { kind: "vote", txnId: plan.txnId, groupId: ask.groupId, planDigest: record.planDigest });
  assert.ok(Date.parse(late.receivedAt) >= Date.parse(late.withdrawnAt));
  assert.ok(verifyObject(late, w.gatewaySigner.publicJwk), "signed by the gateway");
  assert.deepEqual(w.gateway.lateDecisions({ txnId: plan.txnId }), [late]);
  assert.deepEqual(w.gateway.lateDecisions({ txnId: "other" }), []);

  // Planted violation: slipping the late record in as an approval does not make the record verify.
  const forged = { ...record, approvals: [...record.approvals, late as unknown as Approval] };
  const { ok, problems } = verifyRecord(forged, w.keyring);
  assert.equal(ok, false);
  assert.ok(problems.some((p) => /hatp\.late-decision .* is not an approval/.test(p)), problems.join("\n"));
  assert.deepEqual(verifyRecord(record, w.keyring), { ok: true, problems: [] }, "the real record is unchanged");
});

test("a human whose SLA passed and who clicks later is recorded as late, while the delegate's approval counts", async () => {
  const w = buildWorld({ script: { [alice]: "ignore", [carol]: { decision: "approve" } } });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.state, "COMMITTED");
  const aliceAsk = w.voteAsks.find((a) => a.routedVia.at(-1) === alice)!;
  const late = w.gateway.recordLate(aliceAsk.askId, { decision: "reject", method: "email" });
  assert.equal(late.withdrawnBecause, "sla");
  assert.equal(late.decision, "reject");
  assert.deepEqual(record.approvals.map((a) => a.approver), [carol], "the late reject did not undo carol's approval");
});

test("a late approve of a tool call is refused by the approval gate", async () => {
  const w = buildWorld({ script: { ...nobody }, gatewayMsPerSecond: 1000 });
  const action: Action = { type: "mcp.tools/call", server, tool: "charge_card", arguments: { amount: { value: 120, currency: "USD" } } };
  await assert.rejects(
    w.gateway.askApprove({ address: role, requirement: { action: "approve.spend", amountFrom: "/amount" }, action, actionDigest: actionDigest(action), decideBy: inMs(60) }),
    isCode("DEADLINE_EXCEEDED"),
  );
  const late = w.gateway.recordLate(w.actionAsks[0].askId, { decision: "approve", method: "webauthn" });
  assert.deepEqual(late.subject, { kind: "action", actionDigest: actionDigest(action), audience: server });
  assert.deepEqual(w.gateway.lateDecisions({ actionDigest: actionDigest(action) }), [late]);

  const gate = createApprovalGate({ serverId: server, trustedGateways: { [w.gateway.id]: [w.gatewaySigner.publicJwk] } });
  assert.throws(
    () => gate.check({ tool: "charge_card", arguments: action.arguments, requires: { address: role, requirement: { action: "approve.spend" } }, approvals: [late as unknown as ActionApproval] }),
    (e: unknown) => isCode("APPROVAL_INVALID")(e) && /only approvals/.test((e as Error).message),
  );
});

test("a late answer to a question records its digest, and a cancelled ask records why", async () => {
  const w = buildWorld({ script: { ...nobody }, gatewayMsPerSecond: 1000 });
  const q: Question = { kind: "choose", prompt: "Which flight?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
  const ctl = new AbortController();
  const asked = w.gateway.askQuestion({ address: role, question: q, questionDigest: questionDigest(q), decideBy: inMs(30_000) }, { signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 20));
  ctl.abort();
  await assert.rejects(asked, isCode("INVALID_STATE"));
  const late = w.gateway.recordLate(w.questionAsks[0].askId, { status: "answered", answer: { choices: ["b"] }, method: "web" });
  assert.equal(late.withdrawnBecause, "cancelled");
  assert.equal(late.decision, "answered");
  assert.match(late.answerDigest ?? "", /^sha256:/);
  assert.deepEqual(w.gateway.lateDecisions({ questionDigest: questionDigest(q) }), [late]);
});

test("only withdrawn asks can be recorded late", async () => {
  const w = buildWorld();
  assert.throws(() => w.gateway.recordLate("no-such-ask", { decision: "approve", method: "web" }), isCode("TXN_UNKNOWN"));
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.state, "COMMITTED");
  // alice decided in time: her ask was never withdrawn.
  assert.throws(() => w.gateway.recordLate(w.voteAsks[0].askId, { decision: "approve", method: "web" }), isCode("TXN_UNKNOWN"));
  assert.deepEqual(w.gateway.lateDecisions(), []);
});

test("past lateWindowSeconds a withdrawn ask is forgotten", async () => {
  const w = buildWorld({ script: { ...nobody }, gatewayMsPerSecond: 1000, lateWindowSeconds: 0.05 });
  await w.coordinator.run(tripPlan({ prepareOrder: "parallel" }, { decideBy: inMs(100) }));
  await new Promise((r) => setTimeout(r, 80));
  assert.throws(() => w.gateway.recordLate(w.voteAsks[0].askId, { decision: "approve", method: "web" }), isCode("TXN_UNKNOWN"));
});
