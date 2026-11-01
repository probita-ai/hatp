# HATP Journal: undo for agents — Draft

**Status:** Working draft. Not stable. Breaking changes expected.
**Date:** 2026-10-31
**Target:** HATP v0.3. Builds only on v0.1 features ([hatp-v0.1.md](hatp-v0.1.md)); references written §5.2 point to that document; references written J§5.2 point to this one.
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
2. **Autonomy is granted by reversibility.** An agent may act freely on what can be undone. Before an effect that cannot be undone, the Recorder turns the call into an HATP transaction with a human approval (J§7). Your organisation sets this policy, not the agent.

### 1.1 Design goals

- **Works with any MCP server on day one.** A server that knows nothing about HATP still gets journaled; its calls are recorded as `unknown` and treated as irreversible. A server becomes reversible by returning two values from its existing tools.
- **Undo is a decision, not a button.** Reversing work can destroy newer work or notify outsiders, so a reversal is a Plan that a human approves, routed by the Human Gateway like any other ask (§6.3).
- **Never overwrite newer human work.** A compensation only applies if the resource is still in the state the agent left it in (J§8.6).
- **Honest about what cannot be undone.** Irreversible effects are recorded with the reason. Recovery for them is offered, never performed (as in §6.5).

### 1.2 Non-goals

Undoing reads (a disclosure cannot be taken back; J§4), redo, reversal across organisations without a pre-existing trust relationship (v0.1 open issue 2), and effects that happen outside any tool call.

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
{ "capabilities": { "experimental": { "hatp": {
    "version": "0.3",
    "roles": ["participant", "journal"],
    "operations": {
      "update_deal": { "tier": "compensate",
                       "undo": { "kind": "compensate", "windowSeconds": 604800 } },
      "create_event": { "tier": "compensate",
                        "undo": { "kind": "compensate", "windowSeconds": 2592000,
                                  "sideEffects": ["Attendees receive a cancellation notice"] } },
      "refund_order": { "tier": "compensate",
                        "undo": { "kind": "compensate", "windowSeconds": 86400,
                                  "cost": { "value": 2.5, "currency": "USD" } } },
      "send_email":   { "tier": "final",
                        "undo": { "kind": "none", "reason": "Delivered to external recipients" } },
      "export_report": { "undo": { "kind": "none", "reason": "Discloses data outside the organisation" } },
      "void_invoice_ui": { "undo": { "kind": "compensate", "via": "ui", "windowSeconds": 2592000,
                                     "reason": "Restored from the app's Voided list" } }
    },
    "keys": [ … ] } } } }
```

| Field | Meaning |
|---|---|
| `undo.kind` | `compensate`: the effect can be reversed until the window closes. `none`: it cannot. |
| `undo.windowSeconds` | How long after the call reversal stays possible. The participant computes the exact `undoBy` per call. |
| `undo.sideEffects` | What a reversal does that others can see, in words a human can act on. Shown in the approval ask. |
| `undo.cost` | What a reversal costs, for example a cancellation fee. |
| `undo.reason` | For `none`: why the effect cannot be undone. For `via: "ui"`: which feature of the app reverses it. |
| `undo.via` | `api` (default): the participant reverses the effect through an API call. `ui`: it reverses the effect by operating the app's user interface, as a computer-use tool does for apps with no API (J§4.1). |

Rules:

- `undo` describes direct calls; `tier` (§5.2) still describes behaviour inside a transaction. They can differ: a `hold` operation called directly performs its effect at once, and its `undo` says whether that effect can be reversed.
- A participant MUST NOT declare `compensate` unless it can reverse the effect without the agent's help until `undoBy`.
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

### 5.3 Servers that do not support the journal

If the result carries no `hatp/journal`, the Recorder records the entry with `undo.kind: "unknown"`, `effect` absent, and its own receipt (`issuer` = the Recorder). The entry is real, so humans can see it, but it is treated as irreversible.

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
- `prevHash` is the SHA-256 of the previous entry's canonical form, as in §8.5.

**Intake checks.** The Recorder resolves each entry's references when it records it, not later at reversal time:

1. every `dependsOn` entry exists and comes earlier in the run;
2. a `compensate` entry has a `compensationToken` and an `undoBy` in the future; and
3. the participant receipt, if any, verifies and its `callDigest` matches the call.

An entry that fails a check is still recorded, never dropped, with `"intake": { "unresolved": true, "problems": ["dependsOn e9: no such entry"] }`. It blocks only the entries that depend on it; independent entries after it are unaffected. In a reversal it appears under `unresolved` (J§8.4), never silently skipped.
### 6.2 Run Record

The Recorder emits a Run Record when a run closes, and serves the current one on request (`hatp/journal/get`, J§10): the run header (`runId`, `agent`, `onBehalfOf`, `purpose`, `startedAt`, `closedAt`), the ordered entries, every reversal and its outcome, and the Recorder's signature.

Anyone holding the record and the public keys can verify offline that:

1. each entry with a participant receipt was performed by that participant with exactly those arguments (`callDigest`);
2. no entry was removed or reordered (`seq` is gap-free and `prevHash` chains); and
3. every reversal was approved over a plan listing exactly the entries it compensated (J§8.4).

### 6.3 Review before windows close

Undo windows close silently, so the Recorder SHOULD send the principal a review when a run closes: what the agent did, which entries can still be reversed and until when, and which cannot. It SHOULD send a reminder before the earliest open window closes if the run has not been reviewed.

---

## 7. Reversibility-gated autonomy

Before forwarding a call, the Recorder checks the operation's `undo.kind` against its policy:

```json
{ "autonomy": { "compensate": "allow", "compensateViaUi": "ask", "unknown": "ask", "none": "ask",
                "overrides": { "mcp://wiki.acme.com/hatp#search": "allow" },
                "approver": "human://acme.com/role/team-lead?exclude=human://acme.com/dana" } }
