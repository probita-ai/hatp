// Conformance scenario for the Human Gateway extension (SEP Appendix A): each case plants one violation
// against a gated server or a gateway over MCP, and checks the refusal and that the tool never ran.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { actionDigest, createApprovalGate, createHumanGateway, createSigner, Directory, HatpError, nonce, signCard, signObject, toolDigest } from "hatp-protocol";
import type { Action, ActionApproval, Approval, HumanChannel, Payment } from "hatp-protocol";
import { z } from "zod";
import { callGatedTool, gateTools, GatedToolError, humanGatewayClientCapabilities, mcpHumanGateway, serveHumanGateway } from "../src/index.ts";

const serverId = "https://payments.example";
const finance = "human://acme.com/role/finance-approver";
const USDC = "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const args = { amount: { value: 2140, currency: "USD" }, payee: "Lufthansa" };
const payment: Payment = { network: "eip155:8453", asset: USDC, maxAmount: "2500000", payTo: "0x9a3f" };

async function connect(server: McpServer, capabilities: object = humanGatewayClientCapabilities) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "agent", version: "0.0.0" }, { capabilities });
  await client.connect(a);
  return client;
}

async function world() {
  const issuer = createSigner("https://directory.acme.com");
  const card = (local: string) => signCard({
    id: `human://acme.com/${local}`, displayName: local, org: "acme.com", roles: ["finance-approver"],
    authority: [{ action: "approve.spend", maxAmount: { value: 10000, currency: "USD" } }, { action: "approve.spend", maxAmount: { value: 50_000_000, currency: USDC } }],
    channels: ["web"], sla: { decideSeconds: 60 }, keys: [], issuer: issuer.id,
  }, issuer);
  const directory = new Directory([issuer.publicJwk]).add(card("alice")).add(card("bob")).add(card("dana"));
  const asked: string[] = [];
  const channel: HumanChannel = {
    deliver: () => new Promise(() => {}),
    deliverAction: (_ask, human, signal) => new Promise((resolve, reject) => {
      asked.push(human.id);
      const t = setTimeout(() => resolve({ decision: human.id.endsWith("/dana") ? "reject" : "approve", method: "test" }), 1);
      signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("withdrawn")); }, { once: true });
    }),
  };
  const signer = createSigner("https://gateway.acme.com");
  const gateway = createHumanGateway({ id: signer.id, signer, directory, channel });
  const gatewayServer = new McpServer({ name: "gateway", version: "0.0.0" });
  serveHumanGateway(gatewayServer, gateway, { extension: { gatewayId: signer.id, orgs: ["acme.com"], keys: [signer.publicJwk], assurance: ["gateway-attested"] }, principal: () => "human://acme.com/dana" });

  const ran: string[] = [];
  let skewMs = 0;
  let price = "2000000";
  const payments = new McpServer({ name: "payments", version: "0.0.0" });
  const amountSchema = { amount: z.object({ value: z.number(), currency: z.string() }), payee: z.string() };
  const run = (name: string) => async () => { ran.push(name); return { content: [{ type: "text" as const, text: "done" }] }; };
  const charge = payments.registerTool("charge_card", { description: "Charge the corporate card", inputSchema: amountSchema }, run("charge_card"));
  payments.registerTool("refund", { inputSchema: amountSchema }, run("refund"));
  payments.registerTool("wire_transfer", { inputSchema: amountSchema }, run("wire_transfer"));
  payments.registerTool("sign_contract", { inputSchema: amountSchema }, run("sign_contract"));
  payments.registerTool("premium_report", { inputSchema: { ticker: z.string() } }, run("premium_report"));
  const req = { address: finance, requirement: { action: "approve.spend", amountFrom: "/amount" } };
  gateTools(payments, {
    gate: createApprovalGate({ serverId, trustedGateways: { [signer.id]: [signer.publicJwk] }, cards: directory, now: () => Date.now() + skewMs }),
    extension: { serverId, trustedGateways: [signer.id] },
    tools: {
      charge_card: { requires: req },
      refund: { requires: req },
      wire_transfer: { requires: { ...req, address: `${finance}?quorum=2-of-2` } },
      sign_contract: { requires: { ...req, assurance: "human-signed" } },
      premium_report: { requires: { address: finance, requirement: { action: "approve.spend", amountFrom: "payment" }, payment: { network: payment.network, asset: payment.asset } }, terms: () => ({ network: payment.network, asset: USDC, amount: price, payTo: "0x9a3f" }) },
    },
  });

  const approve = async (a: Action, address = finance) =>
    (await gateway.askApprove({ address, requirement: { action: "approve.spend", amountFrom: a.payment ? "payment" : "/amount" }, action: a, actionDigest: actionDigest(a), decideBy: inMs(30_000) })).approvals;
  return {
    signer, gateway, gatewayServer, payments, charge, ran, asked, approve,
    pay: await connect(payments),
    skew: (ms: number) => { skewMs = ms; },
    setPrice: (p: string) => { price = p; },
  };
}

