# HATP: Human-Agent Transaction Protocol — v0.1 (Draft)

**Status:** Working draft. Not stable. Breaking changes expected.
**Date:** 2026-10-25
**Scope of this version:** Discovery, Transactions, Evidence. (Sessions — async asks and live calls — are deferred to v0.2; see §11.)
**Name:** HATP stands for Human-Agent Transaction Protocol.

---

## 1. Introduction

MCP connects agents to tools. A2A connects agents to agents. Neither defines how an agent:

1. **finds the right human** for a decision by role, skill, authority, and availability;
2. **performs a multi-step action atomically** across several independent tool servers; or
3. **makes a human's approval part of that atomic action**, with proof of exactly what was approved.

HATP defines these three things as small, composable layers:

| Layer | Question it answers | Section |
|---|---|---|
| Discovery | *Who* can do or approve this, right now? | §4 |
| Transactions | How do we do *all of it or none of it*, including human votes? | §5–§7 |
| Evidence | Who agreed to *exactly what*, and can anyone verify it later? | §8 |

The central idea: **a human approval is a vote in a two-phase commit.** A transaction such as *"book flight + hotel, charge the card, but only if a finance approver agrees within 15 minutes"* either fully happens or leaves no effect.

### 1.1 Design goals

- **Incremental adoption.** Ships first as an MCP extension (§9). An existing MCP tool server becomes an HATP participant by implementing three to five extra methods.
- **Honest guarantees.** Each participant declares what it can actually guarantee (§5.2). The coordinator orders work so the guarantee of the whole transaction is as strong as possible, and reports when it is not.
- **Verifiable without trusting the coordinator.** Every vote, approval, and outcome is signed over a canonical digest of the plan (§8).
- **Humans are first-class, not a UI afterthought.** Humans have cards, authority limits, workloads, SLAs, and delegates (§4).

### 1.2 Non-goals for v0.1

Payments (see AP2), agent identity issuance (see IETF agent identity drafts), memory portability, serializable isolation across participants, and live voice/video sessions (v0.2).

### 1.3 Conventions

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, MAY are to be interpreted as in RFC 2119 / RFC 8174. All messages are JSON-RPC 2.0. Timestamps are RFC 3339 UTC strings. Durations are integer seconds. JSON Schemas for all types are in [`schemas/hatp.schema.json`](schemas/hatp.schema.json).

---

## 2. Terminology

| Term | Definition |
|---|---|
| **Initiator** | The agent (acting for a principal) that asks a coordinator to run a transaction. |
| **Coordinator** | Drives the transaction state machine, keeps the durable log, and produces the Transaction Record. |
| **Participant** | Any party enlisted in a transaction. Either a **resource participant** (a tool server) or a **human participant** (reached through a Human Gateway). |
| **Branch** | One participant's part of a transaction, identified by `branchId`. |
| **Human Gateway** | A service that represents humans as participants: resolves addresses, delivers asks, authenticates the human, and returns signed approvals. |
| **Directory** | Serves Human Cards and Agent Cards and resolves addresses to candidates. Often co-located with a Human Gateway. |
| **Plan** | The complete, immutable description of a transaction: participants, operations, arguments, amounts, deadlines. |
| **Plan digest** | SHA-256 over the canonical JSON of the Plan (§8.1). Everything signed in HATP refers to it. |
| **Hold** | A temporary reservation that guarantees a later commit will succeed (seat hold, funds authorization). |
| **Lease** | The expiry time of a hold or lock. After expiry the participant MAY release it. |
| **Horizon** | The latest time a participant will honor a hold, renewals included. A lease can be renewed up to the horizon, never past it. |
| **Tier** | What a participant can guarantee: `hold`, `compensate`, or `final` (§5.2). |

---

## 3. Architecture overview

```
        ┌───────────┐  begin(plan)   ┌──────────────┐
        │ Initiator │──────────────▶│  Coordinator │──── durable log
        │  (agent)  │◀── record ─────│              │
        └───────────┘                └──────┬───────┘
                                            │ hatp/txn/* (JSON-RPC, e.g. over MCP)
             ┌───────────────┬──────────────┼───────────────┬─────────────────┐
             ▼               ▼              ▼               ▼                 ▼
       Airline MCP      Hotel MCP     Calendar MCP     Payments MCP     Human Gateway
       tier: hold       tier: hold    tier: compensate tier: final      (resolves
                                                                         human://…,
                                                                         asks, signs)
```

---

## 4. Discovery layer

### 4.1 Addresses

HATP defines two URI schemes. They identify parties; they are not network locations. A Directory resolves them.

```
human://{org}/{local}                      a specific person          human://acme.com/alice
human://{org}/role/{role}                  anyone holding a role      human://acme.com/role/finance-approver
human://{org}/pool/{pool}                  a named group              human://acme.com/pool/security-leads
agent://{org}/{name}                       a specific agent           agent://acme.com/travel-bot
```

Query parameters refine role and pool addresses:

| Parameter | Meaning | Example |
|---|---|---|
| `skill` | Required skill (repeatable) | `?skill=sox-controls` |
| `quorum` | `M-of-N` distinct humans required | `?quorum=2-of-3` |
| `exclude` | Person who MUST NOT be selected (repeatable) | `?exclude=human://acme.com/alice` |

The initiator SHOULD include `exclude` for itself and for its own principal when separation of duties applies. A Human Gateway MUST enforce organisational separation-of-duty policy regardless of what the initiator sends.

### 4.2 Human Card

A Human Card describes what a person can decide and how to reach them, **without exposing contact details to agents**.

```json
{
  "id": "human://acme.com/bob",
  "displayName": "Bob Chen",
  "org": "acme.com",
  "roles": ["finance-approver"],
  "skills": ["travel-policy", "sox-controls"],
  "authority": [
    { "action": "approve.spend", "maxAmount": { "value": 10000, "currency": "USD" } }
  ],
  "channels": ["slack", "sms", "voice"],
  "availability": { "timezone": "America/New_York", "status": "available", "hours": "Mo-Fr 09:00-18:00" },
  "sla": { "ackSeconds": 300, "decideSeconds": 900 },
  "capacity": { "maxOpen": 10, "open": 2 },
  "delegates": ["human://acme.com/carol"],
  "keys": [{ "kid": "bob-2026-1", "kty": "OKP", "crv": "Ed25519", "x": "…" }],
  "issuer": "https://directory.acme.com",
  "signature": { "alg": "Ed25519", "kid": "acme-directory-1", "sig": "…" }
}
```

Requirements:

- `channels` lists channel **types** only. Addresses (phone numbers, Slack IDs) MUST stay inside the Human Gateway.
- `capacity.open` and `availability.status` MAY be coarse (rounded or bucketed) to protect privacy. A Directory MAY omit them from cards returned to agents outside the organisation.
- Cards MUST be signed by their `issuer` (§8.2). Consumers MUST reject cards whose signature does not verify against the issuer's published keys.
- `authority` entries are evaluated by the Human Gateway, not by the agent. They are published so agents can choose sensible targets, not as a security boundary.

### 4.3 Agent Card

HATP reuses the A2A Agent Card and adds one optional field:

```json
{ "hatp": { "version": "0.1", "roles": ["participant"], "tiers": ["hold"], "keys": [ … ] } }
```

### 4.4 `hatp/directory/resolve`

