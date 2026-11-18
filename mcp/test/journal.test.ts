// The Journal over MCP (#59): journaled tools/call, hatp/journal/check, compensate with ifVersion or force, and
// hatp/journal/get. The Recorder is the SDK's; every server and client here talks real MCP over in-memory transports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHumanGateway, createRecorder, createSigner, Directory, HatpError, KeyRing, signCard, signObject, verifyRecord, verifyRunRecord } from "hatp-protocol";
import type { HumanChannel, JournalServer, Participant, Receipt } from "hatp-protocol";
import { z } from "zod";
import { hatpCapabilityOf, journalTools, mcpJournalServer, mcpParticipant, mcpRecorder, serveHatp, serveJournalRuns } from "../src/index.ts";

const dana = "human://acme.com/dana";
const agent = "agent://acme.com/sales-bot";
const isCode = (code: string) => (e: unknown) => e instanceof HatpError && e.code === code;
const raw = (client: Client, method: string, params: object) => client.request({ method, params: { ...params } }, z.record(z.string(), z.unknown()));

async function connect(server: McpServer) {
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "recorder", version: "0.0.0" });
  await client.connect(c);
  return client;
}

/** A CRM whose deals have versions, journaled; `clock` lets a test move time. */
function crmServer(o: { caller?: () => string | undefined; clock?: { t: number } } = {}) {
  const deals = new Map<string, { stage: string; version: number; history: string[] }>([["D-881", { stage: "Proposal", version: 12, history: [] }]]);
  const server = new McpServer({ name: "crm", version: "0.0.0" });
  server.registerTool("update_deal", { inputSchema: { deal: z.string(), stage: z.string() } }, async ({ deal, stage }) => {
    const d = deals.get(deal)!;
    if (stage === "Bogus") return { content: [{ type: "text", text: "no such stage" }], isError: true };
    d.history.push(d.stage); d.stage = stage; d.version++;
    return { content: [{ type: "text", text: `deal ${deal} is ${stage}` }] };
  });
  const signer = createSigner("mcp://crm.acme.com/hatp");
  journalTools(server, {
    signer, caller: o.caller, now: o.clock ? () => o.clock!.t : undefined,
    tools: {
      update_deal: {
        undo: { kind: "compensate", windowSeconds: 3600 },
        effect: (args) => {
          const d = deals.get(String(args.deal))!;
          return { summary: `Deal ${args.deal} stage: ${d.history.at(-1)} → ${d.stage}`, resource: `crm://acme/deal/${args.deal}`, version: `v${d.version}`, uses: [] };
        },
        currentVersion: (call) => `v${deals.get(String(call.arguments.deal))!.version}`,
        compensate: async (call) => {
          const d = deals.get(String(call.arguments.deal))!;
          d.stage = d.history.pop()!; d.version++;
          return { summary: `Deal ${call.arguments.deal} stage back to ${d.stage}`, version: `v${d.version}`, sideEffects: [] };
        },
      },
    },
  });
  return { server, signer, deals, edit: (deal: string, stage: string) => { const d = deals.get(deal)!; d.history.push(d.stage); d.stage = stage; d.version++; } };
}

function emailServer() {
  const server = new McpServer({ name: "email", version: "0.0.0" });
  const sent: unknown[] = [];
  server.registerTool("send_email", { inputSchema: { to: z.string() } }, async (args) => { sent.push(args); return { content: [{ type: "text", text: "sent" }] }; });
  const signer = createSigner("mcp://email.acme.com/hatp");
  journalTools(server, { signer, tools: { send_email: { undo: { kind: "none", reason: "Delivered to external recipients" }, effect: (a) => ({ summary: `Email to ${a.to}`, uses: [] }) } } });
  return { server, signer, sent };
}

