import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  createCoordinator,
  createHumanGateway,
  createResourceParticipant,
  createSigner,
  Directory,
  HatpError,
  KeyRing,
  newTxnId,
  planDigest,
  signCard,
  verifyRecord,
} from "hatp-protocol";
import type { HumanChannel, Participant, Plan } from "hatp-protocol";
import { mcpParticipant, serveHatp } from "../src/index.ts";
import type { HatpCapability, McpParticipantOptions } from "../src/index.ts";

/** Serves `participant` from an MCP server and returns the coordinator's MCP-backed view of it. */
async function overMcp(id: string, participant: Participant, capability: HatpCapability, opts: McpParticipantOptions = {}, server: Server | McpServer = new Server({ name: id, version: "0.0.0" })) {
  serveHatp(server, participant, capability);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "coordinator", version: "0.0.0" });
  await client.connect(clientSide);
  return { remote: mcpParticipant(id, client, opts), client };
}

const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

function world(approveAfterMs = 1) {
  const effects: string[] = [];
  const issuer = createSigner("https://directory.acme.com");
  const directory = new Directory([issuer.publicJwk]).add(
    signCard(
      {
        id: "human://acme.com/bob", displayName: "Bob", org: "acme.com", roles: ["finance-approver"],
        authority: [{ action: "approve.spend", maxAmount: { value: 10000, currency: "USD" } }],
        channels: ["web"], sla: { decideSeconds: 60 }, keys: [], issuer: issuer.id,
      },
      issuer,
    ),
  );
  const channel: HumanChannel = {
    deliver: (_ask, _human, signal) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ decision: "approve", method: "test" }), approveAfterMs);
        signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("withdrawn")); }, { once: true });
      }),
  };
  const gatewaySigner = createSigner("mcp://gateway.acme.com/hatp");
  const gateway = createHumanGateway({ id: gatewaySigner.id, signer: gatewaySigner, directory, channel });

  const airlineSigner = createSigner("mcp://airline.example/hatp");
  const airline = createResourceParticipant({
    id: airlineSigner.id, signer: airlineSigner, maxHoldSeconds: 1800,
    operations: {
      book_seat: {
        tier: "hold",
        async prepare() { return { ok: true, holdRef: "HLD-1", amount: { value: 412, currency: "USD" } }; },
        async commit() { effects.push("airline:ticketed"); return {}; },
        async abort() { effects.push("airline:released"); },
      },
    },
  });
  const paymentsSigner = createSigner("mcp://payments.acme.com/hatp");
  const payments = createResourceParticipant({
    id: paymentsSigner.id, signer: paymentsSigner,
    operations: {
      charge_card: {
        tier: "final",
        async prepare() { return { ok: true }; },
        async commit() { effects.push("payments:charged"); return {}; },
      },
    },
  });

  const plan = (): Plan => ({
    hatp: "0.1", txnId: newTxnId(), initiator: "agent://acme.com/travel-bot", deadline: inMin(30),
    branches: [
      { branchId: "flight", participant: airline.id, tier: "hold", operation: { tool: "book_seat", arguments: { seat: "14C" } }, amount: { value: 412, currency: "USD" } },
      { branchId: "charge", participant: payments.id, tier: "final", operation: { tool: "charge_card", arguments: {} } },
    ],
    approvals: [{ groupId: "finance", address: "human://acme.com/role/finance-approver", quorum: { required: 1 }, requirement: { action: "approve.spend", amount: { value: 412, currency: "USD" } }, decideBy: inMin(15) }],
  });

  const caps = {
    airline: { version: "0.1", roles: ["participant"], operations: { book_seat: { tier: "hold", maxLeaseSeconds: 1800, maxHoldSeconds: 1800 } }, keys: [airlineSigner.publicJwk] } satisfies HatpCapability,
    payments: { version: "0.1", roles: ["participant"], operations: { charge_card: { tier: "final" } }, keys: [paymentsSigner.publicJwk] } satisfies HatpCapability,
    gateway: { version: "0.1", roles: ["human-gateway", "directory"], keys: [gatewaySigner.publicJwk] } satisfies HatpCapability,
  };
  return { airline, payments, gateway, caps, plan, effects };
}