Request:

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "hatp/directory/resolve",
  "params": {
    "address": "human://acme.com/role/finance-approver?quorum=1-of-1&exclude=human://acme.com/dana",
    "requirement": { "action": "approve.spend", "amount": { "value": 2140, "currency": "USD" } },
    "urgency": "normal",
    "deadline": "2026-10-25T18:15:00Z"
  }
}
```

Result: a ranked candidate list.

```json
{
  "candidates": [
    { "id": "human://acme.com/bob",   "score": 0.92, "reasons": ["available", "authority-ok", "load 2/10"] },
    { "id": "human://acme.com/alice", "score": 0.40, "reasons": ["authority-ok", "load 9/10"] }
  ],
  "quorum": { "required": 1, "of": 2 }
}
```

Ranking rules:

1. A candidate MUST NOT be returned unless their authority covers `requirement` and they are not excluded.
2. Among eligible candidates the Directory SHOULD rank by: availability within the deadline, remaining capacity, then expected decision time (from `sla`).
3. If fewer eligible candidates exist than `quorum.required`, the Directory MUST return error `QUORUM_UNREACHABLE` (§10).

Resolution is advisory. The Human Gateway performs the final selection at prepare time (§6.3) and MAY choose differently if the situation changed.

---

## 5. Transactions: model

### 5.1 The Plan

The initiator submits a Plan. Once the coordinator accepts it, the Plan is immutable; its digest identifies what everyone votes on.

```json
{
  "hatp": "0.1",
  "txnId": "txn_01JB8Z…",
  "initiator": "agent://acme.com/travel-bot",
  "onBehalfOf": "human://acme.com/dana",
  "purpose": "Customer visit, Boston, Nov 3–5",
  "deadline": "2026-10-25T18:30:00Z",
  "prepareOrder": "parallel",
  "branches": [
    { "branchId": "flight", "participant": "mcp://airline.example/hatp", "tier": "hold",
      "operation": { "tool": "book_seat", "arguments": { "flight": "UA 1520", "date": "2026-11-03", "seat": "14C" } },
      "amount": { "value": 412, "currency": "USD" } },
    { "branchId": "hotel", "participant": "mcp://hotels.example/hatp", "tier": "hold",
      "operation": { "tool": "reserve_room", "arguments": { "hotel": "HBOS-22", "nights": 2 } },
      "amount": { "value": 588, "currency": "USD" } },
    { "branchId": "calendar", "participant": "mcp://calendar.acme.com/hatp", "tier": "compensate",
      "operation": { "tool": "create_event", "arguments": { "title": "Boston trip", "start": "2026-11-03" } } },
    { "branchId": "charge", "participant": "mcp://payments.acme.com/hatp", "tier": "final",
      "operation": { "tool": "charge_card", "arguments": { "card": "corp-dana" } },
      "amount": { "value": 1000, "currency": "USD" } }
  ],
  "approvals": [
    { "groupId": "finance", "address": "human://acme.com/role/finance-approver?exclude=human://acme.com/dana",
      "quorum": { "required": 1 },
      "requirement": { "action": "approve.spend", "amount": { "value": 1000, "currency": "USD" } },
      "decideBy": "2026-10-25T18:15:00Z" }
  ],
  "tolerance": { "amountPercent": 2 }
}
```

Rules:

- `txnId` MUST be globally unique (ULID or UUIDv7 RECOMMENDED).
- `operation.tool` and `operation.arguments` SHOULD match an MCP tool the participant exposes, so existing tool schemas validate arguments.
- A Plan MUST contain **at most one** `final`-tier branch (§5.3). A coordinator MUST reject a Plan with more, with `PLAN_INVALID`.
- `approvals` groups are expanded by the coordinator into human branches at prepare time (§6.3).

### 5.2 Participant tiers

Each resource participant declares, per operation, the strongest guarantee it can give:

| Tier | Prepare does | Commit does | Abort does | Example |
|---|---|---|---|---|
| `hold` | Places a hold with a lease. Votes yes only if the hold is in place. | Converts hold into the effect. MUST succeed while the lease is valid. | Releases the hold. | Card authorization, a seat hold the airline guarantees to ticket, an inventory reservation the warehouse guarantees to ship |
| `compensate` | Validates only (dry run). No effect. | Performs the effect; returns a `compensationToken`. | No-op if not executed; otherwise the coordinator calls `compensate`. | Calendar event, CRM update, internal ticket |
| `final` | Validates only. No effect. | Performs an irreversible effect. | No-op (it never ran). | Card capture, sending an external email, wire transfer, a booking whose confirm can still be refused |

A participant MUST NOT claim `hold` if it cannot guarantee that commit succeeds while the lease is valid.

**Choosing a tier.** The question for a provider is: *while the lease runs, is confirm guaranteed?*

- **Yes:** declare `hold`. A yes vote is then a real promise to commit, as in two-phase commit.
- **No**, because confirm can still fail on fare, price or inventory: the "hold" is only a reservation. Declare `final` if a confirmed booking cannot be undone, or `compensate` if it can be cancelled (for example with a refund).

For example, if an airline's seat reservation can still be refused at ticketing, declare the seat as `final` and the card authorization as `hold`. The commit order (§5.3) then authorises the card at prepare, confirms the seat as the `final` step, and captures the card last. If the airline refuses, the authorisation is voided; no capture has to be refunded.

### 5.3 Commit ordering

After all prepare votes are yes and the coordinator has durably logged the COMMIT decision, phase 2 runs in this fixed order:

1. **`compensate` branches**, sequentially in Plan order. If one fails, the coordinator compensates completed ones in reverse order, aborts all holds, and the transaction ends `ABORTED`.
2. **The `final` branch** (if any). If it fails, the coordinator compensates all step-1 branches in reverse, aborts all holds, and the transaction ends `ABORTED`. Only an answer from the participant counts as a failure. A timeout or lost connection leaves the outcome unknown, and the transaction is **in doubt** (below).
3. **`hold` branches**, in parallel. These cannot fail for business reasons because the holds guarantee them.

Placing the single irreversible step *before* committing holds, while holds are still guaranteed, is the "last resource commit" technique from XA transaction managers. It means a failure anywhere before step 3 leaves no lasting effect except compensated ones.

**Only one `final` step.** If two steps could each fail at commit and neither can be undone, no order is safe: whichever runs second can fail after the first has taken effect. A plan with two such steps cannot be built. One of them must offer `compensate` (for example cancel with refund), or the work must be split into separate transactions, each with its own approval.

This is the same rule production transaction managers enforce. Narayana, the JBoss transaction manager, implements the last resource commit optimisation: one one-phase resource may commit at the end of two-phase commit, and a second is rejected by default (`com.arjuna.ats.jta.allowMultipleLastResources=false`). Its documentation calls the override "transactionally unsafe" and recommends wrapping the extra resources in compensating transactions instead (Appendix A).

**A `final` step in doubt.** If the `final` commit gets no answer, the effect may or may not have happened: the airline may have ticketed the seat and the response got lost. Capturing the holds and voiding them would each be a guess. The coordinator MUST NOT treat the missing answer as a failure. Instead it:

1. moves to `IN_DOUBT` and leaves every hold in place, renewing leases as usual (§7.5);
2. retries the same `commit` with backoff. Commit is idempotent on `txnId` and `branchId` (§7), so a repeat is safe and doubles as a status query; a participant that is still running the first commit MUST answer the repeat with the result of that commit, not run the effect again;
3. on a result, continues with step 3 (capture). On an HATP error, which proves the effect did not happen, it rolls back as for any failure. If the outcome is still unknown when the earliest hold horizon, minus the estimated phase-2 duration and the safety margin, is reached, it ends in `NEEDS_ATTENTION` with the holds still live, so a human can capture or void them. Which wrong guess costs more (a refund, or an unpaid ticket) is a business decision, not a protocol one.

A `final` participant MUST answer a commit it could not perform with an HATP error (`COMMIT_FAILED`, or a more specific code) only when the effect did not happen.

Before starting phase 2, the coordinator MUST check that every hold's remaining lease is at least the estimated phase-2 duration plus a safety margin (RECOMMENDED: 30 s). If not, it MUST call `hatp/txn/renew` (§7.5) or abort.

### 5.4 Prepare ordering and the human-latency problem

Humans can take longer than a hold's lease. `prepareOrder` selects a strategy:

- **`parallel`**: holds and human asks go out together. Use when holds last longer than the expected decision time. While phase 1 is still waiting, the coordinator SHOULD renew each hold shortly before its lease expires (RECOMMENDED: when the lease has the smaller of the safety margin and half its remaining time left). Renewal stops at the hold's horizon; deadline tightening (below) covers the rest.
- **`approval-first`**: phase 0 asks each `hold` participant for a non-binding **quote** (`hatp/txn/quote`, §7.2) without placing holds. Humans approve a plan digest that includes those quotes. Then holds are placed. If any held amount differs from its quote by more than `tolerance.amountPercent`, the coordinator MUST NOT reuse the approval; it MUST either abort or re-ask with a new plan digest.

**Choosing the order.** If the Plan does not set `prepareOrder` and it has both `hold` branches and approval groups, the coordinator chooses before computing the plan digest:

1. Ask each `hold` participant for a quote (§7.2) and read its `maxHoldSeconds`. If a participant does not quote or omits it, use the requested `leaseSeconds`.
2. Ask each approval group's Human Gateway for its worst-case decision time (`hatp/txn/estimate`, §7.9). If the gateway does not support it, use the time remaining until `decideBy`.
3. If the largest worst case is at most the smallest `maxHoldSeconds` minus the estimated phase-2 duration and the safety margin (§5.3), use `parallel`. Otherwise use `approval-first`.

The coordinator MUST write the chosen order into the Plan, so the plan digest humans sign records it. It MUST NOT override a `prepareOrder` the Plan sets.

**Tightening the human deadline.** In `parallel` mode, whenever a `hold` vote returns a `holdHorizon`, the coordinator computes a cutoff: that horizon minus the estimated phase-2 duration and the safety margin. For every approval group still deciding whose current deadline is later than the cutoff, the coordinator sends `hatp/txn/tighten` (§7.10) to its Human Gateway. If the gateway does not support it, the coordinator MUST itself treat the group as voting `no` with `DEADLINE_EXCEEDED` at the cutoff. Either way the transaction aborts while every hold can still be released, instead of collecting an approval for a plan that can no longer commit.

### 5.5 Isolation

HATP v0.1 provides **read-committed** visibility. Held resources SHOULD appear to other transactions as unavailable ("held"), not as committed. Concurrent writers to the same resource SHOULD coordinate with locks (§7.6).

---

## 6. Transactions: state machines and flow

### 6.1 Coordinator states

```
 ACTIVE ──▶ PREPARING ──all yes──▶ COMMITTING ──▶ COMMITTED
               │                       │
               │ any no / deadline     │ step 1 or 2 fails
               ▼                       ▼
            ABORTING ─────────────▶ ABORTED
                                       ▲
                                       │ (compensations succeeded)
                                COMPENSATING
                                       │ compensation fails
                                       ▼
                               NEEDS_ATTENTION
