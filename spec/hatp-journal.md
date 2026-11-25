# HATP Journal: undo for agents

**Status:** Draft for implementation. The design was reviewed in [#54](https://github.com/probita-ai/hatp/issues/54), and the reference SDK is built against this text. A change that breaks it needs an issue.
**Date:** 2026-11-21
**Target:** HATP v0.3. Builds on v0.1 ([hatp-v0.1.md](hatp-v0.1.md)) and the [Human Gateway SEP](sep/0000-human-gateway.md). References written §5.2 point to v0.1, SEP §5 to the SEP, and J§5.2 to this document. Types are in [schemas/hatp.schema.json](schemas/hatp.schema.json).
**Scope:** Journaled tool calls, reversibility-gated autonomy, and reversal of past effects with human approval.

---

## 1. Introduction

HATP v0.1 makes multi-step actions safe **before** they happen: plan, prepare, approve, then commit all or nothing. Most agents today work differently. They call one tool at a time, with no plan and no coordinator, and the human finds out what happened afterwards. When such an agent gets something wrong, nobody can take back its run across the systems it touched.

The Journal adds the matching guarantee **after** the fact:

| Mode | Question it answers | Where |
|---|---|---|
| Prevent | How do we do all of it or none of it, with a human vote? | v0.1 §5–§8 |
| Recover | What did the agent do, and how do we take it back? | This document |

It rests on two ideas:

1. **Every effect is journaled with its undo.** Each tool call made through a Recorder returns what it changed, a token to reverse it, and the time until which that is possible. Reversal reuses `hatp/txn/compensate` (§7.4).
2. **Autonomy is granted by reversibility.** An agent may act freely on what can be undone. Before an effect that cannot be undone, the Recorder holds the call until a human other than the one the agent acts for approves exactly that call (J§7). Your organisation sets this policy, not the agent.

### 1.1 Design goals

- **Works with any MCP server on day one.** A server that knows nothing about HATP still gets journaled; its calls are recorded as `unknown` and treated as irreversible. A server becomes reversible by returning two values from its existing tools.
- **Undo is a decision, not a button.** Reversing work can destroy newer work or notify outsiders, so a reversal is a Plan that a human approves, routed by the Human Gateway like any other ask (§6.3).
- **Never overwrite newer human work.** A compensation only applies if the resource is still in the state the agent left it in (J§8.6).
- **Honest about what cannot be undone.** Irreversible effects are recorded with the reason. Recovery for them is offered, never performed (as in §6.5).

### 1.2 Non-goals

Undoing reads (a disclosure cannot be taken back; J§4), redo, reversal across organisations without a pre-existing trust relationship (v0.1 open issue 2), and effects that happen outside any tool call.

### 1.3 Versioning

Messages this document defines carry `"hatp": "0.3"`: Reversal Plans (J§8.4) and Run Records (J§6.2). A server with the `journal` or `recorder` role advertises `"version": "0.3"` in its capability (J§4).

Nothing else changes version. An ordinary transaction Plan still carries `"hatp": "0.1"`, and a 0.3 party MUST keep accepting 0.1 Plans and 0.1 capabilities. A party that receives a 0.3 message it doesn't support refuses it with `NOT_SUPPORTED`. In particular, a Human Gateway built for v0.2 refuses a Reversal Plan, and a coordinator built for v0.2 doesn't use a server whose capability says `0.3`. Upgrade gateways and coordinators before participants.

---

## 2. Terminology

| Term | Definition |
|---|---|
| **Run** | A sequence of tool calls made by one agent for one principal, identified by `runId`. A run is usually one task ("tidy up the Q4 pipeline"). |
| **Entry** | One journaled tool call in a run, identified by `entryId` and ordered by `seq`. |
| **Recorder** | The service that journals calls, signs the Run Record, applies the autonomy policy, and drives reversals. Usually an MCP gateway or the agent's host, not the agent itself (J§12). |
| **Undo window** | The time until which an entry can be reversed: `undoBy`. Set by the participant, never by the agent. |
| **Reversal** | Taking back one or more entries, run as a saga in reverse order after a human approves. |
| **Reversal set** | The entries a reversal will compensate: those requested plus every later entry that depends on them (J§8.2). |

---

## 3. Architecture overview

```
   ┌─────────┐ tools/call            ┌──────────────┐ tools/call + _meta    ┌──────────────┐
   │  Agent  │──────────────────────▶│   Recorder   │──────────────────────▶│ CRM MCP      │ undo: compensate, 7d
   └─────────┘◀── result ────────────│  run journal │◀── result + undo ─────│ Calendar MCP │ undo: compensate, 30d
                                     │  policy      │                       │ Email MCP    │ undo: none
   ┌─────────┐ hatp/journal/reverse  │  reversals   │ hatp/txn/prepare      ┌──────────────┐
   │  Human  │──────────────────────▶│              │──────────────────────▶│ Human Gateway│
   │  (UI)   │◀── Run Record ────────└──────────────┘◀── signed approval ───└──────────────┘
   └─────────┘
```

The Recorder sits on the path between the agent and its tool servers. Agents need no changes.

---

## 4. Declaring reversibility

A participant declares, per operation, what happens when the tool is called **directly** (outside a transaction). It extends the MCP capability of §9 with an `undo` object:

```json
{ "capabilities": { "extensions": { "ai.probita/human-gateway": { "revision": "1", "hatp": {
    "version": "0.3",
    "roles": ["participant", "journal"],
    "operations": {
      "update_deal": { "tier": "compensate",
                       "undo": { "kind": "compensate", "windowSeconds": 604800 } },
      "create_event": { "tier": "compensate",
                        "undo": { "kind": "compensate", "windowSeconds": 2592000,
                                  "sideEffects": ["Attendees receive a cancellation notice"] } },
      "charge_order": { "tier": "compensate", "amountFrom": "/amount",
                        "undo": { "kind": "compensate", "windowSeconds": 86400,
                                  "cost": { "value": 2.5, "currency": "USD" } } },
      "send_email":   { "tier": "final",
                        "undo": { "kind": "none", "reason": "Delivered to external recipients" } },
      "export_report": { "undo": { "kind": "none", "reason": "Discloses data outside the organisation" } },
      "void_invoice_ui": { "undo": { "kind": "compensate", "via": "ui", "windowSeconds": 2592000,
                                     "reason": "Restored from the app's Voided list" } }
    },
    "keys": [ … ] } } } } }
```

| Field | Meaning |
|---|---|
| `undo.kind` | `compensate`: the effect can be reversed until the window closes. `none`: it cannot. |
| `undo.windowSeconds` | How long after the call reversal stays possible. The participant computes the exact `undoBy` per call. |
| `undo.sideEffects` | What a reversal does that others can see, in words a human can act on. Shown in the approval ask. |
| `undo.cost` | What a reversal costs, for example a cancellation fee. |
| `amountFrom` | For an operation that moves money: where the call's amount is. A JSON Pointer into the call's arguments (`"/amount"`), or `"payment"` for the `payment.maxAmount` a paid call carries (SEP §6.1). The spending caps in J§7 count it. |
| `undo.reason` | For `none`: why the effect cannot be undone. For `via: "ui"`: which feature of the app reverses it. |
| `undo.via` | `api` (default): the participant reverses the effect through an API call. `ui`: it reverses the effect by operating the app's user interface, as a computer-use tool does for apps with no API (J§4.1). |

Rules:

- `undo` describes direct calls; `tier` (§5.2) still describes behaviour inside a transaction. They can differ: a `hold` operation called directly performs its effect at once, and its `undo` says whether that effect can be reversed.
- A participant MUST NOT declare `compensate` unless it can reverse the effect until `undoBy` without the help of the agent or of anyone who received the effect. Money sent out comes back only if its recipient sends it back, so a payment, payout or refund that the participant cannot take back on its own is `none`. A charge whose undo is a refund qualifies, because the participant can issue the refund itself.
- A call that carries a `payment` (SEP §5.1) is classed by that payment, whatever its operation declares. A payment that cannot be reversed once made, such as an x402 `exact` payment, makes the call `none`.
- An operation that moves money SHOULD declare `amountFrom`. The participant writes it, so the agent cannot hide an amount by choosing where it goes.
- An operation that only reads data has no effect to reverse. A participant SHOULD declare `none` for reads that disclose data outside the organisation, so the autonomy policy (J§7) applies to them; it MAY omit `undo` for reads that do not.
- An operation with no `undo` entry, on a server that advertises the `journal` role, is treated as `unknown`.
- The Recorder validates each declaration when it reads the capability, before any call. An `undo` object with a `kind` or `via` outside the values above, or with `compensate` but no `windowSeconds`, is treated as `unknown`, and the Recorder SHOULD report it to the participant's operator.

### 4.1 Undo through the user interface

A computer-use participant acts on apps that have no API, so it has no inverse call to offer. It MAY still declare `compensate` with `via: "ui"`, under these rules:

- **The app must offer the reversal.** The undo path MUST use a feature of the app itself (delete, restore from trash, revert to a saved version), named in `undo.reason`. Replaying the agent's clicks backwards is not a reversal, and an effect the app cannot reverse is `none`.
- **Fingerprint the changed record, not the screen.** `effect.version` MUST be a fingerprint of the record the call changed, for example a hash of its accessibility-tree subtree or its visible field values, taken right after the change. Anything else on screen changes too often to compare. The participant MUST also take the same fingerprint right before the call and return it as `effect.before`, so the verify step has an exact target.
- **Check before replay.** Before reversing, the participant MUST take the fingerprint again and return `UNDO_CONFLICT` if it differs from `ifVersion` (J§8.6), changing nothing.
- **Verify after replay.** After reversing, the participant MUST fingerprint the record again and compare it with `effect.before`. If they differ, it returns `UNDO_UNVERIFIED` with what it observed, and the Recorder reports the entry as `failed` (J§8.5).
- `via: "ui"` compensations have their own autonomy setting, `ask` by default (J§7), because a user interface can change between the call and the reversal in ways a fingerprint does not catch.

---

## 5. Journaled calls

### 5.1 Request

The Recorder forwards the agent's `tools/call` and adds journal context in `_meta`:

```json
{ "method": "tools/call",
  "params": { "name": "update_deal", "arguments": { "deal": "D-881", "stage": "Won" },
    "_meta": { "hatp/journal": { "runId": "run_01JBC4…", "entryId": "e2", "seq": 2,
                                 "recorder": "mcp://gateway.acme.com/hatp" } } } }
```

### 5.2 Result

A participant with the `journal` role performs the effect and returns its undo information in the result's `_meta`:

```json
{ "content": [ … ],
  "_meta": { "hatp/journal": {
      "entryId": "e2",
      "undo": { "kind": "compensate", "undoBy": "2026-11-07T14:02:10Z" },
      "compensationToken": "ctk_9QwX…",
      "effect": { "summary": "Deal D-881 stage: Proposal → Won",
                  "resource": "crm://acme/deal/D-881", "version": "v13",
                  "uses": ["crm://acme/contact/C-17"] },
      "receipt": { "type": "hatp.receipt", "txnId": "run_01JBC4…", "branchId": "e2",
                   "callDigest": "sha256:…", "phase": "execute", "outcome": "done",
                   "issuedAt": "2026-10-31T14:02:10Z", "issuer": "mcp://crm.acme.com/hatp",
                   "signature": { … } } } } }
```

- `effect.summary` MUST be written by the participant from the actual change, not copied from agent text. It is what a human reads when deciding on a reversal (§10.3 applies).
- `effect.resource` and `effect.version` identify what was changed and its state right after the change. `version` is an ETag, revision number or content hash; it is what conflict detection compares against (J§8.6).
- `effect.uses` is OPTIONAL: the resources this call read or relied on, in the same URI form as `effect.resource`. The participant fills it from what the operation actually touched, not from agent text. An empty list declares that the call relied on nothing earlier; an absent one declares nothing (J§6.1).
- A `compensate` entry SHOULD carry `effect.version`. One that does not is **unversioned**: nothing can show whether someone changed the resource after the agent did, so it is never reversed without a human (J§7, J§8.6).
- `compensationToken` MUST be usable only by the Recorder that made the call, over an authenticated session. A leaked Run Record then reverses nothing.
- `callDigest` is `"sha256:" + base64url(SHA-256(JCS({ runId, entryId, tool, arguments })))`. The receipt uses it in place of `planDigest`, since a direct call has no plan.
- A participant whose operation has `undo.kind: none` still returns `effect` and `receipt`, with `undo` and no token.
- A call whose tool result reports an error (`isError`) is returned with `undo.kind: none` and a receipt with outcome `error`, whatever the operation declares: the participant can't vouch for reversing an effect it reports as failed.
- **At most once.** A participant MUST perform a given `runId` and `entryId` at most once. A repeat with the same `callDigest` from the same caller gets the same result, the same `compensationToken` included, without the effect happening again, including while the first attempt is still running. A repeat with another `callDigest`, or from another caller, is refused with `PLAN_INVALID`. The participant keeps what it needs for this at least as long as the entry's compensation token, and for a `none` operation at least 24 hours. This is what makes a retry safe (J§5.4). In particular:
  - the repeat is answered before any other check on the call: a gate (SEP §6) would refuse the repeat's Approval as already used by the first attempt;
  - a journaled call runs to completion once started: a client's cancellation, which some transports send when a request times out, doesn't stop it, since the Recorder will ask again for its outcome;
  - if the call ran but the participant can't describe its effect, it answers `undo.kind: none` with an `effect.summary` saying so, and never runs the call again for a repeat;
  - every connection the participant serves shares this memory: a Recorder that reconnects must still be able to repeat a call, check it, or compensate it.
- **Surviving a restart.** A participant SHOULD keep this memory, and its compensation tokens, in durable storage, so a restart doesn't turn a retry into a second effect or make its earlier calls impossible to undo. Each item is stored before anyone is told of it, as for the Recorder's log (J§6.4): the call before it runs, its answer before the answer leaves, a reversal before it runs and its receipt before the receipt leaves. Then:
  - a repeat of a call that was running when the participant stopped has no stored answer. The participant MUST NOT run it again, and answers `OUTCOME_UNKNOWN`;
  - a compensation that was running when it stopped is answered `OUTCOME_UNKNOWN` in the same way, and `check` no longer reports the entry as undoable;
  - if the participant can't store a call before running it, it refuses the call, which then didn't run. If it can't store the answer, it MUST NOT issue a compensation token for it: it answers `undo.kind: none`, with an `effect.summary` saying so, since a restart would lose the undo.
- A participant that answers a journaled call with an HATP error (§10.1) MUST NOT have performed it, except `OUTCOME_UNKNOWN`, which says it can't tell.

### 5.3 Servers that do not support the journal

If the result carries no `hatp/journal`, the Recorder records the entry with `undo.kind: "unknown"`, `effect` absent, and its own receipt (`issuer` = the Recorder). The entry is real, so humans can see it, but it is treated as irreversible.

### 5.4 Calls that never answer

A call can time out, or lose its connection, after the participant has performed it. The Recorder then can't tell whether it took effect, just as a coordinator can't for a final step in doubt (§5.3).

- **An error is not the same as no answer.** An HATP error from the participant, as the first answer to a call, means the call didn't run (J§5.2), except `OUTCOME_UNKNOWN`: that participant can't tell, and the entry is in doubt at once. The Recorder records the entry as `not-run`, with the participant's code in `reason`, and returns the error to the agent. A timeout, a lost connection or any other transport failure is no answer, and so is an attempt that takes longer than the Recorder's own limit.
- **A refusal after no answer proves nothing.** Once an attempt went unanswered, an HATP error on a later attempt doesn't show that the first one didn't run (it may be a gate refusing an Approval the first attempt used). The call is then in doubt, with both in its `reason`.
- **Retry only where it is safe.** For a call that got no answer, the Recorder retries a bounded number of times with backoff. Each retry carries the same `runId`, `entryId`, `seq`, arguments and Approvals. A server with the `journal` role performs a repeated entry at most once (J§5.2), so a retry can't repeat the effect. The Recorder MUST NOT retry a call to a server without the `journal` role, since that server may perform it twice.
- **In doubt.** If no attempt gets an answer, the Recorder records the entry with `"outcome": "in-doubt"`: a `reason`, `undo.kind: "unknown"`, no `effect` or token, and its own receipt with outcome `in-doubt`. The agent gets the transport error, and so learns that the call may have run.
- **How late a repeat may go.** A participant has to remember a call only for 24 hours, or until its undo window closes if that is later (J§5.2). After that, a repeat could run the call again. The Recorder MUST NOT send a call again once that time has passed, counted from when it logged the intent, less a margin for clock differences; the entry stays in doubt.
- **Resolution.** The Recorder MAY ask a journal server again later, within that time. If it gets the participant's result, it appends a `resolved` event to the run's chain, with `outcome: "done"` and what the participant returned (`undo`, `compensationToken`, `effect`, `receipt`), checked as at intake (J§6.1), with any problems in `intake`. Only a result resolves an entry: a refusal or no answer leaves it in doubt. The entry itself is never edited: readers apply its resolution to it. An entry is resolved at most once.
- **Late answers.** A result that comes after the call went out unanswered (a resolution, or recovery, J§6.4) may carry an `undoBy` that has already passed. The entry is then irreversible because its window closed, not unresolved.
- **How an in-doubt entry counts:**
  - **Reversal (J§8.2):** it is irreversible, and listed in `notReversible` with reason `in doubt`. Like an `unknown` entry, it doesn't block the entries that depend on it. Once resolved `done`, it is classified like any other entry.
  - **Spending caps (J§7):** its amount counts, since the money may have moved. It stays counted after resolution, as a reversed call's amount does.
  - **Review (J§6.3):** it is listed on its own, so that someone can check with the participant's operator.

---

## 6. Journal entries and the Run Record

### 6.1 Entry

```json
{ "type": "hatp.journal.entry",
  "runId": "run_01JBC4…", "entryId": "e2", "seq": 2,
  "agent": "agent://acme.com/sales-bot", "onBehalfOf": "human://acme.com/dana",
  "participant": "mcp://crm.acme.com/hatp", "tool": "update_deal",
  "callDigest": "sha256:…", "arguments": { "deal": "D-881", "stage": "Won" },
  "dependsOn": [ { "entryId": "e1", "source": "declared" } ],
  "undo": { "kind": "compensate", "undoBy": "2026-11-07T14:02:10Z" },
  "compensationToken": "ctk_9QwX…",
  "effect": { "summary": "Deal D-881 stage: Proposal → Won", "resource": "crm://acme/deal/D-881", "version": "v13",
              "uses": ["crm://acme/contact/C-17"] },
  "receipt": { … participant-signed, J§5.2 … },
  "recordedAt": "2026-10-31T14:02:10Z",
  "prevHash": "sha256:…" }
```

- `dependsOn` lists earlier entries whose results this call used, each with the `source` of the link. The Recorder builds it from these sources, most trusted first:

  | `source` | Link made when |
  |---|---|
  | `declared` | This entry's `effect.uses` contains an earlier entry's `effect.resource` (J§5.2). For example, `e1` created contact C-17 and `e2` declares it used C-17. |
  | `host` | The agent host says this call used an earlier result. |
  | `confirmed` | A reviewer confirmed an `inferred` link. The link records `confirmedBy` and `confirmedAt`. |
  | `inferred` | An argument value matches a value from an earlier result, such as an ID that call returned. |
  | `default` | Neither the participant nor the host said anything: every earlier entry in the run. |

- `default` links MUST be added for an entry unless its participant declared `effect.uses` (an empty list included) or the host supplied links. Inferred links are recorded but do not replace the default, because matching values misses implicit dependencies. The Recorder's policy MAY let them replace it, and records that choice in the run header.
- An `inferred` link never becomes `declared` automatically: only the participant's `effect.uses` produces `declared`. A human can confirm it (`confirmed`), and confirmed links count like `host` links.
- `arguments` MAY be omitted to protect privacy; `callDigest` still binds the entry to them.
- `prevHash` is the SHA-256 of the canonical form of the item recorded just before this one, entry or event (J§6.2), as in §8.5.
- `outcome` is one of:
  - `done` (the default): the call ran;
  - `not-run`: the Recorder held the call and never forwarded it (refused under `ask`, or blocked, J§7), or the participant refused it with an HATP error (J§5.4);
  - `in-doubt`: no answer came (J§5.4).

  A `not-run` entry has a `reason`, no `undo` and no participant receipt. Every entry keeps its place in `seq`.
- `approvals` holds the Approvals a call ran under (J§7), when it needed one.

**Intake checks.** The Recorder resolves each entry's references when it records it, not later at reversal time:

1. every `dependsOn` entry exists and comes earlier in the run;
2. a `compensate` entry has a `compensationToken` and an `undoBy` in the future; and
3. the participant receipt, if any, verifies and its `callDigest` matches the call.

An entry that fails a check is still recorded, never dropped, with `"intake": { "unresolved": true, "problems": ["dependsOn e9: no such entry"] }`. It blocks only the entries that depend on it; independent entries after it are unaffected. In a reversal it appears under `unresolved` (J§8.4), never silently skipped.
### 6.2 Run Record

The Recorder emits a Run Record when a run closes, and serves the current one on request (`hatp/journal/get`, J§10):

```json
{ "type": "hatp.journal.run", "hatp": "0.3",
  "runId": "run_01JBC4…", "agent": "agent://acme.com/sales-bot", "onBehalfOf": "human://acme.com/dana",
  "purpose": "Tidy up the Q4 pipeline", "recorder": "mcp://gateway.acme.com/hatp",
  "policyDigest": "sha256:…", "startedAt": "2026-10-31T14:00:02Z", "closedAt": "2026-10-31T14:06:40Z",
  "entries": [ { "type": "hatp.journal.entry", "entryId": "e1", "seq": 1, … }, { … "seq": 2 … } ],
  "events": [
    { "type": "reviewed", "by": "human://acme.com/dana", "at": "2026-10-31T17:20:00Z", "prevHash": "sha256:…" },
    { "type": "reversal", "reversalId": "rev_01JBD0…", "recordDigest": "sha256:…",
      "outcomes": { "e5": "reversed", "e2": "reversed" }, "at": "2026-10-31T15:52:10Z", "prevHash": "sha256:…" },
    { "type": "remedy", "txnId": "txn_01JBD7…", "remedies": "e4", "at": "2026-11-01T09:10:00Z", "prevHash": "sha256:…" }
  ],
  "spend": { "perRun": [ { "value": 120, "currency": "USD" } ] },
  "issuedAt": "2026-11-01T09:10:00Z",
  "signature": { … } }
```

- `entries` are in `seq` order, gap-free from 1. `scope.from` (J§8.1) counts in `seq`.
- `events` are what happened to the run after its entries were recorded:
  - `reviewed`: an acknowledgement (J§6.3);
  - `reversal`: a reversal and each entry's outcome (J§8.5). `recordDigest` is the digest of the Reversal Record, which is kept separately;
  - `remedy`: a linked transaction (J§8.7);
  - `resolved`: how an in-doubt entry turned out (J§5.4).
- **One chain.** Entries and events form a single hash chain in the order the Recorder recorded them: each item's `prevHash` is the SHA-256 of the canonical form of the item recorded just before it, whether that was an entry or an event. The first item's `prevHash` is the digest of the run header (the record without `entries`, `events`, `spend`, `closedAt`, `issuedAt` and `signature`).
- `spend` holds the running totals the caps in J§7 count, per currency.
- The Recorder signs the whole record, without `signature`, each time it issues it. `closedAt` is absent while the run is open.

Anyone holding the record and the public keys can verify offline that:

1. each entry with a participant receipt was performed by that participant with exactly those arguments (`callDigest`);
2. no entry was removed or reordered (`seq` is gap-free and `prevHash` chains);
3. each resolution follows an in-doubt entry, is the only one for it, and carries that participant's receipt for that call; and
4. every reversal was approved over a plan listing exactly the entries it compensated (J§8.4).

### 6.3 Review before windows close

Undo windows close silently, so the Recorder SHOULD send the principal a review when a run closes: what the agent did, which entries can still be reversed and until when, and which cannot.

The review shows the state when it is read, not when it was sent. Entries in doubt (J§5.4) are listed apart from the rest, since nobody yet knows whether there is anything to undo. Each entry carries its own `undoBy`, fixed when it was recorded, so the review lists reversible entries by `undoBy`, earliest first, each with the time left, and marks entries whose window has closed as closed. It is a countdown to triage, not a log to reconstruct. A review delivered as a message, such as an email, SHOULD link to the live view and state when it was generated.

While a run is unreviewed, the Recorder SHOULD send a reminder before each open window closes, not only the earliest. Windows that end around the same time MAY share one reminder. A run that has not closed yet counts as unreviewed, so a long run still gets reminders. The organisation's policy sets the timing:

```json
{ "review": { "remindBeforeSeconds": 28800, "escalateBeforeSeconds": 7200 } }
```

| Field | Meaning |
|---|---|
| `remindBeforeSeconds` | How long before `undoBy` to send the reminder. If that moment has already passed when the entry is recorded, the reminder goes at once. |
| `escalateBeforeSeconds` | How long before `undoBy` to send the reminder to the policy's `approver` (J§7) as well, if the run is still unreviewed. |

A Recorder whose policy sets `review` MUST send what it configures. Without `review`, the Recorder chooses the lead time and does not escalate.

Each reminder and escalation the Recorder sends is appended to the run's hash chain as a `reminded` event, stored before it is sent (J§6.4): `to` (`principal` or `approver`), `recipient` (their address, when known), `reason`, the `entries` it was about, and `at`. A window that closed after the principal was reminded and the approver escalated to is then something an audit can read, signed with the rest of the run, and different from one that closed with nobody told. A Recorder that recovers from its log doesn't send a reminder that is already chained. If the event can't be stored, the reminder is still sent: telling the person matters more than the record of it.

An in-doubt entry that resolves (J§5.4) into one that can be undone, with its window still open, has never been reviewed as reversible, even if the run was acknowledged while it was in doubt. The Recorder SHOULD tell the principal at once, with `reason: "resolved"`, rather than only before the window closes. Its reminders then follow the timing above, counted from the resolution.

A run is **reviewed** when the principal or the `approver` acknowledges its review. Acknowledging says only that someone looked; it approves nothing and closes no window. The Recorder appends who acknowledged and when to the Run Record's hash chain, and sends no further reminders for entries recorded before that time.

### 6.4 The Recorder's log and recovery

A Recorder that crashes must lose no entry and break no chain. It keeps a durable log, and stores each item before acting on it:

| Item | Stored before |
|---|---|
| The run header | the `runId` is returned |
| An **intent**: `runId`, `entryId`, `seq`, participant, tool, arguments, `callDigest`, the Approvals, and the amount counted against caps | the call is forwarded |
| Each entry and event, as chained | anyone is told about it, by a tool result or a Run Record |
| The run's close | the closing Run Record is issued |
| A reversal's decision: the Plan and its digest, the approvals and receipts so far, the signed decision, and the Reversal Record's events | the first compensation |

The intent keeps the arguments even when entries omit them (J§6.1), because a retry must send exactly the same call. The log falls under the organisation's retention policy, like Run Records (J§12).

**A failed write stops the run.** If the log can't store an entry or event, the Recorder holds it in neither its log nor its chain, so it MUST NOT take further calls, reversals or acknowledgements for that run until it restarts and recovers: carrying on would give the next call the same `seq`. The call that went out is finished by recovery, from its intent.

On restart, the Recorder recovers each run from its log, and refuses any run whose log fails a check, without repairing it. The other runs are recovered.

1. **The chain.** It rebuilds the run item by item, and checks that:
   - the run header names this Recorder;
   - each `prevHash` matches the item before it, and `seq` is gap-free;
   - each entry that went out matches the intent logged for it (participant, tool, `callDigest`), which also catches a change to the last item, which no `prevHash` covers;
   - there is one intent per entry, and at most one call (the next one) was in flight.

   The chain shows corruption, not tampering: whoever can rewrite the log can rewrite all of it. The Run Record's signature and the participants' receipts are what an auditor relies on (J§6.2).
2. **What the chain implies.** It restores the spending totals from the intents (J§7), which entries were reversed, the latest acknowledgement, and the reminders for windows still open (J§6.3).
3. **A call in flight.** An intent with no entry is a call that may have run. A run has at most one, since its calls are recorded one after another. For a server with the `journal` role, the Recorder sends the call again (J§5.4) and records the entry from the result. A refusal or no answer leaves it in doubt, since the call already went out unanswered. For any other server, or one no longer configured, it records the entry in doubt without sending it again. So it does when the Recorder was down longer than the participant has to remember the call (J§5.4).
4. **A reversal in flight.** A reversal whose decision is logged, but whose `reversal` event isn't in the chain, is finished:
   - the Recorder adds a `recovered` event to the Reversal Record;
   - it compensates every branch again, in Plan order. `compensate` is idempotent (§7.4), so a branch already reversed returns its receipt.

   A reversal that wasn't yet decided at the crash is abandoned. Nothing was compensated, and whoever asked can ask again.

The recovered entries keep the run's `seq` and chain, so a recovered Run Record verifies like any other.

---

## 7. Reversibility-gated autonomy

Before forwarding a call, the Recorder checks the operation's `undo.kind` against its policy:

```json
{ "autonomy": { "compensate": "allow", "compensateViaUi": "ask", "unknown": "ask", "none": "ask",
                "minWindowSeconds": 259200,
                "requireExercisedUndo": true,
                "exercisedUndo": ["mcp://crm.acme.com/hatp#update_deal"],
                "spend": { "perRun": { "value": 500, "currency": "USD" },
                           "perPeriod": { "value": 2000, "currency": "USD", "periodSeconds": 604800 } },
                "overrides": { "mcp://wiki.acme.com/hatp#search": "allow" },
                "approver": "human://acme.com/role/team-lead",
                "askAction": "approve.agent-call", "askDecideSeconds": 3600 } }
```

| Value | Effect |
|---|---|
| `allow` | Forward and journal the call. |
| `ask` | Hold the call and ask for approval of exactly this call with `hatp/ask/approve` (SEP §5). Forward it only once it is approved. |
| `block` | Refuse the call with `UNDO_POLICY_BLOCKED` (J§11). |

`compensateViaUi` applies to operations declared `compensate` with `via: "ui"` (J§4.1); it defaults to `ask`.

`minWindowSeconds` sets the shortest undo window that earns autonomy. An undo protects no one if the window closes before anyone looks, so an operation declared `compensate` with a shorter `undo.windowSeconds` is handled as `ask` where its setting would be `allow`. A stricter setting stands, and an entry in `overrides` takes precedence as usual. An organisation SHOULD set the value from how quickly its runs are actually reviewed, which the Run Records show (J§6.3). Without it, there is no minimum.

`requireExercisedUndo` asks for evidence that an undo works before it earns autonomy. A declared `compensate` is only the participant's word: a server can declare an undo that fails. With it set, a `compensate` operation is handled as `ask` where its setting would be `allow`, until its undo has been **exercised**: the operation is listed in `exercisedUndo` (for example after passing the conformance suite), or the Recorder has completed a reversal of one of its entries with outcome `reversed`. Calls under `ask` still run once approved, so an operation can earn its first reversal. A failed or unknown reversal exercises nothing. Without the setting, a declaration is enough, as before.

`spend` caps the money an agent moves. Reversible is not the same as bounded: under `"compensate": "allow"` alone, an agent could call `charge_order` any number of times without an ask. A policy that allows a class of calls works as a standing approval, so like one (SEP §6.1) it keeps a running total:

- `perRun` caps one run, so the worst case is known before the run starts. `perPeriod` caps all runs for the same `onBehalfOf` over a rolling `periodSeconds`, since an agent can start many runs. A policy MAY set either or both, each per currency.
- The Recorder adds the amount of every forwarded call whose operation declares `amountFrom`, including calls approved through `ask`. A reversed call still counts: the cap bounds what was moved, not what remains. So does a call in doubt (J§5.4), whose money may have moved.
- A call that would take a total past its cap is handled as `ask`, and the ask shows the totals so far. So is a money-moving call whose amount can't be read, or whose currency has no cap where another currency does. Amounts are never converted. The gateway checks authority against the amount in the call (`amountFrom`), so an ask for an amount it can't read, or in a currency no approver holds authority in, fails, and the call doesn't run.
- The totals are recorded in the Run Record, so a reviewer sees how close a run came to its caps.

`unknown` is a property of an **operation**, not of the agent: an agent that calls one unknown tool keeps its autonomy for every other tool. An operation stops being `unknown` for future calls when its participant adds journal support and declares `undo`, or when the organisation, after reviewing it, adds an entry to `overrides` (keyed `<participant>#<operation>`). Overrides take precedence over the class-wide settings and are covered by the policy digest. Neither route changes past entries: they stay `unknown`, because no compensation token was ever issued for them. What remains possible for a past `unknown` entry is a remedy: a linked transaction with its own plan and approval (J§8.7).

An operation declared `compensate` whose participant does not return `effect.version` for it is treated as `unknown` for this check: being able to reverse it is not enough if the reversal could overwrite someone's newer work.

**Asking.** For `ask`, the Recorder sends `hatp/ask/approve` to its Human Gateway:

- `action` is `{ "type": "mcp.tools/call", "server": <participant>, "tool", "arguments" }`, plus `payment` for a paid call. The approval binds this exact call through its action digest, so the agent can't change the arguments after the human has seen them.
- `address` is the policy's `approver`, which is REQUIRED when any setting is `ask`. `requirement` is `{ "action": <askAction>, "amountFrom": <the operation's amountFrom> }`, so the gateway checks authority against the amount in the call. `askAction` defaults to `approve.agent-call`.
- `decideBy` is `askDecideSeconds` from now (default 3600). `purpose` is the agent's stated reason, which the gateway labels as agent-written.
- The Recorder passes the run's `onBehalfOf` to the gateway as the requester's principal. The gateway excludes them (SEP §5.2, step 2): **the person an agent acts for never approves that agent's call.** A policy that wants every `ask` to reach someone names an `approver` that isn't only that person.
- On `approve`, the Recorder forwards the call with the Approvals in `_meta["ai.probita/human-gateway"].approvals`. A participant that gates the tool checks them (SEP §6). One that doesn't still runs only because the Recorder forwarded the call. The entry records the Approvals in `approvals`.
- On `reject`, `DEADLINE_EXCEEDED` or any other failure, nothing is forwarded. The Recorder records the entry with `"outcome": "not-run"` and the reason, and returns that reason to the agent as the tool error. A refused call stays in the journal, so a reviewer can see what the agent tried.

A call that is part of a multi-step plan is a transaction (§5) rather than a run of asks, and the coordinator records it as in J§9.

The policy belongs to the organisation. An agent MUST NOT be able to change it, and the Recorder SHOULD record the policy's digest in the run header.

---

## 8. Reversal

### 8.1 Request

A human (through any UI), an agent, or an automated monitor asks the Recorder to reverse part of a run:

```json
{ "method": "hatp/journal/reverse",
  "params": { "runId": "run_01JBC4…", "scope": { "from": 2 },
              "requestedBy": "human://acme.com/dana",
              "reason": "Wrong deal; the customer has not signed" } }
