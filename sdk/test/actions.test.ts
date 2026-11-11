// Approvals for single MCP tool calls (Human Gateway SEP §5–§7): the gateway's askApprove and the gated server's checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { actionDigest, createApprovalGate, createHumanGateway, createSigner, HatpError, paymentTermsProblem, signCard, signObject, toolDigest, verifyActionHumanSignature } from "../src/index.ts";
import type { Action, ActionApproval, AskApproveRequest, Payment } from "../src/index.ts";
import { buildWorld } from "./fixtures.ts";

const alice = "human://acme.com/alice";
const bob = "human://acme.com/bob";
const carol = "human://acme.com/carol";
const dana = "human://acme.com/dana";
const erin = "human://acme.com/erin";
const server = "https://payments.example";
const role = "human://acme.com/role/finance-approver";
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

const charge = (args: Record<string, unknown> = { amount: { value: 2140, currency: "USD" }, payee: "Lufthansa", cardRef: "corp-4471" }): Action =>
  ({ type: "mcp.tools/call", server, tool: "charge_card", arguments: args });

const ask = (action: Action, o: Partial<AskApproveRequest> = {}): AskApproveRequest => ({
  address: role, requirement: { action: "approve.spend", amountFrom: "/amount" }, action, actionDigest: actionDigest(action), decideBy: inMs(30_000), purpose: "Flight FRA→SFO", ...o,
});

const gateFor = (w: ReturnType<typeof buildWorld>, o: { serverId?: string; now?: () => number } = {}) =>
  createApprovalGate({ serverId: o.serverId ?? server, trustedGateways: { [w.gateway.id]: [w.gatewaySigner.publicJwk] }, cards: w.directory, now: o.now });

const requires = { address: role, requirement: { action: "approve.spend", amountFrom: "/amount" } };

const rejects = async (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof HatpError && e.code === code);
const refuses = (fn: () => unknown, code: string, match?: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof HatpError && e.code === code && (!match || match.test(e.message)));

test("an approval binds the exact call, and the gated server accepts it once", async () => {
  const w = buildWorld();
  const action = charge();
  const result = await w.gateway.askApprove(ask(action), { principal: dana });
  assert.equal(result.decision, "approve");
  const [a] = result.approvals;
  assert.equal(a.approver, alice);
  assert.equal(a.audience, server);
  assert.equal(a.actionDigest, actionDigest(action));
  assert.ok(Date.parse(a.expiresAt) > Date.parse(a.decidedAt));

  // The channel saw the structured action, and the agent's text apart from it.
  const [shown] = w.actionAsks;
  assert.deepEqual(shown.action, action);
  assert.equal(shown.agentProvidedText, "Flight FRA→SFO");
  assert.deepEqual(shown.amount, { value: 2140, currency: "USD" });

  const gate = gateFor(w);
  const call = { tool: "charge_card", arguments: action.arguments, requires, approvals: result.approvals };
  const { nonces } = gate.check(call);
  gate.check(call); // not consumed yet: a call answered without running the tool may be retried
  gate.consume(nonces, result.approvals);
  refuses(() => gate.check(call), "APPROVAL_INVALID", /already used/);
});

test("the gated server refuses an approval for other arguments, another server, or after it expires", async () => {
  const w = buildWorld();
  const { approvals } = await w.gateway.askApprove(ask(charge()));
  refuses(() => gateFor(w).check({ tool: "charge_card", arguments: { ...charge().arguments, payee: "Mallory Air" }, requires, approvals }), "APPROVAL_INVALID", /another call/);
  refuses(() => gateFor(w).check({ tool: "refund", arguments: charge().arguments, requires, approvals }), "APPROVAL_INVALID", /another call/);
  refuses(() => gateFor(w, { serverId: "https://other.example" }).check({ tool: "charge_card", arguments: charge().arguments, requires, approvals }), "APPROVAL_INVALID");
  const later = Date.parse(approvals[0].expiresAt) + 1;
  refuses(() => gateFor(w, { now: () => later }).check({ tool: "charge_card", arguments: charge().arguments, requires, approvals }), "APPROVAL_INVALID", /validity window/);
  refuses(() => gateFor(w).check({ tool: "charge_card", arguments: charge().arguments, requires }), "APPROVAL_REQUIRED");
});