function legacyServer() {
  const server = new McpServer({ name: "notes", version: "0.0.0" });
  server.registerTool("append_note", { inputSchema: { text: z.string() } }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  return { server };
}

async function world(o: Parameters<typeof crmServer>[0] = {}) {
  const crm = crmServer(o);
  const email = emailServer();
  const notes = legacyServer();
  const keyring = new KeyRing();
  const crmClient = await connect(crm.server);
  const servers = new Map<string, JournalServer>([
    ["mcp://crm.acme.com/hatp", mcpJournalServer("mcp://crm.acme.com/hatp", crmClient, { keyring })],
    ["mcp://email.acme.com/hatp", mcpJournalServer("mcp://email.acme.com/hatp", await connect(email.server), { keyring })],
    ["mcp://notes.example", mcpJournalServer("mcp://notes.example", await connect(notes.server), { keyring })],
  ]);

  // A local Human Gateway approves reversals; erin approves, since dana asks.
  const issuer = createSigner("https://directory.acme.com");
  const directory = new Directory([issuer.publicJwk]);
  for (const who of ["dana", "erin"]) directory.add(signCard({ id: `human://acme.com/${who}`, displayName: who, org: "acme.com", roles: ["team-lead"], authority: [{ action: "approve.undo" }], channels: ["web"], availability: { status: "available" }, sla: { decideSeconds: 60 }, keys: [], issuer: issuer.id }, issuer));
  const channel: HumanChannel = { deliver: (_a, _h, signal) => new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("withdrawn"))); setTimeout(() => resolve({ decision: "approve", method: "test" }), 2); }) };
  const gwSigner = createSigner("mcp://gateway.acme.com/hatp");
  const gateway = createHumanGateway({ id: gwSigner.id, signer: gwSigner, directory, channel });
  keyring.add(gwSigner.publicJwk);

  const signer = createSigner("mcp://recorder.acme.com/hatp");
  keyring.add(signer.publicJwk);
  const recorder = createRecorder({ id: signer.id, signer, servers: (id) => servers.get(id), keyring, reversal: { gateway, approver: "human://acme.com/role/team-lead", decideSeconds: 60 } });
  return { crm, email, notes, crmClient, servers, keyring, recorder, signer };
}

test("journaled calls over MCP: a journal server's word, a legacy server's unknown, all in one verified run", async () => {
  const w = await world();
  const crmView = w.servers.get("mcp://crm.acme.com/hatp")!;
  assert.deepEqual(crmView.undo, { update_deal: { kind: "compensate", windowSeconds: 3600 } }, "the capability carries each tool's undo");
  assert.equal(w.servers.get("mcp://notes.example")!.undo, undefined, "a plain MCP server has no journal role");
  assert.equal(hatpCapabilityOf(w.crmClient)?.version, "0.3");

  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  const e1 = (await w.recorder.call(runId, { participant: "mcp://crm.acme.com/hatp", tool: "update_deal", arguments: { deal: "D-881", stage: "Won" } })).entry;
  const e2 = (await w.recorder.call(runId, { participant: "mcp://email.acme.com/hatp", tool: "send_email", arguments: { to: "buyer@globex.com" } })).entry;
  const e3 = (await w.recorder.call(runId, { participant: "mcp://notes.example", tool: "append_note", arguments: { text: "closed" } })).entry;

  assert.equal(e1.undo?.kind, "compensate");
  assert.equal(e1.effect?.summary, "Deal D-881 stage: Proposal → Won");
  assert.equal(e1.effect?.version, "v13");
  assert.equal(e1.receipt?.issuer, "mcp://crm.acme.com/hatp");
  assert.equal(e1.intake, undefined, "the CRM's receipt verified with the key it advertised");
  assert.equal(e2.undo?.kind, "none");
  assert.equal(e3.undo?.kind, "unknown");
  assert.equal(e3.receipt?.issuer, w.recorder.id);

  const record = await w.recorder.closeRun(runId);
  assert.deepEqual(verifyRunRecord(record, { recorderKeys: [w.signer.publicJwk], keyring: w.keyring }), { ok: true, problems: [] });
});