```

`scope` is either `{ "from": seq }` (this entry and everything after it) or `{ "entries": ["e2", "e5"] }`.

### 8.2 The reversal set

The Recorder expands the request:

1. Start with the requested entries.
2. Add every later entry that depends on one of them, transitively (`dependsOn`, J§6.1). Undoing e2 while keeping e5, which was built on e2's result, would leave e5 pointing at something that no longer exists. The Reversal Plan shows why each added entry is there, with the link's `source`, so the approver can tell a declared dependency from a guessed one.
3. Split the result into **reversible** entries (`compensate`, window still open), **irreversible** ones (`none`, `unknown`, in doubt (J§5.4), or window closed), and **unresolved** ones (failed an intake check, J§6.1). An unresolved entry is not compensated, and neither is anything that depends on it.
4. List the **readers since**: entries in *other* runs, recorded after a reversed entry, whose `effect.uses` names its `effect.resource` (`declared`) or whose arguments reference it (`inferred`). They read the value the reversal is about to change. Nothing in this list is reversed. It tells the approver whom to notify, the way `sideEffects` does. The Recorder can list only calls that passed through it. That includes an agent's memory when the memory is a tool server reached through the Recorder: a recall is an ordinary entry, and its `effect.uses` puts it in this list like any other read. What an agent keeps to itself, in its context or a store the Recorder doesn't front, is outside its view. The Recorder can't tell that a reader is missing, so the agent host or the organisation declares, per agent, whether its memory passes through the Recorder: `recorded`, `unrecorded`, or `unknown`, the default. The Plan's `unseenMemory` names each agent active since the earliest change, the run's own agent included, whose memory isn't `recorded`: for those, the readers-since list may be incomplete, and the Plan says so instead of implying the list is whole.

### 8.3 Check

For each reversible entry, the Recorder SHOULD call `hatp/journal/check` (J§10) on its participant. The participant reports, without changing anything, whether the reversal would succeed now: window still open, resource unchanged since `effect.version`, and any `sideEffects` or `cost`. A participant that does not implement `check` is assumed undoable until `undoBy`, with conflicts surfacing at compensation time.

### 8.4 Reversal Plan and approval

The Recorder builds a **Reversal Plan**, a v0.1 Plan (§5.1) with these differences:

```json
{ "hatp": "0.3", "txnId": "rev_01JBD0…", "reversalOf": "run_01JBC4…",
  "initiator": "mcp://gateway.acme.com/hatp", "onBehalfOf": "human://acme.com/dana", "requestedBy": "human://acme.com/dana",
  "purpose": "Wrong deal; the customer has not signed",
  "deadline": "2026-10-31T16:00:00Z",
  "branches": [
    { "branchId": "undo-e5", "participant": "mcp://calendar.acme.com/hatp", "tier": "compensate",
      "operation": { "undo": "e5", "ifVersion": "evt-3" },
      "effect": "Cancel 'Kickoff with Globex' on Nov 4", "sideEffects": ["Attendees receive a cancellation notice"] },
    { "branchId": "undo-e2", "participant": "mcp://crm.acme.com/hatp", "tier": "compensate",
      "operation": { "undo": "e2", "ifVersion": "v13" },
      "effect": "Deal D-881 stage: Won → Proposal" }
  ],
  "notReversible": [
    { "entryId": "e4", "reason": "Delivered to external recipients", "summary": "Email to buyer@globex.com" }
  ],
  "unresolved": [
    { "entryId": "e6", "problems": ["dependsOn e9: no such entry"], "summary": "Update task T-12" }
  ],
  "readSince": [
    { "runId": "run_01JBC9…", "entryId": "e3", "agent": "agent://acme.com/forecast",
      "source": "declared", "summary": "Q4 forecast report counted D-881 as Won" }
  ],
  "unseenMemory": [ { "agent": "agent://acme.com/sales-bot", "memory": "unknown" } ],
  "approvals": [ { "groupId": "undo", "address": "human://acme.com/role/team-lead", "quorum": { "required": 1 },
                   "requirement": { "action": "approve.undo" }, "decideBy": "2026-10-31T15:45:00Z" } ] }
