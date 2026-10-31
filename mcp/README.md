# hatp-mcp

MCP binding for **HATP**, the Human-Agent Transaction Protocol. It lets an existing MCP server take part in an all-or-nothing transaction, as a tool participant or as a Human Gateway, and lets a coordinator reach those servers over MCP.

It builds on [`hatp-protocol`](https://www.npmjs.com/package/hatp-protocol) and the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk). This is a draft protocol, and the API may change.

## How it fits

The coordinator is an MCP **client**. Each tool server, and each organisation's Human Gateway, is an MCP **server** that advertises `capabilities.experimental.hatp` and answers the `hatp/txn/*` methods next to its ordinary tools. A transaction then runs as two-phase commit over those sessions, with the human's approval as one of the votes:

<p align="center"><img src="https://raw.githubusercontent.com/probita-ai/hatp/main/docs/two-phase.svg" alt="Sequence diagram. Phase 1, prepare: the coordinator sends prepare to the airline (hold tier), payments (final tier) and the Human Gateway; the airline holds a seat, payments checks the card, and the approver approves through the gateway, which returns an approval signed over the plan digest. The coordinator logs COMMIT durably. Phase 2, commit: the card is charged first, then the seat hold becomes a ticket." width="800"></p>

| Method | Served by | Purpose |
|---|---|---|
| `hatp/txn/prepare`, `commit`, `abort` | every participant | Vote, then carry out or cancel |
| `hatp/txn/quote`, `renew`, `compensate` | tool servers (`participant` role) | Price without holding, keep a hold alive, undo |
| `hatp/txn/estimate`, `tighten` | Human Gateways (`human-gateway` role) | Worst-case decision time; shorten the human deadline to fit a hold |
| `hatp/directory/resolve` | Directories (`directory` role) | Rank the humans who can approve something |

See [`hatp-protocol`](https://www.npmjs.com/package/hatp-protocol) for tiers, prepare orders and what happens when the irreversible step doesn't answer.

## Install

```bash
npm install hatp-mcp hatp-protocol
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

A Human Gateway is served the same way, with `roles: ["human-gateway", "directory"]`. Pass its `Directory` so the server also answers `hatp/directory/resolve`:

```ts
serveHatp(server, gateway, { version: "0.1", roles: ["human-gateway", "directory"], keys: [signer.publicJwk] }, { directory });
```

Without a `directory`, resolve requests are answered as not supported. A server that is only a Directory passes `undefined` as the participant.

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

## Client: look up humans from a remote Directory

`mcpDirectory` lets an agent find who can approve something before it builds a plan:

```ts
import { mcpDirectory } from "hatp-mcp";

const directory = mcpDirectory("mcp://gateway.acme.com/hatp", gatewayClient);
const { candidates, quorum } = await directory.resolve({
  address: "human://acme.com/role/finance-approver?quorum=1-of-3",
  requirement: { action: "approve.spend", amount: { value: 2140, currency: "USD" } },
  exclude: ["human://acme.com/dana"],                  // the person the agent acts for
});
// candidates: [{ id: "human://acme.com/bob", score: 0.92, reasons: ["available", "authority-ok", "load 2/10"] }, …]
```

Results are advisory: the Human Gateway makes the final choice when it asks. The server's clock decides deadlines; the caller cannot supply one. Results go out as the Directory produces them, so a Directory that serves agents outside its organisation coarsens availability and load itself.

## Behavior

- **Errors:** HATP errors travel as JSON-RPC code `-32050` with `data.hatpCode`, and arrive as `HatpError` with the same code. A method the server doesn't serve arrives as `NOT_SUPPORTED`.
- **Keys:** the client adds the keys a server advertises to your keyring, so the coordinator can verify that server's receipts. Keys are self-asserted, so a server may only advertise key ids that start with its own participant URI and `#`. A server that advertises any other key is rejected, which stops it from replacing another participant's key. If you need stronger assurance, pin keys out of band.
- **Timeouts:** a Human Gateway answers `prepare` only when the human decides, so `prepare` waits until the plan deadline (plus `prepareGraceMs`, 30 s by default). Other requests use `requestTimeoutMs`, which defaults to the MCP SDK's 60 s.

## Learn more

- [Spec §9, MCP binding, and §4.4, directory resolution](https://github.com/probita-ai/hatp/blob/main/spec/hatp-v0.1.md)
- [Repository and the MCP demo](https://github.com/probita-ai/hatp): `npm run demo:mcp` runs the airline and hotel as separate MCP server processes.

## License

Apache-2.0