```

When the `final` step gets no answer (§5.3):

```
 COMMITTING ──final step: no answer──▶ IN_DOUBT ──final step answers with a result──▶ COMMITTING (step 3)
                                          │
                                          ├──final step answers with an HATP error──▶ COMPENSATING
                                          │
                                          └──still unknown when the holds run out────▶ NEEDS_ATTENTION
```

- `IN_DOUBT` means the `final` step's outcome is unknown. Holds stay in place and are renewed while the coordinator retries the commit.
- The COMMIT or ABORT decision MUST be written to durable storage **before** any phase-2 message is sent.
- `NEEDS_ATTENTION` means the outcome is mixed (some effect could not be undone). The coordinator MUST report every branch's state in the Transaction Record and SHOULD notify the initiator and `onBehalfOf` principal.

### 6.2 Branch states

```
ENLISTED ─▶ PREPARED(lease) ─▶ COMMITTED ─▶ (COMPENSATED)
     │            │
     ▼            ▼
 VOTED_NO      ABORTED   (also: lease expired → RELEASED)
```

**Presumed abort:** a `hold` participant whose lease expires without a commit MAY release the hold and move to `RELEASED`. If a commit later arrives, it MUST answer `HOLD_EXPIRED`. The coordinator then treats that branch as failed in step 3, which leads to `NEEDS_ATTENTION` because steps 1–2 have already happened. Coordinators prevent this by renewing leases (§5.3). A `prepare` for a `RELEASED` branch is not a repeat: the participant MUST place a new hold and vote again.

**Losing a hold during phase 1:** if a renewal returns `HOLD_EXPIRED` while phase 1 is still running, the coordinator MAY send `prepare` for that branch once more. Approvals are bound to the plan digest, not to a `holdRef`, so they stay valid when the new hold is within `tolerance` of the planned amount. If the second hold is also lost, or the new vote is `no`, the branch votes `no` and the transaction aborts, withdrawing open asks.

### 6.3 Human branches

For each `approvals` group, the coordinator sends `hatp/txn/prepare` to the Human Gateway responsible for the address's `org`. The gateway:

1. Resolves the address (§4.4) and selects `quorum.required` distinct eligible humans.
2. Delivers an **ask** to each, rendering the plan **from the structured Plan**, not from agent-written prose (§10.3).
3. Authenticates each human at the moment of decision (§8.4).
4. Escalates on SLA expiry: if a selected human has not decided within their `sla.decideSeconds`, the gateway MAY reassign to the next candidate or to one of their `delegates`, recording the chain.
5. Returns one vote for the group: `yes` only when `quorum.required` approvals exist; `no` as soon as quorum becomes impossible or any approver rejects (unless the group sets `"rejectPolicy": "majority"`).

Human branches have no phase-2 effect. Commit and abort messages to them are notifications so the gateway can tell humans the outcome.

### 6.4 Example sequence (approval granted)

```
Initiator      Coordinator        Airline   Hotel   Calendar   Payments   HumanGW    Bob
   │ begin(plan) ─▶│                 │        │        │          │          │         │
   │               │─prepare────────▶│ hold 14C (lease 20m)        │          │         │
   │               │─prepare─────────────────▶│ hold room           │          │         │
   │               │─prepare──────────────────────────▶│ validate   │          │         │
   │               │─prepare─────────────────────────────────────▶│ validate │         │
   │               │─prepare(finance)─────────────────────────────────────────▶│─ask──▶│
   │               │◀──yes / yes / yes / yes                                    │◀approve│ (passkey)
   │               │◀──yes + signed approval─────────────────────────────────────│
   │               │ log COMMIT                                                  │
   │               │─commit─────────────────────────────▶│ event created (token)  │
   │               │─commit──────────────────────────────────────────▶│ captured  │
   │               │─commit────────▶│ ─commit─────────▶│  (parallel)                │
   │◀── record ────│ COMMITTED                                                  │