```

| Value | Effect |
|---|---|
| `allow` | Forward and journal the call. |
| `ask` | Do not forward it. Run it instead as an HATP transaction with one branch for the call and one approval group (`approver`, default `onBehalfOf`). The call happens only on commit. |
| `block` | Refuse the call with `UNDO_POLICY_BLOCKED` (J§11). |

`compensateViaUi` applies to operations declared `compensate` with `via: "ui"` (J§4.1); it defaults to `ask`.

`unknown` is a property of an **operation**, not of the agent: an agent that calls one unknown tool keeps its autonomy for every other tool. An operation stops being `unknown` for future calls when its participant adds journal support and declares `undo`, or when the organisation, after reviewing it, adds an entry to `overrides` (keyed `<participant>#<operation>`). Overrides take precedence over the class-wide settings and are covered by the policy digest. Neither route changes past entries: they stay `unknown`, because no compensation token was ever issued for them. What remains possible for a past `unknown` entry is a remedy: a linked transaction with its own plan and approval (J§8.7).

An operation declared `compensate` whose participant does not return `effect.version` for it is treated as `unknown` for this check: being able to reverse it is not enough if the reversal could overwrite someone's newer work.

For `ask`, the branch tier is the operation's `tier` (§5.2), or `final` when it declares none, so a single irreversible call fits the one-`final` rule. When the transaction commits, the Recorder records the call as an entry whose receipt is the commit receipt and links the Transaction Record by `txnId`. The agent receives the tool result once the transaction ends, or the abort reason.

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
3. Split the result into **reversible** entries (`compensate`, window still open), **irreversible** ones (`none`, `unknown`, or window closed), and **unresolved** ones (failed an intake check, J§6.1). An unresolved entry is not compensated, and neither is anything that depends on it.
4. List the **readers since**: entries in *other* runs, recorded after a reversed entry, whose `effect.uses` names its `effect.resource` (`declared`) or whose arguments reference it (`inferred`). They read the value the reversal is about to change. Nothing in this list is reversed. It tells the approver whom to notify, the way `sideEffects` does. The Recorder can list only calls that passed through it; reads it never saw, such as what an agent keeps in its own memory, are outside its view, and the Plan says so.

### 8.3 Check

For each reversible entry, the Recorder SHOULD call `hatp/journal/check` (J§10) on its participant. The participant reports, without changing anything, whether the reversal would succeed now: window still open, resource unchanged since `effect.version`, and any `sideEffects` or `cost`. A participant that does not implement `check` is assumed undoable until `undoBy`, with conflicts surfacing at compensation time.

### 8.4 Reversal Plan and approval

The Recorder builds a **Reversal Plan**, a v0.1 Plan (§5.1) with these differences:

```json
{ "hatp": "0.3", "txnId": "rev_01JBD0…", "reversalOf": "run_01JBC4…",
  "initiator": "mcp://gateway.acme.com/hatp", "onBehalfOf": "human://acme.com/dana",
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
  "approvals": [ { "groupId": "owner", "address": "human://acme.com/dana", "quorum": { "required": 1 },
                   "decideBy": "2026-10-31T15:45:00Z" } ] }
```

- Branches are in reversal order: latest entry first.
- `operation.undo` names the entry; `ifVersion` is the entry's `effect.version`. Every branch MUST carry exactly one of `ifVersion` or `"force": true`. `force` is allowed only to override a conflict that a check reported, or for an unversioned entry, and the ask MUST say which (J§8.6).
- `notReversible` lists every irreversible entry in the reversal set, so the human approves knowing what will remain.
- `unresolved` lists entries the Recorder could not resolve (J§6.1), with their problems, kept apart from `notReversible`: "the participant says this cannot be undone" and "the record is broken here" call for different follow-up.
- `readSince` lists the readers since (J§8.2), with each link's `source`. Gateways show it as "these used the value being changed".
- The Recorder sends `hatp/txn/prepare` with the Reversal Plan **only to Human Gateways**. Resource branches are not prepared; `check` (J§8.3) took prepare's place. Gateways render the ask from the structured Plan as usual, including `sideEffects`, `cost` and `notReversible`.
- Approval is REQUIRED when any branch has `sideEffects` or `cost`, any entry is in `notReversible` or `unresolved`, a branch sets `force` or reverses a `via: "ui"` entry, or `requestedBy` is not the run's `onBehalfOf`. Otherwise the Recorder's policy MAY let the principal's own request stand as the approval, and records that in the Reversal Record. A non-empty `readSince` does not by itself require approval, but the Gateway MUST show it whenever there is an ask.