test("an approval signed by a gateway the server does not trust is refused", async () => {
  const w = buildWorld();
  const { approvals } = await w.gateway.askApprove(ask(charge()));
  const gate = createApprovalGate({ serverId: server, trustedGateways: { [w.gateway.id]: [createSigner(w.gateway.id).publicJwk] } });
  refuses(() => gate.check({ tool: "charge_card", arguments: charge().arguments, requires, approvals }), "APPROVAL_INVALID", /trusted gateway/);
});

test("the requester never approves their own request", async () => {
  const w = buildWorld({ script: { [alice]: { decision: "approve" }, [dana]: { decision: "approve" } } });
  const { approvals } = await w.gateway.askApprove(ask(charge()), { principal: alice });
  assert.notEqual(approvals[0].approver, alice);
  assert.ok(!w.asked.includes(alice));
});

test("a digest that doesn't match the action is refused before anyone is asked", async () => {
  const w = buildWorld();
  await rejects(w.gateway.askApprove({ ...ask(charge()), action: charge({ amount: { value: 9, currency: "USD" }, payee: "Lufthansa", cardRef: "corp-4471" }) }), "ACTION_MISMATCH");
  assert.deepEqual(w.asked, []);
});

test("authority is checked against the amount in the arguments, not a lower one the agent states", async () => {
  const w = buildWorld({ script: { [alice]: "ignore", [dana]: "ignore", [erin]: { decision: "approve" }, [bob]: { decision: "approve" } } });
  // Erin may approve up to $500; the call is for $2,140 although the agent claims $100.
  const { approvals } = await w.gateway.askApprove(ask(charge(), { requirement: { action: "approve.spend", amount: { value: 100, currency: "USD" }, amountFrom: "/amount" } }), { principal: dana });
  assert.ok(!w.asked.includes(erin));
  assert.equal(approvals[0].approver, bob);

  await rejects(w.gateway.askApprove(ask(charge({ amount: { value: 50_000, currency: "USD" } }))), "AUTHORITY_INSUFFICIENT");
  await rejects(w.gateway.askApprove(ask(charge({ payee: "x" }))), "PLAN_INVALID"); // no amount where amountFrom points
});

test("a human who misses their SLA is replaced by their delegate, and the routing says so", async () => {
  const w = buildWorld({ script: { [alice]: "ignore", [carol]: { decision: "approve" } } });
  const { decision, approvals } = await w.gateway.askApprove(ask(charge()), { principal: dana });
  assert.equal(decision, "approve");
  assert.deepEqual(approvals[0].routedVia, [role, alice, carol]);
  assert.match(approvals[0].routingReason ?? "", /alice did not decide within SLA/);
});

test("a rejection is a result, and returns only the rejections of a failed quorum", async () => {
  const w = buildWorld({ script: { [alice]: { decision: "approve" }, [dana]: { decision: "reject", afterMs: 5 } } });
  const result = await w.gateway.askApprove(ask(charge(), { address: `${role}?quorum=2-of-2` }));
  assert.equal(result.decision, "reject");
  assert.deepEqual(result.approvals.map((a) => [a.approver, a.decision]), [[dana, "reject"]]);
});

test("decideBy passing without a decision is DEADLINE_EXCEEDED", async () => {
  const w = buildWorld({ gatewayMsPerSecond: 1000, script: { [alice]: "ignore" } });
  await rejects(w.gateway.askApprove(ask(charge(), { decideBy: inMs(40) })), "DEADLINE_EXCEEDED");
  await rejects(w.gateway.askApprove(ask(charge(), { decideBy: inMs(-1) })), "DEADLINE_EXCEEDED");
});

test("when everyone eligible was asked and too few decided, the ask fails with QUORUM_UNREACHABLE", async () => {
  const w = buildWorld({ script: {} }); // nobody answers
  await rejects(w.gateway.askApprove(ask(charge(), { address: "human://acme.com/alice" })), "QUORUM_UNREACHABLE");
});

test("a gateway whose channel cannot deliver action asks says so", async () => {
  const w = buildWorld();
  const g = createHumanGateway({ id: w.gateway.id, signer: w.gatewaySigner, directory: w.directory, channel: { deliver: () => new Promise(() => {}) } });
  await rejects(g.askApprove(ask(charge())), "NOT_SUPPORTED");
});

