# hatp-mcp

MCP binding for **HATP**, the Human-Agent Transaction Protocol. It lets an existing MCP server take part in an all-or-nothing transaction, as a tool participant or as a Human Gateway, and lets a coordinator reach those servers over MCP.

It builds on [`hatp-protocol`](https://www.npmjs.com/package/hatp-protocol) and the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk). This is a draft (v0.1), and the API may change.

## Install

```bash
npm install hatp-mcp@next hatp-protocol@next
```

Requires Node 23.6 or later.

## Server: make an MCP server a participant

`serveHatp` advertises `capabilities.experimental.hatp` and handles the `hatp/txn/*` methods by delegating to a `hatp-protocol` participant. Your existing tools are untouched and stay callable outside any transaction. Call it before connecting the server.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createResourceParticipant, createSigner } from "hatp-protocol";
import { serveHatp } from "hatp-mcp";

const id = "mcp://airline.example/hatp";
const signer = createSigner(id);                 // key id: "mcp://airline.example/hatp#key-1"
const airline = createResourceParticipant({ id, signer, maxHoldSeconds: 1800, operations: {
  book_seat: { tier: "hold", prepare: placeHold, commit: ticket, abort: releaseHold },
}});

const server = new McpServer({ name: "airline", version: "1.0.0" });
serveHatp(server, airline, {
  version: "0.1",
  roles: ["participant"],
  operations: { book_seat: { tier: "hold", maxLeaseSeconds: 1800, maxHoldSeconds: 1800 } },
  keys: [signer.publicJwk],
});
await server.connect(new StdioServerTransport());
```

A Human Gateway is served the same way, with `roles: ["human-gateway", "directory"]`.

## Client: coordinate MCP servers

`mcpParticipant` turns a connected MCP client into a participant for `createCoordinator`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { KeyRing, createCoordinator } from "hatp-protocol";
import { mcpParticipant } from "hatp-mcp";

const keyring = new KeyRing();
const client = new Client({ name: "coordinator", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["airline-server.js"] }));
const airline = mcpParticipant("mcp://airline.example/hatp", client, { keyring });

const coordinator = createCoordinator({ id, signer, participants: (id) => [airline /* … */].find((p) => p.id === id), keyring });
```

## Behavior

- **Errors:** HATP errors travel as JSON-RPC code `-32050` with `data.hatpCode`, and arrive as `HatpError` with the same code. A method the server doesn't serve arrives as `NOT_SUPPORTED`.
- **Keys:** the client adds the keys a server advertises to your keyring, so the coordinator can verify that server's receipts. Keys are self-asserted, so a server may only advertise key ids that start with its own participant URI and `#`. A server that advertises any other key is rejected, which stops it from replacing another participant's key. If you need stronger assurance, pin keys out of band.
- **Timeouts:** a Human Gateway answers `prepare` only when the human decides, so `prepare` waits until the plan deadline (plus `prepareGraceMs`, 30 s by default). Other requests use `requestTimeoutMs`, which defaults to the MCP SDK's 60 s.

## Learn more

- [Spec §9, MCP binding](https://github.com/probita-ai/hatp/blob/main/spec/hatp-v0.1.md)
- [Repository and the MCP demo](https://github.com/probita-ai/hatp): `npm run demo:mcp` runs the airline and hotel as separate MCP server processes.

## License

Apache-2.0