test("reversal over MCP: check, then compensate with ifVersion; the participant's receipt says what it did", async () => {
  const w = await world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: "mcp://crm.acme.com/hatp", tool: "update_deal", arguments: { deal: "D-881", stage: "Won" } });
  const r = await w.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: dana, reason: "the customer has not signed" });
  if (r.state === "NOTHING_TO_REVERSE") assert.fail("expected a reversal");
  assert.equal(r.state, "COMMITTED");
  assert.equal(w.crm.deals.get("D-881")?.stage, "Proposal");
  assert.ok(r.record.receipts.some((x) => x.phase === "check" && x.issuer === "mcp://crm.acme.com/hatp"));
  const comp = r.record.receipts.find((x) => x.phase === "compensate")!;
  assert.deepEqual(comp.detail?.effect, { summary: "Deal D-881 stage back to Proposal", resource: "crm://acme/deal/D-881", versionBefore: "v13", version: "v14", sideEffects: [] });
  assert.deepEqual(verifyRecord(r.record, w.keyring), { ok: true, problems: [] });
});

test("the participant enforces the rules itself: version required, conflicts refused, windows closed, repeats idempotent", async () => {
  const clock = { t: Date.now() };
  const w = await world({ clock });
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  const { entry } = await w.recorder.call(runId, { participant: "mcp://crm.acme.com/hatp", tool: "update_deal", arguments: { deal: "D-881", stage: "Won" } });
  const base = { txnId: runId, branchId: entry.entryId, planDigest: "sha256:" + "A".repeat(43), compensationToken: entry.compensationToken! };
  const send = (p: object) => w.servers.get("mcp://crm.acme.com/hatp")!.compensate!({ ...base, ...p } as never);

  await assert.rejects(send({}), isCode("UNDO_VERSION_REQUIRED"));
  await assert.rejects(send({ ifVersion: "v13", force: true }), isCode("PLAN_INVALID"));

  // Someone edits the deal after the agent: check reports it, compensate refuses it, nothing changes.
  w.crm.edit("D-881", "Negotiation");
  const check = await w.servers.get("mcp://crm.acme.com/hatp")!.check!({ runId, entryId: "e1", compensationToken: base.compensationToken, ifVersion: "v13" });
  assert.equal(check.undoable, false);
  assert.equal(check.conflict?.currentVersion, "v14");
  await assert.rejects(send({ ifVersion: "v13" }), (e: unknown) => isCode("UNDO_CONFLICT")(e));
  assert.equal(w.crm.deals.get("D-881")?.stage, "Negotiation");
  const conflictErr = await raw(w.crmClient, "hatp/txn/compensate", { ...base, ifVersion: "v13" }).catch((e) => e);
  assert.equal(conflictErr.data?.currentVersion, "v14", "UNDO_CONFLICT carries the current version");

  // force overwrites, and says so in the receipt; a repeat gets the same receipt and changes nothing more.
  const first = await send({ force: true });
  assert.equal((first.receipt.detail?.effect as { versionBefore: string }).versionBefore, "v14");
  const again = await send({ force: true });
  assert.deepEqual(again.receipt, first.receipt);
  assert.equal(w.crm.deals.get("D-881")?.version, 15);

  // Past the window, nothing is undone.
  const { entry: late } = await w.recorder.call(runId, { participant: "mcp://crm.acme.com/hatp", tool: "update_deal", arguments: { deal: "D-881", stage: "Lost" } });
  clock.t += 3601_000;
  await assert.rejects(w.servers.get("mcp://crm.acme.com/hatp")!.compensate!({ ...base, branchId: late.entryId, compensationToken: late.compensationToken!, ifVersion: late.effect!.version }), isCode("UNDO_WINDOW_CLOSED"));
});

test("a compensation token works only for the caller that made the call", async () => {
  let who = "recorder-1";
  const w = await world({ caller: () => who });
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  const { entry } = await w.recorder.call(runId, { participant: "mcp://crm.acme.com/hatp", tool: "update_deal", arguments: { deal: "D-881", stage: "Won" } });
  who = "mallory";
  await assert.rejects(w.servers.get("mcp://crm.acme.com/hatp")!.compensate!({ txnId: runId, branchId: "e1", planDigest: "sha256:" + "A".repeat(43), compensationToken: entry.compensationToken!, ifVersion: "v13" }), isCode("TXN_UNKNOWN"));
  assert.equal(w.crm.deals.get("D-881")?.stage, "Won");
});