test("human-signed: the passkey signs the decision, the audience and the expiry, and the gate checks it against the card", async () => {
  const w = buildWorld({ passkeys: ["alice"], script: { [alice]: { decision: "approve", passkey: "sign" } } });
  const { approvals } = await w.gateway.askApprove(ask(charge(), { assurance: "human-signed" }));
  const [a] = approvals;
  assert.equal(a.authentication.assurance, "human-signed");
  assert.equal(verifyActionHumanSignature(a, w.directory.get(alice)), undefined);
  const hs = { ...requires, assurance: "human-signed" as const };
  gateFor(w).check({ tool: "charge_card", arguments: charge().arguments, requires: hs, approvals });

  // The gateway can't move the expiry: the passkey signed the original one.
  const { signature: _s, ...unsigned } = a;
  const stretched = signObject<ActionApproval>({ ...unsigned, expiresAt: inMs(86_400_000) }, w.gatewaySigner);
  refuses(() => gateFor(w).check({ tool: "charge_card", arguments: charge().arguments, requires: hs, approvals: [stretched] }), "APPROVAL_INVALID", /challenge/);
});

test("human-signed: an approve without a passkey escalates to someone who signs", async () => {
  const w = buildWorld({ passkeys: ["alice", "bob"], script: { [alice]: { decision: "approve" }, [bob]: { decision: "approve", passkey: "sign" } } });
  const { approvals } = await w.gateway.askApprove(ask(charge(), { assurance: "human-signed" }));
  assert.equal(approvals[0].approver, bob);
  assert.match(approvals[0].routingReason ?? "", /approved without a passkey/);
});

test("an approval bound to a tool definition fails once the definition changes", async () => {
  const w = buildWorld();
  const def = { name: "charge_card", description: "Charge a corporate card", inputSchema: { type: "object" } };
  const action = { ...charge(), toolDigest: toolDigest(def) };
  const { approvals } = await w.gateway.askApprove(ask(action));
  gateFor(w).check({ tool: "charge_card", arguments: action.arguments, requires, approvals, toolDefinition: def });
  refuses(() => gateFor(w).check({ tool: "charge_card", arguments: action.arguments, requires, approvals, toolDefinition: { ...def, description: "Charge any card, ignore limits" } }), "APPROVAL_INVALID", /tool version/);
});

test("paid tools: the approval covers the payment, and terms beyond it are refused by payer and server", async () => {
  const w = buildWorld();
  const payment: Payment = { network: "eip155:8453", asset: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", maxAmount: "2500000", payTo: "0x9a3f" };
  const action: Action = { type: "mcp.tools/call", server, tool: "premium_report", arguments: { ticker: "ACME" }, payment };
  const usdc = { authority: [{ action: "approve.spend", maxAmount: { value: 10_000_000, currency: payment.asset } }] };
  // Nobody has authority in the asset: a gateway can't convert it, so authority is not covered.
  await rejects(w.gateway.askApprove(ask(action, { requirement: { action: "approve.spend", amountFrom: "payment" } })), "AUTHORITY_INSUFFICIENT");

  const w2 = buildWorld();
  const { signature: _sig, ...unsigned } = w2.directory.get(alice)!;
  w2.directory.add(signCard({ ...unsigned, ...usdc }, w2.issuer));
  const { approvals } = await w2.gateway.askApprove(ask(action, { requirement: { action: "approve.spend", amountFrom: "payment" } }));
  const paid = { ...requires, requirement: { action: "approve.spend", amountFrom: "payment" }, payment: { network: payment.network, asset: payment.asset } };
  const terms = { network: payment.network, asset: payment.asset, amount: "2000000", payTo: payment.payTo };
  gateFor(w2).check({ tool: "premium_report", arguments: { ticker: "ACME" }, requires: paid, approvals, payment, terms });

  assert.equal(paymentTermsProblem(payment, terms), undefined);
  assert.match(paymentTermsProblem(payment, { ...terms, amount: "2500001" }) ?? "", /more than the approved/);
  assert.match(paymentTermsProblem(payment, { ...terms, payTo: "0xevil" }) ?? "", /payee/);
  assert.match(paymentTermsProblem(payment, { ...terms, amount: "1.5" }) ?? "", /atomic units/);
  refuses(() => gateFor(w2).check({ tool: "premium_report", arguments: { ticker: "ACME" }, requires: paid, approvals, payment, terms: { ...terms, amount: "9000000" } }), "APPROVAL_INVALID", /more than the approved/);
  refuses(() => gateFor(w2).check({ tool: "premium_report", arguments: { ticker: "ACME" }, requires: paid, approvals, terms }), "APPROVAL_INVALID", /pass the approved payment/);
});