```

- `initiator` is the Recorder. `requestedBy` is whoever asked for the reversal (J§8.1). `onBehalfOf` equals `requestedBy` when a human asked, and is omitted when an agent or a monitor asked. The gateway excludes `onBehalfOf` from approving as for any Plan (§6.3), so **whoever asks for a reversal never approves it.**
- Branches are in reversal order: latest entry first.
- `operation.undo` names the entry; `ifVersion` is the entry's `effect.version`. Every branch MUST carry exactly one of `ifVersion` or `"force": true`. `force` is allowed only to override a conflict that a check reported, or for an unversioned entry, and the ask MUST say which (J§8.6).
- `notReversible` lists every irreversible entry in the reversal set, so the human approves knowing what will remain.
- `unresolved` lists entries the Recorder could not resolve (J§6.1), with their problems, kept apart from `notReversible`: "the participant says this cannot be undone" and "the record is broken here" call for different follow-up.
- `readSince` lists the readers since (J§8.2), with each link's `source`. Gateways show it as "these used the value being changed".
- `unseenMemory` lists the agents for which `readSince` may be incomplete (J§8.2). Gateways show it as "these agents may still hold the value being undone, where nobody can see it".
- The Recorder sends `hatp/txn/prepare` with the Reversal Plan **only to Human Gateways**. Resource branches are not prepared; `check` (J§8.3) took prepare's place. Gateways render the ask from the structured Plan as usual, including `sideEffects`, `cost` and `notReversible`.
- Approval is REQUIRED when any branch has `sideEffects` or `cost`, any entry is in `notReversible` or `unresolved`, a branch sets `force` or reverses a `via: "ui"` entry, or `requestedBy` is not the run's `onBehalfOf`. Otherwise the Recorder's policy MAY let the principal's own request stand as the approval, and records that in the Reversal Record. A non-empty `readSince` does not by itself require approval, but the Gateway MUST show it whenever there is an ask.

**Who may undo.** Authority is checked when the reversal is approved, not inherited from when the call ran: weeks later, the person may have changed roles. The organisation's policy sets it:

```json
{ "undoAuthority": { "default": "current", "originator": true,
                     "elevated": { "when": ["multiParticipant", "force", "ui"],
                                   "approver": "human://acme.com/role/ops-admin" } } }