```

If Bob rejects, the gateway votes `no`, the coordinator logs ABORT, sends `abort` to all branches, holds are released, and nothing was ever executed.

---

## 7. Methods

All methods are JSON-RPC 2.0 requests from coordinator to participant unless noted. Every request carries `txnId`, `branchId`, and `planDigest`. Participants MUST process repeated requests idempotently and return the same result.

### 7.1 `hatp/txn/prepare`

```json
{ "method": "hatp/txn/prepare",
  "params": { "txnId": "txn_01JB8Z…", "branchId": "flight", "planDigest": "sha256:9f2c…",
              "plan": { … }, "leaseSeconds": 1200 } }
```

The full Plan is included so participants can verify `planDigest` themselves and see context (amounts, deadline). A participant MUST verify the digest and MUST vote `no` with `PLAN_MISMATCH` if it does not match.

Result:

```json
{ "vote": "yes", "leaseExpiresAt": "2026-10-25T18:35:00Z", "holdHorizon": "2026-10-25T18:45:00Z",
  "holdRef": "HLD-77812", "amount": { "value": 412, "currency": "USD" },
  "receipt": { … signed, §8.3 … } }
```

A `hold` participant whose renewals are capped SHOULD return `holdHorizon` and SHOULD include it in the prepare receipt. `leaseExpiresAt` MUST NOT be later than `holdHorizon`. If `holdHorizon` is absent, the hold has no known end: the coordinator relies on renewal (§7.5) and on the lease check before phase 2 (§5.3).

or `{ "vote": "no", "reason": { "code": "UNAVAILABLE", "message": "Seat 14C taken" }, "receipt": { … } }`.

Human Gateway results additionally include `approvals: [Approval, …]` (§8.4). Gateways MAY return `{ "vote": "pending", "pollAfterSeconds": 30 }`; the coordinator then polls with `hatp/txn/status` or receives `hatp/txn/voted` (§7.7).

### 7.2 `hatp/txn/quote` (hold tier, phase 0)

Same parameters as prepare. Returns `{ "amount": …, "quoteRef": "…", "validUntil": "…", "maxHoldSeconds": 1800 }` with no hold placed. `maxHoldSeconds` is how long a hold placed later may last, renewals included; it is a duration because no hold exists yet to anchor a horizon. Participants with capped renewals SHOULD return it.

### 7.3 `hatp/txn/commit` and `hatp/txn/abort`

`{ "txnId", "branchId", "planDigest", "decisionRecord": { … signed coordinator decision … } }`

`decisionRecord` lets each participant prove later that the coordinator ordered the commit. Commit results for `compensate` branches MUST include `compensationToken`. All results include a signed `receipt`.

A repeated `commit` MUST return the first commit's result, including while the first is still running; it MUST NOT perform the effect twice. This is what lets a coordinator resolve an in-doubt `final` step (§5.3) by retrying.

### 7.4 `hatp/txn/compensate`

`{ "txnId", "branchId", "compensationToken" }`. The participant MUST undo the effect or return `COMPENSATION_FAILED` with details. Compensation MUST be idempotent.

### 7.5 `hatp/txn/renew`

`{ "txnId", "branchId", "leaseSeconds" }` → `{ "leaseExpiresAt" }` or `HOLD_EXPIRED`. Participants MAY cap renewals (e.g. an airline may allow at most 30 minutes total). A capped participant MUST NOT extend `leaseExpiresAt` past the `holdHorizon` it returned at prepare; a renewal that asks for more returns the horizon.

### 7.6 Locks: `hatp/lock/acquire`, `hatp/lock/renew`, `hatp/lock/release`

```json
{ "method": "hatp/lock/acquire",
  "params": { "resource": "jira://ACME-142", "mode": "exclusive", "ttlSeconds": 60, "txnId": "txn_…" } }