const action = (tool = "charge_card", extra: Partial<Action> = {}): Action => ({ type: "mcp.tools/call", server: serverId, tool, arguments: args, ...extra });
const refusedWith = (code: string, match?: RegExp) => (e: unknown) => e instanceof GatedToolError && e.code === code && (!match || match.test(e.message));

test("G1 a gated tool called without an approval", async () => {
  const w = await world();
  await assert.rejects(callGatedTool(w.pay, { name: "charge_card", arguments: args }), (e: unknown) => refusedWith("APPROVAL_REQUIRED")(e) && (e as GatedToolError).requires?.address === finance);
  assert.deepEqual(w.ran, []);
});

test("G2 an approval presented with changed arguments", async () => {
  const w = await world();
  const approvals = await w.approve(action());
  await assert.rejects(callGatedTool(w.pay, { name: "charge_card", arguments: { ...args, amount: { value: 9_999, currency: "USD" } }, approvals }), refusedWith("APPROVAL_INVALID", /another call/));
  assert.deepEqual(w.ran, []);
});

test("G3 an approval for one tool presented to another", async () => {
  const w = await world();
  const approvals = await w.approve(action("charge_card"));
  await assert.rejects(callGatedTool(w.pay, { name: "refund", arguments: args, approvals }), refusedWith("APPROVAL_INVALID"));
  assert.deepEqual(w.ran, []);
});

test("G4 an approval for another server", async () => {
  const w = await world();
  const approvals = await w.approve({ ...action(), server: "https://other.example" });
  await assert.rejects(callGatedTool(w.pay, { name: "charge_card", arguments: args, approvals }), refusedWith("APPROVAL_INVALID"));
  assert.deepEqual(w.ran, []);
});

test("G5 an approval used after it expires", async () => {
  const w = await world();
  const approvals = await w.approve(action());
  w.skew(Date.parse(approvals[0].expiresAt) - Date.now() + 1);
  await assert.rejects(callGatedTool(w.pay, { name: "charge_card", arguments: args, approvals }), refusedWith("APPROVAL_INVALID", /validity window/));
  assert.deepEqual(w.ran, []);
});

test("G6 an approval replayed after the tool ran", async () => {
  const w = await world();
  const approvals = await w.approve(action());
  await callGatedTool(w.pay, { name: "charge_card", arguments: args, approvals });
  await assert.rejects(callGatedTool(w.pay, { name: "charge_card", arguments: args, approvals }), refusedWith("APPROVAL_INVALID", /already used/));
  assert.deepEqual(w.ran, ["charge_card"]);
});

test("G7 one approval used by two concurrent calls", async () => {
  const w = await world();
  const approvals = await w.approve(action());
  await Promise.allSettled([1, 2].map(() => callGatedTool(w.pay, { name: "charge_card", arguments: args, approvals })));
  assert.deepEqual(w.ran, ["charge_card"]);
});

test("G8 an approval signed by a key the server doesn't trust", async () => {
  const w = await world();
  const [a] = await w.approve(action());
  const { signature: _s, ...unsigned } = a;
  const forged = signObject<ActionApproval>(unsigned, createSigner(a.issuer)); // same issuer name, someone else's key
  await assert.rejects(callGatedTool(w.pay, { name: "charge_card", arguments: args, approvals: [forged] }), refusedWith("APPROVAL_INVALID", /trusted gateway/));
  assert.deepEqual(w.ran, []);
});

test("G9 an approval altered after signing", async () => {
  const w = await world();
  const [a] = await w.approve(action());
  await assert.rejects(callGatedTool(w.pay, { name: "charge_card", arguments: args, approvals: [{ ...a, approver: "human://acme.com/ceo" }] }), refusedWith("APPROVAL_INVALID", /trusted gateway/));
  assert.deepEqual(w.ran, []);
});

test("G10 a rejection presented as an approval", async () => {
  const w = await world();
  const { approvals } = await w.gateway.askApprove({ address: "human://acme.com/dana", requirement: { action: "approve.spend", amountFrom: "/amount" }, action: action(), actionDigest: actionDigest(action()), decideBy: inMs(30_000) });
  assert.equal(approvals[0].decision, "reject");
  await assert.rejects(callGatedTool(w.pay, { name: "charge_card", arguments: args, approvals }), refusedWith("APPROVAL_INVALID", /decision approve/));
  assert.deepEqual(w.ran, []);
});

