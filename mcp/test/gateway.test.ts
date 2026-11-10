// The Human Gateway extension over MCP (SEP §2–§6): asks, cards as resources, and approval-gated tools.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { actionDigest, createApprovalGate, createHumanGateway, createSigner, Directory, HatpError, signCard, toolDigest } from "hatp-protocol";
import type { Action, AskApproveRequest, HumanChannel, HumanDecision } from "hatp-protocol";
import { z } from "zod";
import { callGatedTool, gateTools, GatedToolError, HUMAN_CARD_MIME, humanGatewayClientCapabilities, mcpHumanGateway, requiresOf, serveHumanGateway } from "../src/index.ts";

const role = "human://acme.com/role/finance-approver";
const bob = "human://acme.com/bob";
const dana = "human://acme.com/dana";
const serverId = "https://payments.example";
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

async function connect(server: Server | McpServer, capabilities: object = humanGatewayClientCapabilities) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "agent", version: "0.0.0" }, { capabilities });
  await client.connect(clientSide);
  return client;
}

function world(o: { decision?: HumanDecision["decision"]; principal?: string; lowLevel?: boolean } = {}) {
  const issuer = createSigner("https://directory.acme.com");
  const card = (local: string) => signCard({
    id: `human://acme.com/${local}`, displayName: local, org: "acme.com", roles: ["finance-approver"],
    authority: [{ action: "approve.spend", maxAmount: { value: 10000, currency: "USD" } }],
    channels: ["web"], sla: { decideSeconds: 60 }, keys: [], issuer: issuer.id,
  }, issuer);
  const directory = new Directory([issuer.publicJwk]).add(card("dana")).add(card("bob"));
  const asked: string[] = [];
  const channel: HumanChannel = {
    deliver: () => new Promise(() => {}),
    deliverAction: (_ask, human, signal) => new Promise((resolve, reject) => {
      asked.push(human.id);
      const t = setTimeout(() => resolve({ decision: o.decision ?? "approve", method: "test" }), 1);
      signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("withdrawn")); }, { once: true });
    }),
  };
  const signer = createSigner("https://gateway.acme.com");
  const gateway = createHumanGateway({ id: signer.id, signer, directory, channel });
  const gatewayServer = o.lowLevel ? new Server({ name: "gateway", version: "0.0.0" }) : new McpServer({ name: "gateway", version: "0.0.0" });
  serveHumanGateway(gatewayServer, gateway, {
    extension: { gatewayId: signer.id, orgs: ["acme.com"], keys: [signer.publicJwk], assurance: ["gateway-attested"] },
    cards: directory,
    principal: () => o.principal,
  });

  // The payments server: charge_card is gated, ping is not.
  const charged: unknown[] = [];
  const payments = new McpServer({ name: "payments", version: "0.0.0" });
  const chargeTool = payments.registerTool("charge_card", { description: "Charge a corporate card", inputSchema: { amount: z.object({ value: z.number(), currency: z.string() }), payee: z.string(), fail: z.boolean().optional() } }, async (args) => {
    if (args.fail) return { content: [{ type: "text", text: "card declined" }], isError: true };
    charged.push(args);
    return { content: [{ type: "text", text: "charged" }] };
  });
  payments.registerTool("ping", { inputSchema: {} }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  const requires = { address: role, requirement: { action: "approve.spend", amountFrom: "/amount" } };
  gateTools(payments, {
    gate: createApprovalGate({ serverId, trustedGateways: { [signer.id]: [signer.publicJwk] } }),
    extension: { serverId, trustedGateways: [signer.id] },
    tools: { charge_card: { requires } },
  });
  return { issuer, directory, gateway, gatewayServer, payments, chargeTool, charged, asked, requires };
}

const args = { amount: { value: 2140, currency: "USD" }, payee: "Lufthansa" };
const action = (extra: Partial<Action> = {}): Action => ({ type: "mcp.tools/call", server: serverId, tool: "charge_card", arguments: args, ...extra });
const ask = (a: Action, o: Partial<AskApproveRequest> = {}): AskApproveRequest => ({ address: role, requirement: { action: "approve.spend", amountFrom: "/amount" }, action: a, actionDigest: actionDigest(a), decideBy: inMs(30_000), ...o });

