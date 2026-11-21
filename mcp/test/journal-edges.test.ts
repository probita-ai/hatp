// Edge cases of journaled calls over MCP (J§5.4): gated tools, retries after a timeout, effects that can't be
// described, and cancellation. Each one has a real MCP server, a Recorder, and a tool that counts its runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createApprovalGate, createHumanGateway, createRecorder, createSigner, Directory, KeyRing, signCard } from "hatp-protocol";
import type { HumanChannel, JournalServer } from "hatp-protocol";
import { z } from "zod";
import { gateTools, journalTools, mcpJournalServer } from "../src/index.ts";

const id = "mcp://pay.acme.com/hatp";
async function connect(server: McpServer) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "rec", version: "0" });
  await client.connect(a);
  return client;
}

function gatewayWorld() {
  const issuer = createSigner("https://directory.acme.com");
  const directory = new Directory([issuer.publicJwk]).add(signCard({ id: "human://acme.com/alice", displayName: "alice", org: "acme.com", roles: ["lead"], authority: [{ action: "approve.agent-call", maxAmount: { value: 10000, currency: "USD" } }], channels: ["web"], sla: { decideSeconds: 60 }, keys: [], issuer: issuer.id }, issuer));
  const channel: HumanChannel = { deliver: () => new Promise(() => {}), deliverAction: () => new Promise((r) => setTimeout(() => r({ decision: "approve", method: "t" }), 1)) };
  const signer = createSigner("https://gateway.acme.com");
  return { gateway: createHumanGateway({ id: signer.id, signer, directory, channel }), directory, signer };
}

async function server(o: { order: "gate-outer" | "journal-outer" | "journal-only"; slowMs?: number; effectThrows?: boolean; honorAbort?: boolean; g: ReturnType<typeof gatewayWorld> }) {
  const s = new McpServer({ name: "pay", version: "0" });
  const runs = { n: 0 };
  s.registerTool("charge", { inputSchema: { amount: z.object({ value: z.number(), currency: z.string() }) } }, async (_a, extra) => {
    runs.n++;
    if (o.slowMs) await new Promise<void>((res, rej) => { const t = setTimeout(res, o.slowMs); if (o.honorAbort) extra.signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }); });
    return { content: [{ type: "text", text: "charged" }] };
  });
  const gate = () => gateTools(s, { gate: createApprovalGate({ serverId: id, trustedGateways: { [o.g.signer.id]: [o.g.signer.publicJwk] }, cards: o.g.directory }), extension: { serverId: id, trustedGateways: [o.g.signer.id] }, tools: { charge: { requires: { address: "human://acme.com/role/lead", requirement: { action: "approve.agent-call", amountFrom: "/amount" } } } } });
  const journal = () => journalTools(s, { signer: createSigner(id), tools: { charge: { undo: { kind: "compensate", windowSeconds: 3600 }, amountFrom: "/amount", effect: () => { if (o.effectThrows) throw new Error("effect blew up"); return { summary: "charged", resource: "pay://c/1", version: "v1", uses: [] }; }, currentVersion: () => "v1", compensate: async () => ({ summary: "refunded" }) } } });
  if (o.order === "gate-outer") { journal(); gate(); }
  else if (o.order === "journal-outer") { gate(); journal(); }
  else journal();
  return { s, runs };
}

async function recorderFor(srv: McpServer, g: ReturnType<typeof gatewayWorld>, timeoutMs?: number, ask = true) {
  const keyring = new KeyRing();
  const js = mcpJournalServer(id, await connect(srv), { keyring, requestTimeoutMs: timeoutMs });
  const signer = createSigner("mcp://rec.acme.com/hatp");
  const recorder = createRecorder({
    id: signer.id, signer, servers: () => js as JournalServer, keyring, inDoubt: { retries: 2, retryMs: 1 },
    autonomy: ask ? { policy: { compensate: "ask", unknown: "allow", none: "allow", compensateViaUi: "allow", approver: "human://acme.com/role/lead" }, gateway: g.gateway } : undefined,
  });
  return recorder;
}

const summarize = (e: { outcome?: string; reason?: string; undo?: { kind: string } } | undefined) => e && { outcome: e.outcome ?? "done", undo: e.undo?.kind, reason: e.reason?.slice(0, 140) };
async function one(recorder: Awaited<ReturnType<typeof recorderFor>>, args: Record<string, unknown> = { amount: { value: 10, currency: "USD" } }, tool = "charge") {
  const runId = recorder.startRun({ agent: "agent://acme.com/bot", onBehalfOf: "human://acme.com/dana" });
  const r = await recorder.call(runId, { participant: id, tool, arguments: args }).then((x) => x.entry, (e) => e.entry ?? { reason: "NO ENTRY: " + String(e) });
  return summarize(r);
}

for (const order of ["gate-outer", "journal-outer"] as const) {
  test(`a gated, journaled tool that times out is retried and runs once, whichever wrapper is outermost (${order})`, async () => {
    const g = gatewayWorld();
    const { s, runs } = await server({ order, slowMs: 60, g });
    const e = await one(await recorderFor(s, g, 40));
    assert.equal(runs.n, 1, "charged once");
    assert.deepEqual({ outcome: e?.outcome, undo: e?.undo }, { outcome: "done", undo: "compensate" }, "the repeat got the first attempt's answer, not a refusal of its used approval");
  });
}

test("bad arguments and unknown tools are answers: the tool never runs, and nothing is in doubt", async () => {
  const g = gatewayWorld();
  const { s, runs } = await server({ order: "journal-only", g });
  const r = await recorderFor(s, g, undefined, false);
  assert.deepEqual(await one(r, { amount: "lots" }), { outcome: "done", undo: "none", reason: undefined });
  assert.deepEqual(await one(r, {}, "nope"), { outcome: "done", undo: "unknown", reason: undefined });
  assert.equal(runs.n, 0);
});

test("a tool that ran but whose effect can't be described is irreversible, and a retry never runs it again", async () => {
  const g = gatewayWorld();
  const { s, runs } = await server({ order: "journal-only", effectThrows: true, slowMs: 60, g });
  const r = await recorderFor(s, g, 40, false);
  const runId = r.startRun({ agent: "agent://acme.com/bot", onBehalfOf: "human://acme.com/dana" });
  const { entry } = await r.call(runId, { participant: id, tool: "charge", arguments: { amount: { value: 10, currency: "USD" } } });
  assert.equal(runs.n, 1);
  assert.equal(entry.undo?.kind, "none");
  assert.match(entry.effect?.summary ?? "", /charge ran, but its effect could not be described: effect blew up/);
});

test("a client timeout doesn't cancel a journaled tool: it runs to completion, and the retry gets its result", async () => {
  const g = gatewayWorld();
  const { s, runs } = await server({ order: "journal-only", slowMs: 60, honorAbort: true, g });
  const e = await one(await recorderFor(s, g, 40, false));
  assert.equal(runs.n, 1);
  assert.deepEqual({ outcome: e?.outcome, undo: e?.undo }, { outcome: "done", undo: "compensate" });
});