```

- `current` (the default and the minimum): every approver must hold, at approval time, the authority the original calls needed. The Human Gateway checks it as for any approval (§10.2).
- `originator: true` also lets the run's `onBehalfOf` approve reversing their own entries when someone else asked for it (a monitor, or a colleague who spotted the mistake), provided they still hold an active identity in the organisation. When the principal asks for the reversal themselves, they are its `onBehalfOf` and the approval comes from someone else. Where approval isn't required (above), their own request stands.
- `elevated` names the conditions under which the reversal needs the `elevated.approver` group instead: `multiParticipant` (the reversal set spans more than one participant), `force` (any branch sets it), `ui` (any `via: "ui"` branch). These are the reversals where working out the correct state afterwards is hardest.

### 8.5 Execution

After approval, the Recorder logs the decision durably (J§6.4) and calls `hatp/txn/compensate` for each branch in Plan order, with `txnId` = the run's `runId`, `branchId` = the entry's `entryId`, `planDigest` = the Reversal Plan's digest, the entry's `compensationToken`, and `ifVersion` or `force`. The participant's receipt carries that `planDigest`, so it binds the reversal the human approved.

A compensation can fail. When it does, the Recorder:

1. MUST NOT compensate any entry that the failed entry depends on, transitively: the failed entry's effect is still live and may need them;
2. continues with the remaining independent branches; and
3. ends the reversal in `NEEDS_ATTENTION`, listing each entry as `reversed`, `failed` (with the participant's error), `skipped` (with the entry that blocked it), or `unknown` (see below).

Reversal states reuse §6.1: `PREPARING` (waiting for approval), `ABORTED` (declined or deadline passed; nothing was compensated), `COMMITTING` (compensating), `COMMITTED` (every reversible branch reversed), `NEEDS_ATTENTION`. A compensation that gets no answer is retried, since `compensate` is idempotent (§7.4); if it stays unanswered, the entry is reported as `unknown`. So is one the participant answers `OUTCOME_UNKNOWN`, and one refused after an attempt that got no answer: the refusal can't show that the earlier attempt didn't reverse it (an `UNDO_CONFLICT`, say, may come from that attempt's own change).

The result is a **Reversal Record** in the Transaction Record format (§8.5). The Recorder appends a reference to it, and each entry's outcome, to the Run Record's hash chain. For each reversed entry, the Reversal Record keeps the participant's compensate receipt with its `detail.effect` (J§10.4): the version found, the version left, and the side effects that occurred. The reversal is its own signed change set beside the original run: nothing in the Run Record is edited, so a partial undo stays auditable as exactly what it changed.

A verifier checks a Reversal Record as a Transaction Record (§8.5), with three differences. Resource branches have no prepare receipt, since `check` took its place. Check receipts carry the entry's `callDigest`, because they come before the Plan. A `COMMITTED` reversal needs, for each branch, the participant's compensate receipt with outcome `reversed` under the Plan's digest. When the principal's own request stood as the approval (J§8.4), the record says so with an `approved-by-request` event in place of Approvals.

### 8.6 Conflicts with newer work

Between the agent's call and the reversal, a person may have edited the same record. Blindly restoring the old state would destroy their work.

- A participant receiving `compensate` with `ifVersion` MUST compare it with the resource's current version and, if they differ, return `UNDO_CONFLICT` with the current version and a summary of what changed, without changing anything.
- `check` reports the same conflict ahead of time. The Recorder then puts the branch in the Reversal Plan only if the human chooses to override it (`force: true`, shown in the ask as overwriting the newer change), or leaves it out and lists it in `notReversible` with reason `conflict`.
- A participant MAY return `UNDO_CONFLICT` for `force` too, when its own rules forbid overwriting (for example a closed accounting period).
- **No version, no automatic rollback.** An unversioned entry (J§5.2) can only be reversed by a `force` branch, so approval is always required (J§8.4). The ask MUST say that newer changes to the resource cannot be detected and would be overwritten.
- Conflict detection relies on `ifVersion`, not on dependency inference (J§8.2): a dependency missed between two tools leaves the compensations in the wrong order, but the version check still stops each one from overwriting newer work.

### 8.7 Irreversible entries

For each entry in `notReversible`, the Reversal Record lists what may help, without doing any of it: a remedy the participant suggests through `check` (for example "send a correction email"), or a **linked transaction**: a new HATP transaction with `recoveryOf` set to the `runId`, its own plan and its own approval. As in §6.5, a corrective action is a new action that needs fresh consent.

A linked transaction is journaled like any other: its Transaction Record names `recoveryOf` and the entry it remedies (`remedies: "e4"`), and the Recorder appends a reference to it in the original Run Record's hash chain. The path from an entry that could not be undone to what was done about it stays auditable.

---

## 9. Undo after a transaction commits

A coordinator MAY also act as a Recorder. After a transaction commits, it records each branch as an entry of a run whose `runId` is the `txnId`:

- `compensate` branches become `compensate` entries using the `compensationToken` from their commit (§7.3), with `undoBy` from the participant's `undo.windowSeconds`;
- the `final` branch becomes an entry with `undo.kind: "none"`, unless its operation declares otherwise;
- `hold` branches, now converted into their effects, follow their operation's `undo` declaration.

Reversing that run (J§8) is how a human takes back a transaction that committed but should not have. HATP v0.1 compensates only when a transaction fails partway; this extends the same tokens to after success.

---

## 10. Methods

### 10.1 `hatp/journal/get` (Recorder)

`{ "runId" }` → the current Run Record (J§6.2). Recorders MUST authorise callers: by default the run's `onBehalfOf`, the approvers named in its policy, and auditors.

### 10.2 `hatp/journal/reverse` (Recorder)

Request as in J§8.1. Returns `{ "reversalId", "state": "PREPARING", "plan", "planDigest" }`, or `{ "state": "NOTHING_TO_REVERSE", "notReversible": [ … ], "unresolved": [ … ] }` when the reversal set has no reversible entry. Progress and the final Reversal Record come through `hatp/txn/status` with `txnId` = `reversalId`.

### 10.3 `hatp/journal/check` (participant)

`{ "runId", "entryId", "compensationToken", "ifVersion" }` →

```json
{ "undoable": false, "undoBy": "2026-11-07T14:02:10Z",
  "conflict": { "currentVersion": "v15", "summary": "Stage changed to Negotiation by human://acme.com/eve at 15:10" },
  "sideEffects": [], "cost": null,
  "remedy": null,
  "receipt": { … phase "check" … } }