```

Result: `{ "lockToken": "…", "fencingToken": 1874, "expiresAt": "…" }`.

`fencingToken` is a number that increases with every grant for that resource. Participants that receive writes guarded by a lock MUST reject any write carrying a fencing token lower than one they have already seen (`STALE_FENCING_TOKEN`). This prevents an agent that was paused past its lock expiry from overwriting newer work.

### 7.7 Status and notifications

- `hatp/txn/status` (either direction): returns the sender's view of the transaction or branch state. Participants that are unsure of an outcome MAY ask the coordinator when the transport allows it.
- `hatp/txn/voted` (notification, participant → coordinator): delivers a deferred vote. Coordinators MUST support polling; push is OPTIONAL.

### 7.8 `hatp/txn/begin` (initiator → coordinator)

`{ "plan": { … } }` → `{ "txnId", "planDigest", "state": "PREPARING" }`. The coordinator MUST validate the Plan (schema, single `final`, deadlines in the future, all participants reachable and advertising the declared tier) before accepting it.

The final result (via `hatp/txn/status` or a completion notification) includes the **Transaction Record** (§8.5).

### 7.9 `hatp/txn/estimate` (Human Gateway, phase 0)

Same parameters as prepare, with `branchId` naming the approval group (`approval:{groupId}`). Returns `{ "worstCaseSeconds": 1800, "receipt": { … } }` and asks no one.

`worstCaseSeconds` is the latest, counted from now, at which the group could still reach a decision if every human asked lets their `sla.decideSeconds` run out. The gateway computes it by walking the same escalation order it uses in §6.3 (delegates of the human who missed their SLA first, then the remaining candidates in rank order, each human at most once), with `quorum.required` slots in parallel. The result MUST NOT exceed the time remaining until `decideBy`.

### 7.10 `hatp/txn/tighten` (Human Gateway)

`{ "txnId", "branchId", "planDigest", "plan", "decideBy" }` → `{ "decideBy", "receipt" }`.

Shortens an approval group's effective deadline. The gateway MUST refuse (`INVALID_STATE`) a `decideBy` later than the group's `decideBy` in the Plan: the signed plan bounds how long humans may be asked, and a coordinator can only shorten that. Repeated calls keep the earliest value. The gateway MUST apply a tighten that arrives before the matching prepare. When the effective deadline passes, the gateway withdraws open asks and votes `no` with `DEADLINE_EXCEEDED`. Asks delivered after tightening SHOULD show the effective deadline.

The effective deadline is not part of the plan digest. Approvals stay bound to the plan the humans saw; tightening only ends the wait sooner.

---

## 8. Evidence layer

### 8.1 Canonicalisation and digests

- Canonical form: JSON Canonicalization Scheme (RFC 8785).
- `planDigest = "sha256:" + base64url(SHA-256(JCS(plan)))`.
- Every signed object is signed over `JCS(object without its "signature" field)`.

### 8.2 Signatures and keys

- Algorithm: Ed25519. Signature objects: `{ "alg": "Ed25519", "kid": "…", "sig": "<base64url>" }`.
- Keys are published as JWK (OKP / Ed25519) in Human Cards, Agent Cards, or the participant's MCP capability declaration (§9).
- Future versions will define a JWS/COSE envelope; v0.1 keeps the detached form for simplicity.

### 8.3 Receipts

Every participant response to prepare, commit, abort, and compensate includes a Receipt:

```json
{ "type": "hatp.receipt", "txnId": "…", "branchId": "flight", "planDigest": "sha256:…",
  "phase": "prepare", "outcome": "yes", "detail": { "holdRef": "HLD-77812" },
  "issuedAt": "2026-10-25T18:01:12Z", "issuer": "mcp://airline.example/hatp",
  "signature": { … } }
