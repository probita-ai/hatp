# hatp-protocol

Reference SDK for **HATP**, the Human-Agent Transaction Protocol. It lets an AI agent run several tool calls as one all-or-nothing transaction, with a human approval as a signed vote over the exact plan.

- **Coordinator:** runs two-phase commit across tool servers and humans, and emits a signed, hash-chained Transaction Record.
- **Resource participants:** wrap a tool as `hold`, `compensate` or `final` tier.
- **Human Gateway and Directory:** route approvals by role, authority and SLA, escalate to delegates, and fit the human's deadline inside how long holds last.

This is a draft (v0.1). The spec and the API may change. Participants are called in-process; the JSON-RPC / MCP transport is specified but not yet implemented.

## Install

```bash
npm install hatp-protocol
```

Requires Node 23.6 or later. There are no runtime dependencies.

## Example

One seat hold and one finance approver:

```ts
import { createCoordinator, createHumanGateway, createResourceParticipant, createSigner, Directory, KeyRing, newTxnId, signCard, verifyRecord } from "hatp-protocol";
import type { HumanChannel, Plan } from "hatp-protocol";

const keyring = new KeyRing();
const signer = (id: string) => { const s = createSigner(id); keyring.add(s.publicJwk); return s; };

// A directory of signed Human Cards
const issuer = signer("https://directory.acme.com");
const directory = new Directory([issuer.publicJwk]).add(signCard({
  id: "human://acme.com/bob", displayName: "Bob", org: "acme.com", roles: ["finance-approver"],
  authority: [{ action: "approve.spend", maxAmount: { value: 10000, currency: "USD" } }],
  channels: ["web"], keys: [], issuer: issuer.id,
}, issuer));

// Deliver asks over Slack, SMS, a web page… This one approves immediately.
const channel: HumanChannel = { deliver: async () => ({ decision: "approve", method: "demo" }) };
const gateway = createHumanGateway({ id: "mcp://gateway.acme.com/hatp", signer: signer("mcp://gateway.acme.com/hatp"), directory, channel });

const airline = createResourceParticipant({
  id: "mcp://airline.example/hatp", signer: signer("mcp://airline.example/hatp"), maxHoldSeconds: 1800,
  operations: { book_seat: {
    tier: "hold",
    async prepare() { return { ok: true, holdRef: "HLD-1", amount: { value: 412, currency: "USD" } }; },
    async commit() { return {}; },   // turn the hold into a ticket
    async abort() {},                // release the hold
  } },
});

const coordinator = createCoordinator({
  id: "agent://acme.com/coordinator", signer: signer("agent://acme.com/coordinator"),
  participants: (id) => [airline, gateway].find((p) => p.id === id), gateways: { "acme.com": gateway.id }, keyring,
});

const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const plan: Plan = {
  hatp: "0.1", txnId: newTxnId(), initiator: "agent://acme.com/travel-bot", deadline: inMin(30),
  branches: [{ branchId: "flight", participant: airline.id, tier: "hold", operation: { tool: "book_seat", arguments: { seat: "14C" } }, amount: { value: 412, currency: "USD" } }],
  approvals: [{ groupId: "finance", address: "human://acme.com/role/finance-approver", quorum: { required: 1 }, requirement: { action: "approve.spend", amount: { value: 412, currency: "USD" } }, decideBy: inMin(15) }],
};

const record = await coordinator.run(plan);       // COMMITTED | ABORTED | NEEDS_ATTENTION
console.log(record.state, verifyRecord(record, keyring).ok);
```

## Learn more

- [Spec v0.1](https://github.com/probita-ai/hatp/blob/main/spec/hatp-v0.1.md)
- [Repository, diagrams and the trip-booking demo](https://github.com/probita-ai/hatp)

## License

Apache-2.0