test("a tool that reports an error is journaled as irreversible, with the participant's receipt", async () => {
  const w = await world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  const { entry, result } = await w.recorder.call(runId, { participant: "mcp://crm.acme.com/hatp", tool: "update_deal", arguments: { deal: "D-881", stage: "Bogus" } });
  assert.equal((result as { isError?: boolean }).isError, true, "the agent still gets the tool's own error result");
  assert.equal(entry.undo?.kind, "none");
  assert.equal(entry.receipt?.outcome, "error");
  assert.equal(entry.compensationToken, undefined);
});

test("journal and transactions on one server: the capability merges, and transaction tokens still reach the participant", async () => {
  const server = new McpServer({ name: "crm", version: "0.0.0" });
  server.registerTool("update_deal", { inputSchema: { deal: z.string() } }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  const signer = createSigner("mcp://crm.acme.com/hatp");
  const compensated: string[] = [];
  const participant: Participant = {
    id: signer.id,
    prepare: async () => ({ vote: "yes" }) as never, commit: async () => ({}) as never, abort: async () => ({}) as never,
    compensate: async (req) => { compensated.push(req.branchId); return { receipt: signObject<Receipt>({ type: "hatp.receipt", txnId: req.txnId, branchId: req.branchId, planDigest: req.planDigest, phase: "compensate", outcome: "compensated", issuedAt: new Date().toISOString(), issuer: signer.id }, signer) }; },
  };
  serveHatp(server, participant, { version: "0.1", roles: ["participant"], operations: { update_deal: { tier: "compensate" } }, keys: [signer.publicJwk] });
  journalTools(server, { signer, tools: { update_deal: { undo: { kind: "compensate", windowSeconds: 60 }, effect: () => ({ summary: "updated", uses: [] }), compensate: async () => ({ summary: "undone" }) } } });
  const client = await connect(server);

  const cap = hatpCapabilityOf(client)!;
  assert.equal(cap.version, "0.3");
  assert.deepEqual(cap.roles, ["participant", "journal"]);
  assert.deepEqual(cap.operations?.update_deal, { tier: "compensate", undo: { kind: "compensate", windowSeconds: 60 } });
  assert.deepEqual(cap.keys.map((k) => k.kid), [signer.kid], "one key, not two copies");

  // A coordinator built for 0.3 still uses it for transactions, and a transaction's token reaches the participant.
  const p = mcpParticipant(signer.id, client);
  await p.compensate!({ txnId: "txn_1", branchId: "crm", planDigest: "sha256:" + "B".repeat(43), compensationToken: "tx-token" } as never);
  assert.deepEqual(compensated, ["crm"]);
});

test("hatp/journal/get serves Run Records to authorised readers, and nobody else can tell the run exists", async () => {
  const w = await world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: "mcp://notes.example", tool: "append_note", arguments: { text: "x" } });
  let allowed = true;
  const server = new McpServer({ name: "recorder", version: "0.0.0" });
  serveJournalRuns(server, w.recorder, { recorderId: w.recorder.id, keys: [w.signer.publicJwk], authorize: () => allowed });
  const remote = mcpRecorder(w.recorder.id, await connect(server));
  const record = await remote.get(runId);
  assert.deepEqual(verifyRunRecord(record, { recorderKeys: remote.keys, keyring: w.keyring }), { ok: true, problems: [] });
  allowed = false;
  await assert.rejects(remote.get(runId), isCode("RUN_UNKNOWN"));
  allowed = true;
  await assert.rejects(remote.get("run_nope"), isCode("RUN_UNKNOWN"));
});

test("journalTools refuses declarations it couldn't keep", () => {
  const server = new McpServer({ name: "x", version: "0.0.0" });
  server.registerTool("t", { inputSchema: {} }, async () => ({ content: [] }));
  const signer = createSigner("mcp://x.example");
  assert.throws(() => journalTools(server, { signer, tools: { t: { undo: { kind: "compensate" } as never, effect: () => ({ summary: "" }) } } }), /windowSeconds/);
  assert.throws(() => journalTools(server, { signer, tools: { t: { undo: { kind: "compensate", windowSeconds: 60 }, effect: () => ({ summary: "" }) } } }), /no compensate/);
  assert.throws(() => journalTools(server, { signer: createSigner("mcp://x.example", "mcp://other#k"), tools: {} }), /namespace/);
});
