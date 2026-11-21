// The Journal over real Streamable HTTP: the server builds an McpServer per session, as the MCP SDK requires,
// and a Recorder that reconnects must still be able to undo the calls it made in an earlier session.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRecorder, createSigner, KeyRing } from "hatp-protocol";
import { z } from "zod";
import { journalState, journalTools, mcpJournalServer } from "../src/index.ts";

const id = "mcp://crm.acme.com/hatp";

async function crmOverHttp(shared: boolean) {
  const signer = createSigner(id);
  const deals = new Map([["D-1", { stage: "Proposal", version: 1, history: [] as string[] }]]);
  const state = shared ? journalState() : undefined;
  const sessionServer = () => {
    const s = new McpServer({ name: "crm", version: "0" });
    s.registerTool("update_deal", { inputSchema: { deal: z.string(), stage: z.string() } }, async ({ deal, stage }) => {
      const d = deals.get(deal)!; d.history.push(d.stage); d.stage = stage; d.version++;
      return { content: [{ type: "text", text: "ok" }] };
    });
    journalTools(s, {
      signer, state,
      tools: { update_deal: {
        undo: { kind: "compensate", windowSeconds: 3600 },
        effect: (a) => ({ summary: `Deal ${a.deal} → ${deals.get(String(a.deal))!.stage}`, resource: `crm://deal/${a.deal}`, version: `v${deals.get(String(a.deal))!.version}`, uses: [] }),
        currentVersion: (c) => `v${deals.get(String(c.arguments.deal))!.version}`,
        compensate: async (c) => { const d = deals.get(String(c.arguments.deal))!; d.stage = d.history.pop()!; d.version++; return { summary: "restored", version: `v${d.version}` }; },
      } },
    });
    return s;
  };
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let t = sid ? transports.get(sid) : undefined;
    if (!t) {
      const fresh: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (x) => { transports.set(x, fresh); } });
      await sessionServer().connect(fresh);
      t = fresh;
    }
    await t.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
  const session = async () => {
    const client = new Client({ name: "recorder", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(url));
    return client;
  };
  return { deals, session, close: () => new Promise((r) => http.close(r)) };
}

for (const shared of [true, false]) {
  test(`a Recorder that reconnects ${shared ? "can" : "can't"} undo its earlier session's calls ${shared ? "with" : "without"} a shared journalState`, async () => {
    const crm = await crmOverHttp(shared);
    const keyring = new KeyRing();
    const rsigner = createSigner("mcp://recorder.acme.com/hatp");
    let client = await crm.session();
    let server = mcpJournalServer(id, client, { keyring });
    const recorder = createRecorder({ id: rsigner.id, signer: rsigner, keyring, servers: () => server, reversal: { approver: "human://acme.com/lead", selfApprove: true } });
    const runId = recorder.startRun({ agent: "agent://acme.com/bot", onBehalfOf: "human://acme.com/dana" });
    const { entry } = await recorder.call(runId, { participant: id, tool: "update_deal", arguments: { deal: "D-1", stage: "Won" } });
    assert.equal(entry.undo?.kind, "compensate");
    const first = (client.transport as StreamableHTTPClientTransport).sessionId;
    await client.close();

    client = await crm.session();
    server = mcpJournalServer(id, client, { keyring });
    assert.notEqual((client.transport as StreamableHTTPClientTransport).sessionId, first, "a new session");
    const r = await recorder.reverse(runId, { scope: { from: 1 }, requestedBy: "human://acme.com/dana" });
    if (shared) {
      assert.equal(r.state, "COMMITTED");
      assert.equal(crm.deals.get("D-1")?.stage, "Proposal");
    } else {
      assert.equal(r.state, "NOTHING_TO_REVERSE", "each session's McpServer only knows its own tokens");
      assert.equal(crm.deals.get("D-1")?.stage, "Won");
    }
    await client.close();
    await crm.close();
  });
}
