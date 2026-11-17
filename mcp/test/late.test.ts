// Late decisions over MCP (hatp/ask/lateDecisions), and an ask whose signal is already aborted.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { actionDigest, createHumanGateway, createSigner, Directory, HatpError, signCard, signObject } from "hatp-protocol";
import type { Action, ActionAsk, AskApproveRequest, HumanChannel, LateDecision } from "hatp-protocol";
import { z } from "zod";
import { humanGatewayClientCapabilities, mcpHumanGateway, serveHumanGateway } from "../src/index.ts";
import type { AskHandler, LateFilter } from "../src/index.ts";

const role = "human://acme.com/role/finance-approver";
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const isCode = (code: string) => (e: unknown) => e instanceof HatpError && e.code === code;
const action: Action = { type: "mcp.tools/call", server: "https://payments.example", tool: "charge_card", arguments: { amount: { value: 120, currency: "USD" } } };
const ask = (o: Partial<AskApproveRequest> = {}): AskApproveRequest => ({ address: role, requirement: { action: "approve.spend", amountFrom: "/amount" }, action, actionDigest: actionDigest(action), decideBy: inMs(30_000), ...o });

async function world(o: { canReadLate?: (f: LateFilter) => boolean; handler?: (g: ReturnType<typeof createHumanGateway>) => AskHandler; tasks?: boolean } = {}) {
  const issuer = createSigner("https://directory.acme.com");
  const directory = new Directory([issuer.publicJwk]).add(signCard({
    id: "human://acme.com/bob", displayName: "bob", org: "acme.com", roles: ["finance-approver"],
    authority: [{ action: "approve.spend", maxAmount: { value: 10000, currency: "USD" } }],
    channels: ["web"], sla: { decideSeconds: 60 }, keys: [], issuer: issuer.id,
  }, issuer));
  const asks: ActionAsk[] = [];
  const channel: HumanChannel = {
    deliver: () => new Promise(() => {}),
    deliverAction: (a, _h, signal) => new Promise((_resolve, reject) => { asks.push(a); signal.addEventListener("abort", () => reject(new Error("withdrawn")), { once: true }); }),
  };
  const signer = createSigner("https://gateway.acme.com");
  const gateway = createHumanGateway({ id: signer.id, signer, directory, channel });
  const server = o.tasks
    ? new McpServer({ name: "gateway", version: "0.0.0" }, { taskStore: new InMemoryTaskStore(), capabilities: { tasks: { requests: {}, list: {}, cancel: {} } } })
    : new McpServer({ name: "gateway", version: "0.0.0" });
  serveHumanGateway(server, o.handler ? o.handler(gateway) : gateway, {
    extension: { gatewayId: signer.id, orgs: ["acme.com"], keys: [signer.publicJwk], assurance: ["gateway-attested"] },
    canReadLate: o.canReadLate && ((f) => o.canReadLate!(f)),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "agent", version: "0.0.0" }, { capabilities: humanGatewayClientCapabilities });
  await client.connect(clientSide);
  return { gateway, signer, asks, client, remote: mcpHumanGateway(client) };
}

test("a coordinator fetches a late approve over MCP, signed and marked not counted", async () => {
  const w = await world();
  await assert.rejects(w.remote.askApprove(ask({ decideBy: inMs(60) })), isCode("DEADLINE_EXCEEDED"));
  const recorded = w.gateway.recordLate(w.asks[0].askId, { decision: "approve", method: "slack-sso" });

  const { decisions, rejected } = await w.remote.lateDecisions({ actionDigest: actionDigest(action) });
  assert.equal(rejected, 0);
  assert.deepEqual(decisions, [recorded]);
  assert.equal(decisions[0].counted, false);
  assert.deepEqual(await w.remote.lateDecisions({ txnId: "txn_other" }), { decisions: [], rejected: 0 });
});

test("lateDecisions takes exactly one filter, and the gateway can refuse a reader", async () => {
  const w = await world({ canReadLate: (f) => !("txnId" in f) });
  const raw = (params: object) => w.client.request({ method: "hatp/ask/lateDecisions", params: { ...params } }, z.record(z.string(), z.unknown()));
  await assert.rejects(raw({}), /exactly one/);
  await assert.rejects(raw({ txnId: "t", actionDigest: "a" }), /exactly one/);
  await assert.rejects(w.remote.lateDecisions({ txnId: "t" }), isCode("INVALID_STATE"));
  assert.deepEqual(await w.remote.lateDecisions({ questionDigest: "q" }), { decisions: [], rejected: 0 });
});

test("the client drops late decisions that don't verify against the gateway's keys, or claim to count", async () => {
  const forger = createSigner("https://gateway.acme.com", "https://gateway.acme.com#key-1"); // same kid, other key
  const fake = (o: Partial<LateDecision>) => signObject<LateDecision>({
    type: "hatp.late-decision", askId: "a", subject: { kind: "action", actionDigest: "d", audience: "s" }, human: "human://acme.com/bob",
    decision: "approve", method: "web", withdrawnAt: inMs(0), withdrawnBecause: "deadline", receivedAt: inMs(0), counted: false, issuer: "https://gateway.acme.com", ...o,
  }, forger);
  const w = await world({ handler: (g) => ({ askApprove: g.askApprove, lateDecisions: () => [fake({}), { ...fake({}), counted: true as unknown as false }] }) });
  assert.deepEqual(await w.remote.lateDecisions({ actionDigest: "d" }), { decisions: [], rejected: 2 });
});

test("a gateway without late decisions answers NOT_SUPPORTED", async () => {
  const w = await world({ handler: (g) => ({ askApprove: g.askApprove }) });
  await assert.rejects(w.remote.lateDecisions({ txnId: "t" }), isCode("NOT_SUPPORTED"));
});

test("an ask through Tasks whose signal is already aborted is withdrawn before anyone is asked", async () => {
  const w = await world({ tasks: true });
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(w.remote.askApprove(ask({ decideBy: inMs(300) }), { signal: ctl.signal }), isCode("INVALID_STATE"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(w.asks, []);
});
