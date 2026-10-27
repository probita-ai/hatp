// A tool server that is also an HATP participant, over stdio MCP.
// Usage: node demo/mcp/tool-server.ts airline|hotel
// stdout carries the protocol, so everything human-readable goes to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createResourceParticipant, createSigner } from "hatp-protocol";
import type { OperationHandler } from "hatp-protocol";
import { serveHatp } from "hatp-mcp";

const kind = process.argv[2];
const log = (msg: string) => process.stderr.write(`\x1b[2m[${kind}] ${msg}\x1b[0m\n`);

const servers: Record<string, { id: string; tool: string; maxHoldSeconds: number; handler: OperationHandler }> = {
  airline: {
    id: "mcp://airline.example/hatp",
    tool: "book_seat",
    maxHoldSeconds: 1800,
    handler: {
      tier: "hold",
      async prepare(args) { log(`hold seat ${args.seat}`); return { ok: true, holdRef: "HLD-77812", amount: { value: 412, currency: "USD" } }; },
      async commit(args) { log(`ticketed seat ${args.seat}`); return { detail: { ticket: "TKT-0042" } }; },
      async abort() { log("hold released"); },
    },
  },
  hotel: {
    id: "mcp://hotels.example/hatp",
    tool: "reserve_room",
    maxHoldSeconds: 3600,
    handler: {
      tier: "hold",
      async prepare(args) { log(`hold room at ${args.hotel}`); return { ok: true, holdRef: "ROOM-9", amount: { value: 588, currency: "USD" } }; },
      async commit() { log("room booked"); return {}; },
      async abort() { log("room released"); },
    },
  },
};
const cfg = servers[kind];
if (!cfg) throw new Error(`unknown server ${kind}; use airline or hotel`);

const signer = createSigner(cfg.id);
const participant = createResourceParticipant({ id: cfg.id, signer, maxHoldSeconds: cfg.maxHoldSeconds, operations: { [cfg.tool]: cfg.handler } });

const server = new McpServer({ name: kind, version: "0.1.0" });
// An ordinary tool, callable outside any transaction.
server.registerTool("status", { description: `Is the ${kind} system up?` }, async () => ({ content: [{ type: "text", text: "ok" }] }));
serveHatp(server, participant, {
  version: "0.1",
  roles: ["participant"],
  operations: { [cfg.tool]: { tier: "hold", maxLeaseSeconds: 1800, maxHoldSeconds: cfg.maxHoldSeconds } },
  keys: [signer.publicJwk],
});
await server.connect(new StdioServerTransport());
log(`ready as ${cfg.id}`);
