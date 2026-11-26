# hatp-mcp

MCP binding for **HATP**, the Human-Agent Transaction Protocol. It lets an existing MCP server take part in an all-or-nothing transaction, as a tool participant or as a Human Gateway, and lets a coordinator reach those servers over MCP.

It builds on [`hatp-protocol`](https://www.npmjs.com/package/hatp-protocol) and the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk). This is a draft protocol, and the API may change.

## How it fits

The coordinator is an MCP **client**. Each tool server, and each organisation's Human Gateway, is an MCP **server** that advertises the `ai.probita/human-gateway` extension with an `hatp` member and answers the `hatp/txn/*` methods next to its ordinary tools. A transaction then runs as two-phase commit over those sessions, with the human's approval as one of the votes:

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

Upgrading from 0.1? Upgrade Human Gateways first, and see [the upgrade notes](https://www.npmjs.com/package/hatp-protocol#upgrading-from-01).

Requires Node 23.6 or later.

## Server: make an MCP server a participant

`serveHatp` advertises `capabilities.extensions["ai.probita/human-gateway"].hatp` and handles the `hatp/txn/*` methods by delegating to a `hatp-protocol` participant. Your existing tools are untouched and stay callable outside any transaction. Call it before connecting the server.

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

## Approvals for single tool calls (Human Gateway extension)

The [Human Gateway SEP](https://github.com/probita-ai/hatp/blob/main/spec/sep/0000-human-gateway.md) gets a signed human approval for one `tools/call`, outside any transaction, and lets the server that runs the tool refuse it without one. It uses the extension `ai.probita/human-gateway`.

**Gateway:** answer `hatp/ask/approve` and serve Human Cards as `human://` resources:

```ts
import { serveHumanGateway } from "hatp-mcp";

serveHumanGateway(gatewayServer, gateway, {               // gateway: createHumanGateway with a channel that has deliverAction
  extension: { gatewayId: "https://gateway.acme.com", orgs: ["acme.com"], keys: [signer.publicJwk], assurance: ["gateway-attested", "human-signed"] },
  cards: directory,                                       // served as their issuer signed them
  principal: (extra) => extra.authInfo?.extra?.human as string | undefined, // who is asking: never their own approver
});
```

**Gated server:** register tools as usual, then gate the ones that need an approval:

```ts
import { gateTools } from "hatp-mcp";
import { createApprovalGate } from "hatp-protocol";

gateTools(payments, {
  gate: createApprovalGate({ serverId: "https://payments.example", trustedGateways: { "https://gateway.acme.com": gatewayKeys } }),
  extension: { serverId: "https://payments.example", trustedGateways: ["https://gateway.acme.com"] },
  tools: { charge_card: { requires: { address: "human://acme.com/role/finance-approver", requirement: { action: "approve.spend", amountFrom: "/amount" } } } },
});
```

**Agent:** read what a tool requires, ask, and call with the approvals:

```ts
import { callGatedTool, humanGatewayClientCapabilities, mcpHumanGateway, requiresOf } from "hatp-mcp";
import { actionDigest } from "hatp-protocol";

const gwClient = new Client({ name: "agent", version: "1.0.0" }, { capabilities: humanGatewayClientCapabilities });
const gw = mcpHumanGateway(gwClient, { issuerKeys });
const requires = requiresOf(tool);                        // from payments' tools/list
const action = { type: "mcp.tools/call", server: "https://payments.example", tool: "charge_card", arguments: args } as const;
const { decision, approvals } = await gw.askApprove({ address: requires.address, requirement: requires.requirement, action, actionDigest: actionDigest(action), decideBy });
if (decision === "approve") await callGatedTool(paymentsClient, { name: "charge_card", arguments: args, approvals });
```

- A gated tool called without valid approvals fails with JSON-RPC `-32050` (`APPROVAL_REQUIRED` or `APPROVAL_INVALID`), not a tool result, and doesn't run. `APPROVAL_REQUIRED` repeats the tool's `requires`.
- An approval is used up only when the tool runs and returns without `isError`, and two concurrent calls can't share one.
- Put `toolDigest(tool)` in the action to bind the approval to the tool's definition as `tools/list` returns it: a changed description or schema then fails the check.
- `gateTools` wraps the handlers `McpServer` installed. Call it after registering the tools.
- **Waiting with MCP Tasks:** build the gateway's server with a task store, and asks return a task at once instead of holding the request open. `mcpHumanGateway` uses tasks when the server advertises them. Pass `{ signal }` to any ask to withdraw it: the task or the request is cancelled, and the humans are no longer asked.

  ```ts
  import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";
  const gatewayServer = new McpServer(info, { taskStore: new InMemoryTaskStore(), capabilities: { tasks: { requests: {}, list: {}, cancel: {} } } });
  ```

### Questions: choose, form, free text

The same gateway asks questions that aren't approvals ([spec](https://github.com/probita-ai/hatp/blob/main/spec/hatp-asks.md)). Give the channel a `deliverQuestion`, and ask with `askQuestion`:

```ts
import { questionDigest, verifyAnswer } from "hatp-protocol";

const question = { kind: "choose", prompt: "Which flight?", options: [{ id: "ua1520", label: "UA 1520, 08:10" }, { id: "dl404", label: "DL 404, 11:45" }] } as const;
const { status, answers } = await gw.askQuestion({ address: "human://acme.com/role/travel-coordinator", question, questionDigest: questionDigest(question), decideBy, audience: "agent://acme.com/travel-bot" });
verifyAnswer(answers[0], { gatewayKeys: gw.extension.keys, question, audience: "agent://acme.com/travel-bot" }); // undefined: it holds
```

A human may decline, which passes the question to the next eligible person. `status` is `declined` only when everyone eligible declined or missed their SLA. Answers are checked against the question before the gateway signs them.

### Late decisions

A human may click after their ask was withdrawn (spec/hatp-asks.md §8.1). The gateway records it as a signed `hatp.late-decision` with `counted: false`, and serves it through `hatp/ask/lateDecisions` for one transaction, tool call or question:

```ts
const { decisions, rejected } = await gw.lateDecisions({ txnId: record.plan.txnId });
```

The client keeps only records that verify against the keys the gateway advertised, and counts the rest in `rejected`. They are evidence of an attempt, never approvals. On the server, `canReadLate(filter, extra)` decides who may read them: late decisions name the humans who acted, as a prepare receipt's routing does.

Since 0.3.1 the gateway also pushes each late decision, as it is recorded, to the session whose ask it was (`notifications/hatp/lateDecision`), so the requester doesn't have to know to look. Pass `onLateDecision` to receive them: to `mcpHumanGateway` for tool-call approvals and questions, or to `mcpParticipant` for a gateway's votes on your transactions. Each record is checked against the gateway's keys first. Late rejections arrive too.

```ts
const gw = mcpHumanGateway(client, { onLateDecision: (r) => log.warn(`${r.human} said ${r.decision} after the ask closed (${r.withdrawnBecause})`) });
```

Nothing changes because of one: the vote or result stands. Asking again is a new ask with a fresh plan, and yours to decide. Don't re-ask on a late approve by itself, or an agent could keep asking until someone clicks yes. A session that has closed gets no push; `lateDecisions` still has the records.

## The Journal: undo for direct tool calls (v0.3)

The Journal ([spec](https://github.com/probita-ai/hatp/blob/main/spec/hatp-journal.md)) records an agent's direct tool calls with what each changed and how to take it back. A Recorder from `hatp-protocol` sits between the agent and its tool servers. This binding connects the two over MCP.

**Tool server.** After registering its tools, declare how each can be undone:

```ts
import { journalTools } from "hatp-mcp";

journalTools(server, {
  signer, // its kid starts with the server's participant URI and "#"
  tools: {
    update_deal: {
      undo: { kind: "compensate", windowSeconds: 7 * 86400 },
      effect: (args) => ({ summary: `Deal ${args.deal} → ${args.stage}`, resource: `crm://acme/deal/${args.deal}`, version: currentVersionOf(args.deal), uses: [] }),
      currentVersion: (call) => currentVersionOf(call.arguments.deal),
      compensate: async (call) => ({ summary: `Deal ${call.arguments.deal} restored`, version: restore(call) }),
    },
    send_email: { undo: { kind: "none", reason: "Delivered to external recipients" }, effect: (args) => ({ summary: `Email to ${args.to}`, uses: [] }) },
  },
});
```

- A journaled call returns, in the result's `_meta["hatp/journal"]`, what it changed, a compensation token for a `compensate` tool, and a signed receipt. A tool result with `isError` is recorded as irreversible.
- `hatp/journal/check` reports whether a reversal would succeed now. `hatp/txn/compensate` with one of these tokens refuses any request that carries neither `ifVersion` nor `force` (`UNDO_VERSION_REQUIRED`). It also refuses a resource that changed since the call (`UNDO_CONFLICT`, with `data.currentVersion`) and a closed window (`UNDO_WINDOW_CLOSED`). A repeated request gets the same receipt.
- A repeat of the same entry (`runId`, `entryId`), which a Recorder sends when a call got no answer, gets the same result and never runs the tool twice, even while the first attempt still runs. It is answered before a gate (`gateTools`) sees it, in whichever order you installed the two, since the gate would refuse the approval the first attempt used. A repeat with other arguments, or from another caller, is refused with `PLAN_INVALID`. A compensation retried while the first attempt still runs waits for it, so nothing is reversed twice.
- A journaled tool runs to completion once started: the cancellation a client sends when its request times out doesn't reach it. If the tool ran but `effect()` throws, the call is answered as irreversible, with a summary saying so, and is never run again.
- Tokens are bound to the caller that made the call: `caller(extra)`, by default the authenticated client id (`authInfo.clientId`). Without one, the token alone counts. Don't bind to the MCP session id: a Recorder reconnects with a new one long before an undo window closes.
- **One `journalState()` per participant.** An HTTP server builds an McpServer per session, and each `journalTools` call keeps its own tokens unless you share them. Without sharing, a Recorder that reconnects can't undo the calls from its earlier session:

  ```ts
  const state = journalState(); // once per process
  function sessionServer() {
    const server = new McpServer({ name: "crm", version: "1.0.0" });
    // register tools …
    journalTools(server, { signer, state, tools });
    return server;
  }
  ```
- **Surviving restarts.** Without a store, tokens and repeats live in memory: a tool server that restarts can no longer undo calls from before the restart, and would run a call again if a Recorder repeated it. Give the state a store, and recover it at startup:

  ```ts
  import { JournalFileStore, journalState, readJournalStore } from "hatp-mcp";

  const path = "/var/lib/crm/journal.jsonl";
  const state = journalState({ store: new JournalFileStore(path), recover: readJournalStore(path) });
  ```

  Each call is stored before the tool runs, and its answer before the answer leaves. After a restart, a repeat gets the stored answer and the tool doesn't run again, and earlier calls can still be checked and undone. A call or undo that was running when the server stopped has no stored answer, so it is refused with `OUTCOME_UNKNOWN` rather than run again, and the Recorder records it as in doubt. If the store can't write, the call is refused before it runs, or, if the tool already ran, answered as irreversible: an undo that a restart would lose isn't offered. Recovery drops calls whose undo window has closed, and `none` calls after 24 hours, and rewrites the file without them. `JournalStore` is a two-method interface (`append`, and optionally `rewrite`), if you keep state in a database. A server running as several replicas needs one shared store; a file on each machine is not enough. The file holds compensation tokens and each call's result: keep it as private as the data the tools touch. Tokens are bound to their caller, so a copy alone undoes nothing.
- If the server also takes part in transactions, call `journalTools` after `serveHatp`: the capability is merged and becomes version 0.3, and compensation tokens from transactions still reach the participant.

**Recorder.** `mcpJournalServer(id, client, { keyring, requestTimeoutMs })` turns any MCP client session into a server the Recorder can journal through. A server without the journal is still journaled, as `unknown`. An HATP error as the server's first answer means it refused the call, and the Recorder records it as `not-run`. A timeout or a lost connection means no answer: the Recorder retries a journal server and records the call `in-doubt` if it still gets no result (a refusal after an unanswered attempt proves nothing), and it never retries any other server (J§5.4).

```ts
import { createRecorder } from "hatp-protocol";
import { mcpJournalServer } from "hatp-mcp";

const servers = new Map([["mcp://crm.acme.com/hatp", mcpJournalServer("mcp://crm.acme.com/hatp", crmClient, { keyring })]]);
const recorder = createRecorder({ id, signer, keyring, servers: (id) => servers.get(id) });
```

**Run Records.** `serveJournalRuns(server, recorder, { recorderId, keys, authorize })` serves `hatp/journal/get`. A reader who isn't authorised gets `RUN_UNKNOWN`, the same answer as for a run that doesn't exist. `mcpRecorder(id, client).get(runId)` reads a record, and `verifyRunRecord` checks it against the keys the Recorder advertised.

## Behavior

- **Capabilities:** the HATP capability now lives in an `hatp` member of `capabilities.extensions["ai.probita/human-gateway"]`, next to the gateway and gated-server settings. For now `serveHatp` also advertises it at the old `capabilities.experimental.hatp`, so clients built with hatp-mcp 0.2.0 still work, and clients read either location (`hatpCapabilityOf(client)`). The old location will be dropped in a later minor release.
- **Errors:** HATP errors travel as JSON-RPC code `-32050` with `data.hatpCode` (and `data.code`, for the SEP), and arrive as `HatpError` with the same code. A method the server doesn't serve arrives as `NOT_SUPPORTED`.
- **Keys:** the client adds the keys a server advertises to your keyring, so the coordinator can verify that server's receipts. Keys are self-asserted, so a server may only advertise key ids that start with its own participant URI and `#`. A server that advertises any other key is rejected, which stops it from replacing another participant's key. If you need stronger assurance, pin keys out of band.
- **Timeouts:** a Human Gateway answers `prepare` only when the human decides, so `prepare` waits until the plan deadline (plus `prepareGraceMs`, 30 s by default). Other requests use `requestTimeoutMs`, which defaults to the MCP SDK's 60 s.

## Learn more

- [Spec §9, MCP binding, and §4.4, directory resolution](https://github.com/probita-ai/hatp/blob/main/spec/hatp-v0.1.md)
- [Repository and the MCP demo](https://github.com/probita-ai/hatp): `npm run demo:mcp` runs the airline and hotel as separate MCP server processes, and `npm run demo:gated` shows a gated `charge_card` blocked, approved, and refused on replay or changed arguments.

## License

Apache-2.0