test("a transaction commits when every participant is an MCP server", async () => {
  const w = world();
  const keyring = new KeyRing();
  const remotes = [
    (await overMcp(w.airline.id, w.airline, w.caps.airline, { keyring })).remote,
    (await overMcp(w.payments.id, w.payments, w.caps.payments, { keyring })).remote,
    (await overMcp(w.gateway.id, w.gateway, w.caps.gateway, { keyring })).remote,
  ];
  const signer = createSigner("agent://acme.com/coordinator");
  keyring.add(signer.publicJwk);
  const coordinator = createCoordinator({ id: signer.id, signer, participants: (id) => remotes.find((p) => p.id === id), gateways: { "acme.com": w.gateway.id }, keyring });

  const record = await coordinator.run(w.plan());
  assert.equal(record.state, "COMMITTED");
  assert.deepEqual(w.effects, ["payments:charged", "airline:ticketed"]);
  assert.equal(record.plan.prepareOrder, "parallel", "the mode was chosen with quote and estimate over MCP");
  assert.ok(verifyRecord(record, keyring).ok, "receipts verify against the keys the servers advertised");
});

test("HATP error codes survive the trip over MCP", async () => {
  const w = world();
  const { remote } = await overMcp(w.airline.id, w.airline, w.caps.airline);
  const plan = w.plan();
  await assert.rejects(
    remote.renew!({ txnId: plan.txnId, branchId: "flight", planDigest: planDigest(plan), leaseSeconds: 60 }),
    (e) => e instanceof HatpError && e.code === "TXN_UNKNOWN" && !/TXN_UNKNOWN: TXN_UNKNOWN|MCP error/.test(e.message),
  );
});

test("a method the server doesn't serve is NOT_SUPPORTED", async () => {
  const w = world();
  const bare: Participant = { id: w.airline.id, prepare: w.airline.prepare, commit: w.airline.commit, abort: w.airline.abort };
  const { remote } = await overMcp(w.airline.id, bare, w.caps.airline);
  const plan = w.plan();
  await assert.rejects(
    remote.quote!({ txnId: plan.txnId, branchId: "flight", planDigest: planDigest(plan), plan, leaseSeconds: 60 }),
    (e) => e instanceof HatpError && e.code === "NOT_SUPPORTED",
  );
});

test("works with the high-level McpServer, alongside its ordinary tools", async () => {
  const w = world();
  const server = new McpServer({ name: "airline", version: "0.0.0" });
  server.registerTool("flight_status", { description: "Status of a flight" }, async () => ({ content: [{ type: "text", text: "on time" }] }));
  const { remote, client } = await overMcp(w.airline.id, w.airline, w.caps.airline, {}, server);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name), ["flight_status"]);
  const plan = w.plan();
  const vote = await remote.prepare({ txnId: plan.txnId, branchId: "flight", planDigest: planDigest(plan), plan, leaseSeconds: 60 });
  assert.equal(vote.vote, "yes");
  assert.equal(vote.holdHorizon !== undefined, true);
});

test("a slow human doesn't hit the MCP request timeout", async () => {
  // Other requests time out after 100 ms; the approver takes 300 ms.
  const w = world(300);
  const opts = { requestTimeoutMs: 100 };
  const remotes = [
    (await overMcp(w.airline.id, w.airline, w.caps.airline, opts)).remote,
    (await overMcp(w.payments.id, w.payments, w.caps.payments, opts)).remote,
    (await overMcp(w.gateway.id, w.gateway, w.caps.gateway, opts)).remote,
  ];
  const signer = createSigner("agent://acme.com/coordinator");
  const coordinator = createCoordinator({ id: signer.id, signer, participants: (id) => remotes.find((p) => p.id === id), gateways: { "acme.com": w.gateway.id } });
  const record = await coordinator.run(w.plan());
  assert.equal(record.state, "COMMITTED");
});

test("rejects servers without the capability, and keys outside the server's namespace", async () => {
  const w = world();
  const server = new Server({ name: "plain", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "coordinator", version: "0.0.0" });
  await client.connect(c);
  assert.throws(() => mcpParticipant("mcp://plain.example/hatp", client), (e) => e instanceof HatpError && e.code === "NOT_SUPPORTED");

  // The airline tries to vouch for the payments server's key.
  const keyring = new KeyRing();
  const spoof = { ...w.caps.airline, keys: [...w.caps.airline.keys, ...w.caps.payments.keys] };
  await assert.rejects(overMcp(w.airline.id, w.airline, spoof, { keyring }), (e) => e instanceof HatpError && /outside its namespace/.test(e.message));
});