```

### 8.4 Approvals

A human approval is bound to the exact plan:

```json
{ "type": "hatp.approval", "txnId": "…", "groupId": "finance", "planDigest": "sha256:…",
  "decision": "approve",
  "approver": "human://acme.com/bob",
  "routedVia": ["human://acme.com/role/finance-approver", "human://acme.com/alice", "human://acme.com/bob"],
  "routingReason": "alice did not decide within SLA; reassigned to bob",
  "authentication": { "method": "webauthn", "at": "2026-10-25T18:04:51Z", "assurance": "human-signed" },
  "nonce": "b8Kq…", "decidedAt": "2026-10-25T18:04:51Z",
  "signature": { … } }
```

- Because `planDigest` is signed, an approval cannot be reused for a different plan, amount, or recipient. This is the property missing from existing human-escalation drafts, where the human's signature does not cover the action arguments.
- `assurance` is one of:
  - `human-signed`: signed with a key the human controls (e.g. a passkey-backed key). RECOMMENDED above an organisation-defined threshold.
  - `gateway-attested`: signed by the Human Gateway's key after it authenticated the human. The `authentication` block records how.
- `routedVia` and `routingReason` record every reassignment and delegation, so auditors see who was asked as well as who decided.

### 8.5 Transaction Record

At the end of every transaction the coordinator emits a Transaction Record: the Plan, the plan digest, an ordered event log, all receipts and approvals, the decision, and the final state of each branch. Each event includes `prevHash` (SHA-256 of the previous event's canonical form) to form a hash chain. The coordinator signs the record.

Anyone holding the record and the public keys can verify offline that:

1. every participant voted yes on the same plan digest;
2. each approval came from an eligible human with the required assurance;
3. the decision matches the votes; and
4. no event was removed or reordered.

---

## 9. MCP binding

An MCP server becomes an HATP participant by advertising the extension in its `initialize` result:

```json
{ "capabilities": {
    "experimental": {
      "hatp": {
        "version": "0.1",
        "roles": ["participant"],
        "operations": { "book_seat": { "tier": "hold", "maxLeaseSeconds": 1800, "maxHoldSeconds": 1800 } },
        "keys": [{ "kid": "mcp://airline.example/hatp#key-1", "kty": "OKP", "crv": "Ed25519", "x": "…" }]
      } } } }