**Who may undo.** Authority is checked when the reversal is approved, not inherited from when the call ran: weeks later, the person may have changed roles. The organisation's policy sets it:

```json
{ "undoAuthority": { "default": "current", "originator": true,
                     "elevated": { "when": ["multiParticipant", "force", "ui"],
                                   "approver": "human://acme.com/role/ops-admin" } } }
```

- `current` (the default and the minimum): every approver must hold, at approval time, the authority the original calls needed. The Human Gateway checks it as for any approval (§10.2).
- `originator: true` also lets the run's `onBehalfOf` approve reversing their own entries, provided they still hold an active identity in the organisation.
- `elevated` names the conditions under which the reversal needs the `elevated.approver` group instead: `multiParticipant` (the reversal set spans more than one participant), `force` (any branch sets it), `ui` (any `via: "ui"` branch). These are the reversals where working out the correct state afterwards is hardest.

### 8.5 Execution

After approval, the Recorder logs the decision durably (as in §6.1) and calls `hatp/txn/compensate` for each branch in Plan order, with `txnId` = the run's `runId`, `branchId` = the entry's `entryId`, the entry's `compensationToken`, and `ifVersion` or `force`.

A compensation can fail. When it does, the Recorder:

1. MUST NOT compensate any entry that the failed entry depends on, transitively: the failed entry's effect is still live and may need them;
2. continues with the remaining independent branches; and
3. ends the reversal in `NEEDS_ATTENTION`, listing each entry as `reversed`, `failed` (with the participant's error), or `skipped` (with the entry that blocked it).

Reversal states reuse §6.1: `PREPARING` (waiting for approval), `ABORTED` (declined or deadline passed; nothing was compensated), `COMMITTING` (compensating), `COMMITTED` (every reversible branch reversed), `NEEDS_ATTENTION`. A compensation that gets no answer is retried, since `compensate` is idempotent (§7.4); if it stays unanswered until the window closes, the entry is reported as `unknown`.

The result is a **Reversal Record** in the Transaction Record format (§8.5). The Recorder appends a reference to it, and each entry's outcome, to the Run Record's hash chain.

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

v0.1 parameters plus `ifVersion` (string) or `force` (boolean), never both. Without either, behaviour is as in v0.1; that is only for compensating a transaction that failed partway (§7.3). When compensating a journal entry (J§8.5), the Recorder MUST send one of them, and a participant that supports the journal MUST refuse a call that has neither with `UNDO_VERSION_REQUIRED`, changing nothing. It MUST honour `ifVersion` (J§8.6). Its compensate receipt SHOULD carry the resource's new version in `detail.version`.

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
| Agent text in the ask misleads the approver | Summaries come from participants' `effect.summary`; agent-written `reason` is labelled as such (§10.3). |
| Run Records leak personal data | `arguments` MAY be omitted (J§6.1); Recorders SHOULD apply the organisation's retention policy and restrict `hatp/journal/get` (J§10.1). |

---

## 13. Changes to v0.1 this draft would make

- §9 capability: per-operation `undo` object; roles `journal` (participant) and `recorder`.
- §7.4 `hatp/txn/compensate`: `ifVersion` and `force`, one of them required when compensating a journal entry.
- §8.3 Receipt: `phase` values `execute` and `check`; `callDigest` allowed in place of `planDigest` for journaled calls.
- §5.1 Plan: optional `reversalOf`, `notReversible`, and per-branch `operation.undo`, `effect` and `sideEffects` for Reversal Plans; `recoveryOf` may name a `runId`.
- §10.1: the error codes in J§11.

---

## 14. Open issues

1. **Dependency capture.** Participants can now declare `effect.uses`, and every link records its `source` (J§6.1). Still open: when, if ever, inferred links should replace the default, and how much evidence is enough, for example a matching ID versus any matching value.
2. **Partial reversibility.** A refund minus a fee is modelled as `cost`. Effects that reverse only in part (a message recalled for internal recipients but not external ones) may need per-recipient undo.
3. **Redo.** Reversing a reversal is out of scope; a corrective action is a new run.
4. **Long windows.** Authority is now re-checked at reversal time (`undoAuthority`, J§8.4). Still open: whether a role change should also notify the people whose runs can still be reversed.
5. **Effect previews.** v0.3 also plans dry-run diffs for `compensate` and `final` tiers. The same `effect` object could describe a call before it happens and the change after it, so asks and reversals show one format.