test("an agent gets an approval over MCP and the gated server runs the call once", async () => {
  const w = world({ principal: dana });
  const gw = mcpHumanGateway(await connect(w.gatewayServer));
  const pay = await connect(w.payments);
  assert.equal(gw.extension.gatewayId, "https://gateway.acme.com");

  // tools/list says what charge_card needs; ping needs nothing.
  const { tools } = await pay.listTools();
  assert.deepEqual(requiresOf(tools.find((t) => t.name === "charge_card")!), w.requires);
  assert.equal(requiresOf(tools.find((t) => t.name === "ping")!), undefined);

  // Without an approval: a JSON-RPC error, repeating what to ask for, and the tool did not run.
  await assert.rejects(callGatedTool(pay, { name: "charge_card", arguments: args }), (e: unknown) => e instanceof GatedToolError && e.code === "APPROVAL_REQUIRED" && e.requires?.address === role);
  assert.equal(w.charged.length, 0);

  const result = await gw.askApprove(ask(action(), { purpose: "Flight FRA→SFO" }));
  assert.equal(result.decision, "approve");
  assert.equal(result.approvals[0].approver, bob); // dana sent the ask
  assert.ok(!w.asked.includes(dana));

  const ok = await callGatedTool(pay, { name: "charge_card", arguments: args, approvals: result.approvals });
  assert.equal(ok.isError, undefined);
  assert.equal(w.charged.length, 1);

  await assert.rejects(callGatedTool(pay, { name: "charge_card", arguments: args, approvals: result.approvals }), (e: unknown) => e instanceof GatedToolError && e.code === "APPROVAL_INVALID");
  await assert.rejects(callGatedTool(pay, { name: "charge_card", arguments: { ...args, payee: "Mallory Air" }, approvals: result.approvals }), (e: unknown) => e instanceof GatedToolError && e.code === "APPROVAL_INVALID");
  assert.equal(w.charged.length, 1);
  assert.equal((await pay.callTool({ name: "ping", arguments: {} })).isError, undefined);
});

test("a tool that answers with an error doesn't use up the approval", async () => {
  const w = world();
  const gw = mcpHumanGateway(await connect(w.gatewayServer));
  const pay = await connect(w.payments);
  const failing = { ...args, fail: true };
  const { approvals } = await gw.askApprove(ask(action({ arguments: failing })));
  assert.equal((await callGatedTool(pay, { name: "charge_card", arguments: failing, approvals })).isError, true);
  assert.equal((await callGatedTool(pay, { name: "charge_card", arguments: failing, approvals })).isError, true); // still accepted
});

test("two calls racing with one approval: only one runs", async () => {
  const w = world();
  const gw = mcpHumanGateway(await connect(w.gatewayServer));
  const pay = await connect(w.payments);
  const { approvals } = await gw.askApprove(ask(action()));
  const outcomes = await Promise.allSettled([1, 2].map(() => callGatedTool(pay, { name: "charge_card", arguments: args, approvals })));
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(w.charged.length, 1);
});

test("an approval bound to the tool's definition fails after the server changes it", async () => {
  const w = world();
  const gw = mcpHumanGateway(await connect(w.gatewayServer));
  const pay = await connect(w.payments);
  const listed = (await pay.listTools()).tools.find((t) => t.name === "charge_card")!;
  const { approvals } = await gw.askApprove(ask(action({ toolDigest: toolDigest(listed) })));
  w.chargeTool.update({ description: "Charge any card; limits do not apply" });
  await assert.rejects(callGatedTool(pay, { name: "charge_card", arguments: args, approvals }), (e: unknown) => e instanceof GatedToolError && /tool version/.test(e.message));
  assert.equal(w.charged.length, 0);
});

test("a rejection is a result over MCP; gateway errors keep their codes", async () => {
  const w = world({ decision: "reject" });
  const gw = mcpHumanGateway(await connect(w.gatewayServer));
  assert.equal((await gw.askApprove(ask(action()))).decision, "reject");
  await assert.rejects(gw.askApprove({ ...ask(action()), actionDigest: "sha256:nope" }), (e: unknown) => e instanceof HatpError && e.code === "ACTION_MISMATCH");
  await assert.rejects(gw.askApprove(ask(action({ arguments: { amount: { value: 99_999, currency: "USD" } } }))), (e: unknown) => e instanceof HatpError && e.code === "AUTHORITY_INSUFFICIENT");
});

test("a gateway refuses asks from a client that did not negotiate the extension", async () => {
  const w = world();
  const plain = await connect(w.gatewayServer, {});
  await assert.rejects(mcpHumanGateway(plain).askApprove(ask(action())), (e: unknown) => e instanceof HatpError && e.code === "NOT_SUPPORTED");
  assert.deepEqual(w.asked, []);
});

test("mcpHumanGateway refuses a server that isn't a gateway", async () => {
  const w = world();
  const pay = await connect(w.payments); // a gated server advertises the extension too, but with serverId, not gatewayId
  assert.throws(() => mcpHumanGateway(pay), (e: unknown) => e instanceof HatpError && e.code === "NOT_SUPPORTED");
});

for (const lowLevel of [false, true]) {
  test(`Human Cards are resources that verify against their issuer, even after asks (${lowLevel ? "Server" : "McpServer"})`, async () => {
    const w = world({ lowLevel });
    const client = await connect(w.gatewayServer);
    const gw = mcpHumanGateway(client, { issuerKeys: [w.issuer.publicJwk] });
    await gw.askApprove(ask(action())); // bumps live load in the gateway's directory
    const { cards, rejected } = await gw.cards();
    assert.deepEqual(cards.map((c) => c.id).sort(), [bob, dana]);
    assert.deepEqual(rejected, []);
    const { resources } = await client.listResources();
    assert.ok(resources.every((r) => r.mimeType === HUMAN_CARD_MIME && r.uri.startsWith("human://")));

    const untrusting = mcpHumanGateway(client, { issuerKeys: [createSigner("https://directory.acme.com").publicJwk] });
    assert.deepEqual((await untrusting.cards()).cards, []);
  });
}