```

- The coordinator acts as an MCP **client**. `hatp/*` methods are sent as JSON-RPC requests over the existing MCP session.
- Operations reference existing MCP tools by name. Calling the tool directly via `tools/call` remains possible and is outside any transaction.
- Human Gateways advertise `"roles": ["human-gateway", "directory"]` and also serve `hatp/txn/estimate` (§7.9) and `hatp/txn/tighten` (§7.10).
- `maxHoldSeconds` per operation is the same cap a quote reports (§7.2), so coordinators can read it without a quote.
- **Keys** are self-asserted by the server. Every `kid` MUST start with the participant's URI followed by `#`. A coordinator MUST reject a server that advertises a key outside its own namespace, since it could otherwise replace another participant's key. Organisations that need stronger assurance SHOULD also pin participant keys out of band.
- **Errors** are JSON-RPC errors with code `-32050` and `data.hatpCode` (§10.1). A server that does not implement an optional method answers JSON-RPC "method not found", which the coordinator treats as `NOT_SUPPORTED`.
- **Timeouts:** a Human Gateway answers `prepare` only when the humans decide. Coordinators MUST NOT apply a short default request timeout to `prepare`. They SHOULD wait until the plan's `deadline`, unless the gateway returns a `pending` vote.
- Deferred votes use MCP server-to-client notifications where the transport supports them (Streamable HTTP); otherwise the coordinator polls.

An A2A binding (for transactions that cross organisations, where the coordinator itself is a remote agent) is planned for v0.2.

---

## 10. Errors and security

### 10.1 Error codes

JSON-RPC errors use code `-32050` with `data.hatpCode`:

| `hatpCode` | Meaning |
|---|---|
| `PLAN_INVALID` | Schema error, more than one `final` branch, or deadline already passed |
| `PLAN_MISMATCH` | Received `planDigest` does not match the Plan |
| `TXN_UNKNOWN` | No such transaction or branch |
| `INVALID_STATE` | Request not allowed in the branch's current state |
| `HOLD_EXPIRED` | Lease expired before commit or renew |
| `DEADLINE_EXCEEDED` | Transaction or approval deadline passed |
| `AUTHORITY_INSUFFICIENT` | No eligible human has the required authority |
| `QUORUM_UNREACHABLE` | Not enough eligible humans for the quorum |
| `LOCK_CONFLICT` | Lock held by another owner |
| `STALE_FENCING_TOKEN` | Write guarded by an outdated fencing token |
| `COMPENSATION_FAILED` | Undo was not possible |
| `COMMIT_FAILED` | Commit was attempted and the effect did not happen |
| `NOT_SUPPORTED` | Tier or method not implemented |

### 10.2 Threats and mitigations

| Threat | Mitigation |
|---|---|
| Malicious or buggy coordinator commits without votes | Participants receive a signed `decisionRecord` with commit; every vote is signed over the plan digest; records are verifiable offline. |
| Approval replay on a different action | Approvals sign `planDigest` and a nonce; gateways reject reuse. |
| Agent forges or inflates authority claims | Authority is enforced by the Human Gateway against org policy, never by the agent. |
| Card spoofing | Cards are issuer-signed; consumers verify against the issuer's published keys. |
| Self-approval / separation-of-duty bypass | The gateway enforces org SoD rules; `onBehalfOf` and the initiator's principal are always excluded from approving their own spend. |
| Approval fatigue (rubber-stamping) | Gateways SHOULD rate-limit asks per human, batch similar asks, and show effect summaries rather than raw text. |
| Exposure of human contact details or workload | Channels are types only; workload and status MAY be coarse or hidden outside the org. |
| Lease exhaustion attacks (holding inventory forever) | Participants cap `leaseSeconds` and total renewal time, and MAY require authenticated coordinators. |

### 10.3 Prompt injection into asks

Asks are what humans approve, so they are a prime target. A Human Gateway MUST render the ask's decision-relevant content (participants, operations, amounts, recipients, deadline) from the structured Plan. Any free text supplied by the agent (`purpose`) MUST be visually separated and labelled as agent-provided. The digest the human approves is always the full Plan, not the rendered text.

---

## 11. Roadmap (beyond v0.1)

- **v0.2 — Transaction hardening.** From implementation feedback on v0.1; tracked in the [v0.2 milestone](https://github.com/probita-ai/hatp/milestone/1).
  - `holds-first` prepare order, with lease expiries and the approval deadline in the signed plan digest.
  - In-doubt handling for a `final` step that gets no answer: neither capture nor void, renew holds, retry the idempotent commit, escalate before the holds run out (§5.3).
  - Deferred `pending` votes and polling (§7.1, §7.7), and locks (§7.6), in the reference SDK.
  - `hatp/directory/resolve` over the MCP binding (§4.4, §9).
- **v0.2 — Sessions.**
  - `hatp/ask/*` for asynchronous human requests outside transactions (approve, choose, form, free text), with A2H and CHEQ as delivery channels.
  - `hatp/call/*`: SIP-style live sessions where any party (`human://` or `agent://`) can dial any other. Format is negotiated per pair: voice or video with a human, a structured data channel between agents, mixed for conferences. Transfer, conference, hold, and *upgrade-to-transaction* (a spoken "yes" becomes a passkey-confirmed Approval).
  - A2A binding.
- **v0.3.** Effect previews (dry-run diffs) for `compensate` and `final` tiers, multi-`final` transactions with explicit risk acceptance (opt-in per plan and recorded in the Transaction Record, like Narayana's `allowMultipleLastResources`; §5.3), and a conformance test suite.

---

## 12. Open issues

1. **Coordinator recovery details.** v0.1 specifies presumed abort and a durable decision log, but not log formats or coordinator failover.
2. **Cross-org trust.** How a Human Gateway in org A trusts a coordinator in org B (mutual TLS, signed agent identities, or IETF agent identity drafts).
3. **Partial approvals.** `approve_with_constraints` (e.g. "approve up to $800"), which would require the coordinator to re-plan.
4. **Quotes in `parallel` mode.** Whether participants should also return quotes during prepare so humans see final amounts.
5. **Relationship with Twilio A2H.** A2H v2.0 plans N-of-M approval and delegation. HATP should define how an A2H gateway can sit behind an HATP Human Gateway.

---

## Appendix A. Prior art

| Work | Relationship |
|---|---|
| X/Open XA, two-phase commit, sagas | Basis of §5–§6; "last resource commit" for the single `final` branch. |
| Narayana (JBoss transaction manager), last resource commit optimisation | Precedent for the one-`final` rule (§5.3): one one-phase resource per transaction by default; enabling more is documented as "transactionally unsafe". See the [JBoss EAP LRCO overview](https://docs.redhat.com/en/documentation/JBoss_Enterprise_Application_Platform/5/html/administration_and_configuration_guide/lrco-overview) and the [Transactions Development Guide, ch. 3](https://docs.redhat.com/en/documentation/red_hat_jboss_enterprise_application_platform/5/html/transactions_development_guide/chap-transactions_jta_programmers_guide-test). |
| Fencing tokens (Kleppmann, *Designing Data-Intensive Applications*) | §7.6 locks. |
| MCP (Anthropic / AAIF) | Transport binding (§9); operations reference MCP tools. |
| A2A (Linux Foundation) | Agent Cards extended in §4.3. |
| IETF draft-sato-soos-hem | Human escalation lifecycle; no role/skill routing, quorum, or plan-bound signatures. |
| IETF draft-rosenberg-cheq | Signed human confirmation of individual actions; can serve as a delivery mechanism. |
| Twilio A2H | Typed agent-to-human intents over channel gateways; candidate delivery layer. |
| AP2 | Signed payment mandates; HATP leaves payments to AP2. |
| RFC 8785 (JCS) | Canonical JSON for digests and signatures. |
