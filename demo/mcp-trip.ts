// The trip transaction with the airline and hotel as separate MCP server processes (spec §9).
// Payments and the Human Gateway stay in-process; the approver answers after a second.
// Run from the repo root: npm run demo:mcp
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCoordinator, createHumanGateway, createResourceParticipant, createSigner, Directory, KeyRing, newTxnId, signCard, verifyRecord } from "hatp-protocol";
import type { HumanChannel, Participant, Plan } from "hatp-protocol";
import { mcpParticipant } from "hatp-mcp";

const here = dirname(fileURLToPath(import.meta.url));
const c = { dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", reset: "\x1b[0m" };
const keyring = new KeyRing();
const signer = (id: string) => {
  const s = createSigner(id);
  keyring.add(s.publicJwk);
  return s;
};

// ---- MCP tool servers: spawn each one, connect, and learn its keys from its capability ----
const clients: Client[] = [];
async function connect(kind: string, id: string): Promise<Participant> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, "mcp", "tool-server.ts"), kind], stderr: "inherit" });
  const client = new Client({ name: "hatp-coordinator", version: "0.1.0" });
  await client.connect(transport);
  clients.push(client);
  const tools = await client.listTools();
  console.log(`${c.cyan}connected${c.reset}   ${id} (tools: ${tools.tools.map((t) => t.name).join(", ")})`);
  return mcpParticipant(id, client, { keyring });
}
const airline = await connect("airline", "mcp://airline.example/hatp");
const hotel = await connect("hotel", "mcp://hotels.example/hatp");

// ---- in-process: payments and the finance approver ----
const payments = createResourceParticipant({
  id: "mcp://payments.acme.com/hatp",
  signer: signer("mcp://payments.acme.com/hatp"),
  operations: { charge_card: { tier: "final", async prepare() { return { ok: true }; }, async commit() { return {}; } } },
});
const issuer = signer("https://directory.acme.com");
const directory = new Directory([issuer.publicJwk]).add(
  signCard(
    {
      id: "human://acme.com/bob", displayName: "Bob Chen", org: "acme.com", roles: ["finance-approver"],
      authority: [{ action: "approve.spend", maxAmount: { value: 10000, currency: "USD" } }],
      channels: ["web"], sla: { decideSeconds: 900 }, keys: [], issuer: issuer.id,
    },
    issuer,
  ),
);
const channel: HumanChannel = {
  deliver: (ask, human, signal) =>
    new Promise((resolve, reject) => {
      console.log(`${c.cyan}ask${c.reset}         ${human.displayName}: approve ${ask.summary.totals.map((t) => `${t.value} ${t.currency}`).join(", ")}?`);
      const t = setTimeout(() => resolve({ decision: "approve", method: "demo" }), 1000);
      signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("withdrawn")); }, { once: true });
    }),
};
const gateway = createHumanGateway({ id: "mcp://gateway.acme.com/hatp", signer: signer("mcp://gateway.acme.com/hatp"), directory, channel });

const all: Participant[] = [airline, hotel, payments, gateway];
const coordinator = createCoordinator({
  id: "agent://acme.com/coordinator",
  signer: signer("agent://acme.com/coordinator"),
  participants: (id) => all.find((p) => p.id === id),
  gateways: { "acme.com": gateway.id },
  keyring,
  onEvent: (e) => console.log(`${c.dim}event${c.reset}       ${e.type} ${c.dim}${JSON.stringify(e.data)}${c.reset}`),
});

const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const plan: Plan = {
  hatp: "0.1", txnId: newTxnId(), initiator: "agent://acme.com/travel-bot", onBehalfOf: "human://acme.com/dana",
  purpose: "Customer visit, Boston", deadline: inMin(30),
  branches: [
    { branchId: "flight", participant: airline.id, tier: "hold", operation: { tool: "book_seat", arguments: { flight: "UA 1520", seat: "14C" } }, amount: { value: 412, currency: "USD" } },
    { branchId: "hotel", participant: hotel.id, tier: "hold", operation: { tool: "reserve_room", arguments: { hotel: "HBOS-22", nights: 2 } }, amount: { value: 588, currency: "USD" } },
    { branchId: "charge", participant: payments.id, tier: "final", operation: { tool: "charge_card", arguments: { card: "corp-dana" } } },
  ],
  approvals: [{ groupId: "finance", address: "human://acme.com/role/finance-approver", quorum: { required: 1 }, requirement: { action: "approve.spend", amount: { value: 1000, currency: "USD" } }, decideBy: inMin(15) }],
};

const record = await coordinator.run(plan);
const verified = verifyRecord(record, keyring);
console.log(`\n${record.state === "COMMITTED" ? c.green : c.red}Transaction ${record.state}${c.reset} (prepareOrder: ${record.plan.prepareOrder})`);
console.log(`  record verified offline: ${verified.ok ? "yes" : `NO ${verified.problems.join("; ")}`}`);
await Promise.all(clients.map((cl) => cl.close()));
process.exitCode = record.state === "COMMITTED" && verified.ok ? 0 : 1;