test("G11 fewer distinct approvers than the tool requires", async () => {
  const w = await world();
  const approvals = await w.approve(action("wire_transfer"));
  await assert.rejects(callGatedTool(w.pay, { name: "wire_transfer", arguments: args, approvals }), refusedWith("APPROVAL_INVALID", /1\/2 distinct approvers/));
  await assert.rejects(callGatedTool(w.pay, { name: "wire_transfer", arguments: args, approvals: [...approvals, ...approvals] }), refusedWith("APPROVAL_INVALID"));
  assert.deepEqual(w.ran, []);
});

test("G12 a gateway-attested approval for a tool that requires human-signed", async () => {
  const w = await world();
  const approvals = await w.approve(action("sign_contract"));
  await assert.rejects(callGatedTool(w.pay, { name: "sign_contract", arguments: args, approvals }), refusedWith("APPROVAL_INVALID", /not human-signed/));
  assert.deepEqual(w.ran, []);
});

test("G13 the tool's definition changed after the human approved it", async () => {
  const w = await world();
  const listed = (await w.pay.listTools()).tools.find((t) => t.name === "charge_card")!;
  const approvals = await w.approve(action("charge_card", { toolDigest: toolDigest(listed) }));
  w.charge.update({ description: "Charge any card; no limits" });
  await assert.rejects(callGatedTool(w.pay, { name: "charge_card", arguments: args, approvals }), refusedWith("APPROVAL_INVALID", /tool version/));
  assert.deepEqual(w.ran, []);
});

test("G14 a paid tool whose price rises above the approved payment, or whose payee changes", async () => {
  const w = await world();
  const paid = action("premium_report", { arguments: { ticker: "ACME" }, payment });
  const approvals = await w.approve(paid);
  w.setPrice("3000000");
  await assert.rejects(callGatedTool(w.pay, { name: "premium_report", arguments: { ticker: "ACME" }, approvals, payment }), refusedWith("APPROVAL_INVALID", /more than the approved/));
  w.setPrice("2000000");
  await assert.rejects(callGatedTool(w.pay, { name: "premium_report", arguments: { ticker: "ACME" }, approvals, payment: { ...payment, payTo: "0xevil" } }), refusedWith("APPROVAL_INVALID"));
  await assert.rejects(callGatedTool(w.pay, { name: "premium_report", arguments: { ticker: "ACME" }, approvals }), refusedWith("APPROVAL_INVALID", /pass the approved payment/));
  assert.deepEqual(w.ran, []);
});

test("G15 a transaction Approval presented to a gated server (Open Question 1)", async () => {
  const w = await world();
  const t = new Date().toISOString();
  const txnApproval = signObject<Approval>({
    type: "hatp.approval", txnId: "txn_1", groupId: "finance", planDigest: actionDigest(action()), decision: "approve", approver: "human://acme.com/bob",
    routedVia: [finance, "human://acme.com/bob"], authentication: { method: "test", at: t, assurance: "gateway-attested" }, nonce: nonce(), decidedAt: t, issuer: w.signer.id,
  }, w.signer);
  await assert.rejects(callGatedTool(w.pay, { name: "charge_card", arguments: args, approvals: [txnApproval as unknown as ActionApproval] }), refusedWith("APPROVAL_INVALID"));
  assert.deepEqual(w.ran, []);
});

test("G16 the requester as approver of their own request", async () => {
  const w = await world();
  const gw = mcpHumanGateway(await connect(w.gatewayServer));
  // The address names only the requester (dana, from the transport): nobody else is eligible.
  await assert.rejects(gw.askApprove({ address: "human://acme.com/dana", requirement: { action: "approve.spend", amountFrom: "/amount" }, action: action(), actionDigest: actionDigest(action()), decideBy: inMs(30_000) }), (e: unknown) => e instanceof HatpError && e.code === "AUTHORITY_INSUFFICIENT");
  assert.deepEqual(w.asked, []);
});

test("G17 an ask whose digest doesn't match its action", async () => {
  const w = await world();
  const gw = mcpHumanGateway(await connect(w.gatewayServer));
  await assert.rejects(gw.askApprove({ address: finance, requirement: { action: "approve.spend", amountFrom: "/amount" }, action: action(), actionDigest: actionDigest({ ...action(), arguments: { amount: { value: 1, currency: "USD" }, payee: "x" } }), decideBy: inMs(30_000) }), (e: unknown) => e instanceof HatpError && e.code === "ACTION_MISMATCH");
  assert.deepEqual(w.asked, []);
});

test("G18 an ask from a client that did not negotiate the extension", async () => {
  const w = await world();
  const gw = mcpHumanGateway(await connect(w.gatewayServer, {}));
  await assert.rejects(gw.askApprove({ address: finance, requirement: { action: "approve.spend", amountFrom: "/amount" }, action: action(), actionDigest: actionDigest(action()), decideBy: inMs(30_000) }), (e: unknown) => e instanceof HatpError && e.code === "NOT_SUPPORTED");
  assert.deepEqual(w.asked, []);
});
