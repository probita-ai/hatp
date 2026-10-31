# hatp-protocol

Reference SDK for **HATP**, the Human-Agent Transaction Protocol. It lets an AI agent run several tool calls as **one all-or-nothing transaction**, with a **human approval as a signed vote** over the exact plan.

> "Book the flight and hotel, add the calendar entry, charge the card — but only if a finance approver agrees within 15 minutes. Otherwise, nothing happens."

- **Coordinator:** runs two-phase commit across tool servers and humans, and emits a signed, hash-chained Transaction Record anyone can verify offline.
- **Resource participants:** wrap a tool as `hold`, `compensate` or `final` tier, depending on what it can guarantee.
- **Human Gateway and Directory:** route approvals by role, authority and SLA, escalate to delegates, and fit the human's deadline inside how long holds last.

To run participants and Human Gateways as MCP servers, add [`hatp-mcp`](https://www.npmjs.com/package/hatp-mcp). This is a draft protocol: the spec and the API may change.

## Install

```bash
npm install hatp-protocol
```

Requires Node 23.6 or later. There are no runtime dependencies.

## How it works

The human is one more participant in a two-phase commit. In phase 1 every tool server gets ready without doing anything lasting, and the approver signs a digest of the exact plan. Phase 2 starts only after every participant votes yes and the coordinator has durably logged the decision. A single "no" from anyone, the human included, releases everything.

<p align="center"><img src="https://raw.githubusercontent.com/probita-ai/hatp/main/docs/two-phase.svg" alt="Sequence diagram. Phase 1, prepare: the airline holds a seat, payments checks the card without charging it, and the Human Gateway asks the approver, who approves; the gateway returns an approval signed over the plan digest. The coordinator logs COMMIT durably. Phase 2, commit: the card is charged first, then the seat hold becomes a ticket." width="800"></p>

### Tiers: what each tool can promise

| Tier | Prepare | Commit | If the transaction aborts | Example |
|---|---|---|---|---|
| `hold` | Places a hold with a lease | Turns the hold into the effect; guaranteed while the lease runs | Hold released | Card authorization, a seat the airline guarantees to ticket |
| `compensate` | Validates only | Performs the effect, returns an undo token | Undone with `compensate` | Calendar event, CRM update |
| `final` | Validates only | Performs an irreversible effect | Never ran | Card capture, external email, a booking whose confirm can still fail |

Phase 2 runs `compensate` steps first, then the single `final` step, then the holds. The irreversible step runs while every hold is still guaranteed, so a failure anywhere before the holds leaves nothing behind except undone steps. A plan may contain **at most one** `final` step: with two, whichever ran second could fail after the first had taken effect. This is the "last resource commit" rule from XA transaction managers.

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

## Fitting the human into the hold window

A held seat or card authorization only lasts so long, and the human's decision time comes out of that window. Each hold reports its **horizon**, the latest it will be honored, renewals included. The plan's `prepareOrder` decides how the coordinator plans around it:

<p align="center"><img src="https://raw.githubusercontent.com/probita-ai/hatp/main/docs/prepare-order.svg" alt="Flowchart. If the plan doesn't set prepareOrder, the coordinator quotes each hold and estimates each approval group's worst case along its escalation chain, then picks parallel if the slowest group fits inside the shortest hold minus the reserve, otherwise approval-first. A prepareOrder set in the plan is used as is. Parallel holds and asks at the same time and tightens deadlines to each horizon; approval-first has the human approve quotes before holds are placed; holds-first places every hold first and signs each hold's end and a fitted deadline into the plan." width="800"></p>

| `prepareOrder` | When to use it | What the human signs |
|---|---|---|
| `parallel` | Holds last longer than the approver needs | The plan. Waiting deadlines are tightened to each hold's horizon as it reports it, and holds are renewed while the human decides. |
| `approval-first` | Holds are too short for the approver | Quoted amounts. Holds are placed after approval; a price past `tolerance.amountPercent` aborts. |
| `holds-first` | You want the approval to record exactly how long the holds last | The plan plus a `holds` block: each hold's `holdRef`, amount and end, and an approval deadline fitted inside the earliest end. No commit starts past a signed end. If what is left is too short for the escalation chain, nobody is asked. |
| *(unset)* | | The coordinator chooses `parallel` or `approval-first` from the clock and writes its choice into the plan. |

## When the irreversible step doesn't answer

If the `final` commit times out, the effect may or may not have happened: the card may have been charged and the response lost. Capturing the holds or voiding them would each be a guess, so the transaction is **in doubt**.

<p align="center"><img src="https://raw.githubusercontent.com/probita-ai/hatp/main/docs/in-doubt.svg" alt="Flowchart. A final step with no answer puts the transaction IN_DOUBT: holds stay live and the idempotent commit is retried. A result captures the holds (COMMITTED); an HATP error rolls back (ABORTED); no answer by the escalation time leads to NEEDS_ATTENTION with holds left live. The coordinator keeps asking slowly, records any late outcome with each hold's state, and offers recovery options it never performs: capture-holds, linked-transaction, undo-final, roll-back." width="800"></p>

- **Lead time.** Card authorizations often have a fixed window (Stripe's `capture_before`, for example), and a person needs hours to act, not seconds. Set `escalation.leadSeconds` in the plan, or `escalationLeadSeconds` on the coordinator as a default. The coordinator escalates that far before the first hold ends, and every deadline derived from a hold reserves the same time. A hold too short for it aborts the transaction before anything commits.
- **Late outcomes.** After escalating, the coordinator keeps asking the `final` step (every `latePollMs`, until `lateGiveUpSeconds`). A late answer is added to the Transaction Record with where each hold stands, and `onLateOutcome` receives the updated record and the recovery options.
- **Recovery is offered, never performed.** Capturing again or undoing the effect are new actions that need fresh consent. A `linked-transaction` option says whether the payer must be present: re-authorizing a lapsed card is merchant initiated, so it needs the payer unless the plan recorded off-session consent covering the amount in `recovery.offSessionReauth`.

```ts
const coordinator = createCoordinator({
  id, signer, participants, gateways, keyring,
  escalationLeadSeconds: 4 * 3600,
  onLateOutcome(record, recovery) {
    // e.g. recovery = [{ kind: "linked-transaction", recoveryOf: record.plan.txnId, branches: ["flight"], payerPresent: true }]
    notifyOps(record.plan.onBehalfOf, record.events.at(-1), recovery);
  },
});
```

## Finding an organisation

Each organisation publishes `https://{org}/.well-known/human-card.json`, which names its Directory and Human Gateway and lists the keys that sign its Human Cards. `fetchDiscovery` fetches and checks it, including that the document's `org` matches the host it came from:

```ts
import { createCoordinator, Directory, fetchDiscovery, gatewaysFrom, issuerKeys } from "hatp-protocol";

const acme = await fetchDiscovery("acme.com");       // https://acme.com/.well-known/human-card.json
const directory = new Directory(issuerKeys(acme));   // accepts only cards acme.com's issuers signed
const coordinator = createCoordinator({ id, signer, participants, keyring, gateways: gatewaysFrom([acme]) });
// acme.directory?.mcp and acme.gateway?.mcp say where to open MCP sessions (see hatp-mcp).
```

To publish one, serve a JSON document of type `OrgDiscovery`; `validateDiscovery(doc, org)` checks it before you do.

## Evidence

Every vote, approval and outcome is signed (Ed25519) over a SHA-256 digest of the canonical plan (RFC 8785). An approval records who decided, how they were authenticated, and everyone who was asked on the way. `verifyRecord(record, keyring)` checks the record offline: every signature, the hash chain of events, that each participant voted yes on the same plan, and that each approval group reached its quorum.

## API at a glance

| Export | What it does |
|---|---|
| `createCoordinator(opts)` | `run(plan)` drives a transaction and resolves with the signed Transaction Record. `idle()` resolves when no late-outcome polling is left. |
| `createResourceParticipant(opts)` | Wraps tool operations as `hold`, `compensate` or `final`. Idempotent commits, leases, horizons, presumed abort. |
| `createHumanGateway(opts)` | Resolves `human://` addresses, delivers asks over your `HumanChannel`, escalates on SLA, enforces quorum and separation of duties. |
| `Directory`, `signCard` | Issuer-signed Human Cards and ranked resolution by role, skill, authority and load. |
| `fetchDiscovery`, `validateDiscovery`, `issuerKeys`, `gatewaysFrom` | An organisation's `/.well-known/human-card.json`: its Directory, Gateway and card issuer keys. |
| `verifyRecord(record, keyring)` | Offline verification of a Transaction Record. |
| `createSigner`, `KeyRing`, `planDigest` | Keys, signatures and the plan digest. |

## Learn more

- [Spec v0.1](https://github.com/probita-ai/hatp/blob/main/spec/hatp-v0.1.md): transactions §5–§7, late outcomes and recovery §6.5, evidence §8
- [Repository and the trip-booking demo](https://github.com/probita-ai/hatp)

## License

Apache-2.0