```

Changes nothing. OPTIONAL: a participant that does not implement it answers "method not found" (§9).

### 10.4 `hatp/txn/compensate` (extended)

v0.1 parameters plus `ifVersion` (string) or `force` (boolean), never both. Without either, behaviour is as in v0.1; that is only for compensating a transaction that failed partway (§7.3). When compensating a journal entry (J§8.5), the Recorder MUST send one of them, and a participant that supports the journal MUST refuse a call that has neither with `UNDO_VERSION_REQUIRED`, changing nothing. It MUST honour `ifVersion` (J§8.6).

When it compensates a journal entry, its signed compensate receipt MUST carry `detail.effect`, what the reversal actually did:

```json
{ "type": "hatp.receipt", "txnId": "run_01JBC4…", "branchId": "e5", "planDigest": "sha256:…", "phase": "compensate", "outcome": "reversed",
  "detail": { "effect": {
      "summary": "Cancelled 'Kickoff with Globex' on Nov 4",
      "resource": "calendar://acme/event/E-55",
      "versionBefore": "evt-3", "version": "evt-4",
      "sideEffects": ["Cancellation notice sent to 3 attendees"] } },
  "issuer": "mcp://calendar.acme.com/hatp", "signature": { … } }
```

- `versionBefore` is the version the participant found when it ran the reversal. With `ifVersion` it equals `ifVersion`; with `force` it records the newer work that was overwritten.
- `version` is the resource's version after the reversal, so a later reversal or conflict check (J§8.6) compares against the state the reversal left, not the state the agent left. An unversioned resource omits both.
- `sideEffects` lists the effects that actually occurred, written by the participant. They can differ from those the Reversal Plan announced: fewer attendees notified, or a fee waived. An empty list says none occurred.
- `summary` follows the rules for `effect.summary` (J§5.2).

---

## 11. Errors

New `hatpCode` values (§10.1):

| `hatpCode` | Meaning |
|---|---|
| `UNDO_WINDOW_CLOSED` | `undoBy` has passed; the effect can no longer be reversed |
| `UNDO_CONFLICT` | The resource changed since the entry's `effect.version`; `data` carries the current version and a summary |
| `UNDO_VERSION_REQUIRED` | A journal compensation carried neither `ifVersion` nor `force` (J§10.4) |
| `UNDO_UNVERIFIED` | A `via: "ui"` reversal ran but the participant could not confirm the record's earlier state; `data` carries what it observed (J§4.1) |
| `UNDO_POLICY_BLOCKED` | The Recorder's autonomy policy blocks this call (J§7) |
| `OUTCOME_UNKNOWN` | The participant can't tell whether the call or compensation took effect: it was running when the participant stopped (J§5.2). The only HATP error that doesn't mean "not performed" |
| `RUN_UNKNOWN` | No such run, or the caller may not see it |

---

## 12. Security and privacy

| Threat | Mitigation |
|---|---|
| Agent skips the journal by calling tool servers directly | The Recorder SHOULD be the only network path from the agent to its tool servers, and SHOULD run outside the agent's control. A participant MAY refuse direct calls from agent identities that lack `hatp/journal` context. |
| Stolen compensation token used to destroy work | Tokens are bound to the Recorder's authenticated session (J§5.2); participants MUST reject them from anyone else. |
| Malicious reversal of legitimate work | Reversals are approved Plans; approval is required when someone other than the principal asks (J§8.4); the Human Gateway enforces separation of duties (§10.2). |
| Reversal overwrites newer human edits | Every journal compensation carries `ifVersion` or `force`; `force` only after a human sees the conflict or is told the entry is unversioned (J§8.6, J§10.4). Unversioned operations are not run without asking (J§7). |
| Recorder hides or reorders entries | Gap-free `seq`, `prevHash` chain, and participant-signed receipts the Recorder cannot forge (J§6.2). |
| A Recorder crash loses entries or repeats calls | Intents are logged before calls are forwarded, and recovery rebuilds and checks the chain (J§6.4). Only journal servers, which perform an entry at most once, are ever sent a call twice (J§5.4). |
| A timed-out call is reported as reversible, or as never having run | It is recorded in doubt with the Recorder's receipt only; only the participant's own answer resolves it (J§5.4). |
| Agent text in the ask misleads the approver | Summaries come from participants' `effect.summary`; agent-written `reason` is labelled as such (§10.3). |
| Run Records leak personal data | `arguments` MAY be omitted (J§6.1); Recorders SHOULD apply the organisation's retention policy and restrict `hatp/journal/get` (J§10.1). |

---

## 13. Changes to v0.1

These are folded into [hatp-v0.1.md](hatp-v0.1.md), which points back here for the details:

- §9 capability: per-operation `undo` object; roles `journal` (participant) and `recorder`.
- §7.4 `hatp/txn/compensate`: `ifVersion` and `force`, one of them required when compensating a journal entry.
- §8.3 Receipt: `phase` values `execute` and `check`; `callDigest` allowed in place of `planDigest` for journaled calls; a compensate receipt for a journal entry carries `detail.effect` (J§10.4).
- §5.1 Plan: optional `reversalOf`, `notReversible`, and per-branch `operation.undo`, `effect` and `sideEffects` for Reversal Plans; `recoveryOf` may name a `runId`.
- §10.1: the error codes in J§11.

---

## 14. Open issues

1. **Dependency capture.** Participants can now declare `effect.uses`, and every link records its `source` (J§6.1). Still open: when, if ever, inferred links should replace the default, and how much evidence is enough, for example a matching ID versus any matching value.
2. **Partial reversibility.** A refund minus a fee is modelled as `cost`. Effects that reverse only in part (a message recalled for internal recipients but not external ones) may need per-recipient undo.
3. **Redo.** Reversing a reversal is out of scope; a corrective action is a new run.
4. **Long windows.** Authority is now re-checked at reversal time (`undoAuthority`, J§8.4). Still open: whether a role change should also notify the people whose runs can still be reversed.
5. **Effect previews.** v0.3 also plans dry-run diffs for `compensate` and `final` tiers. The same `effect` object could describe a call before it happens and the change after it, so asks and reversals show one format.
6. **Review calendars.** `minWindowSeconds` (J§7) is a fixed proxy for review time, so a Friday evening run and a Tuesday morning run are treated alike. Comparing `undoBy` with the next time someone is on duty would be more exact, but it puts a review calendar into the policy.
7. **Self-confirmation.** Under `ask` (J§7), the principal never approves their own agent's call, so a person working alone needs a second approver for every irreversible call. A confirmation by the principal (an Answer to "send this email?") would be lighter, but it isn't an approval, and it is what an injected agent could most easily talk its user into. Is there a safe form of it?
8. **Caps and reversals.** A reversed call still counts toward `spend` (J§7). Whether a completed reversal should free that room again, and over what period, is open.
9. **Remembering calls.** A participant keeps what makes a repeated entry safe (J§5.2) at least as long as its tokens. The reference binding keeps both in `journalState`, shared by its connections, and since 0.3.1 in a durable store when one is given (`JournalFileStore`). A store on one machine still doesn't serve a participant that runs as several replicas: they would need one shared store, with a call's `started` item written atomically, so two replicas can't both run the same entry.
10. **When an exercised undo stops counting.** An operation stays exercised for the Recorder's lifetime (J§7). A participant that changes its implementation may break an undo that once worked, and the capability carries no version that would reset it. Should `exercisedUndo` expire, or be tied to a declared implementation version?
