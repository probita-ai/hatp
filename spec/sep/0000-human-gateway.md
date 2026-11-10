# SEP-0000: Human Gateway — routable, signed human approvals

- **Status**: Awaiting sponsor
- **Type**: Extensions Track (intended destination: Stable)
- **Extension identifier**: `ai.probita/human-gateway`
- **Created**: 2026-10-29
- **Author(s)**: Murthy G (probita-ai)
- **Sponsor**: None
- **PR**: TBD
- **Prior discussion**: TBD (link to WG/IG thread)

## Abstract

MCP lets a server ask *the user at the client* for input through elicitation. It has no way for an agent to get a decision from *the right person in an organisation*: someone chosen by role and authority, who may not be at the keyboard, may take minutes to answer, and whose "yes" must be provable later.

This SEP defines the **Human Gateway** extension. A Human Gateway is an MCP server that:

1. publishes **Human Cards** as MCP resources (`human://` URIs): what a person may approve, how fast they decide, who covers for them, without exposing contact details;
2. resolves role addresses such as `human://acme.com/role/finance-approver` to eligible people;
3. delivers an **ask** to the chosen people and returns an **Approval**: a signed object bound to a digest of the exact action approved.

It also defines **approval-gated tools**: a tool server can require a valid Approval in `tools/call` `_meta` and verify it offline, without trusting the agent or the client.

The extension is taken from the discovery and evidence layers of HATP (Human-Agent Transaction Protocol), which has a TypeScript reference implementation built on the official MCP SDK.

## Motivation

Agents now take actions with real consequences: they spend money, change production systems and send messages for an organisation. These actions need a human decision, and today MCP gives three options, none of them sufficient.

**Elicitation** reaches only the user connected to the client, and only while the request is open. That person is often not the one with authority (the agent's operator is not the finance approver). The result is not signed, so a tool server cannot tell whether a human saw the arguments, or whether the client answered for them.

**Tool annotations** (`destructiveHint` and similar) are advisory. The specification says clients must not rely on them coming from untrusted servers, and they say nothing about *who* must approve.

**Out-of-band approval systems** (Slack bots, ticketing, vendor products) each use their own format. A tool server cannot verify an approval from one it did not integrate with, and an auditor cannot check a decision without trusting the system that recorded it.

Concretely, an MCP ecosystem today cannot express:

| Need | Gap |
|---|---|
| "Ask *anyone* with the finance-approver role who can approve $2,140, excluding the requester" | No addressing of humans by role, authority or availability |
| "If Alice hasn't answered in 15 minutes, ask her delegate" | No escalation; elicitation blocks one request on one user |
| "Bob approved *this* payment to *this* payee for *this* amount" | No signature binding the decision to the arguments |
| "The payments server should refuse unless approved" | No way for a server to require and check an approval |
| "Show the auditor who was asked, who decided, and how they authenticated" | No portable evidence |

The [Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview) lists "human approvals" among its motivating uses. Tasks keeps the request alive while a human decides, but it does not say who decides or what the decision proves. This SEP fills that gap and uses Tasks for the waiting.

## Specification

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT and MAY are to be interpreted as described in RFC 2119 and RFC 8174.

### 1. Roles

- **Human Gateway**: an MCP server that implements §3–§5. It represents the humans of one or more organisations.
- **Requester**: an MCP client (usually acting for an agent) that asks a gateway for an approval.
- **Gated server**: an MCP server with one or more tools that require an Approval (§6).

A Human Gateway is often deployed by an organisation's identity or workflow team. It is the only component that knows how to reach a human (Slack ID, phone number, push token). Agents and tool servers never learn those details.

### 2. Negotiation

A Human Gateway advertises the extension in its server capabilities:

```json
{
  "capabilities": {
    "resources": {},
    "extensions": {
      "ai.probita/human-gateway": {
        "revision": "1",
        "gatewayId": "https://gateway.acme.com",
        "orgs": ["acme.com"],
        "keys": [{ "kid": "https://gateway.acme.com#key-1", "kty": "OKP", "crv": "Ed25519", "x": "…" }],
        "assurance": ["human-signed", "gateway-attested"]
      }
    }
  }
}
```

A gated server advertises the same extension identifier with gated-server settings:

```json
{
  "capabilities": {
    "tools": {},
    "extensions": {
      "ai.probita/human-gateway": {
        "revision": "1",
        "serverId": "https://payments.example",
        "trustedGateways": ["https://gateway.acme.com"]
      }
    }
  }
}
```

- `gatewayId` and `serverId` MUST be URIs that the operator controls. They identify the party in signed objects.
- Every `kid` in `keys` MUST start with `gatewayId` followed by `#`.
- A requester MUST advertise `ai.probita/human-gateway` in its client capabilities before calling the methods in §4–§5. A gateway MUST NOT accept them from a client that did not.

On protocol versions before `2026-07-28`, these objects are exchanged in `initialize` as `capabilities.extensions`, as described in the MCP extensions overview.

### 3. Human Cards and addresses

#### 3.1 Addresses

```
human://{org}/{local}                 a specific person       human://acme.com/bob
human://{org}/role/{role}             anyone holding a role   human://acme.com/role/finance-approver
human://{org}/pool/{pool}             a named group           human://acme.com/pool/security-leads
```

Role and pool addresses accept the query parameters `skill` (repeatable), `quorum` (`M-of-N`) and `exclude` (a person URI, repeatable).

#### 3.2 Human Cards as resources

A gateway exposes each Human Card as an MCP resource whose URI is the person's address, with MIME type `application/vnd.hatp.human-card+json`. Cards are listed through `resources/list` and read through `resources/read`.

```json
{
  "id": "human://acme.com/bob",
  "displayName": "Bob Chen",
  "org": "acme.com",
  "roles": ["finance-approver"],
  "skills": ["travel-policy", "sox-controls"],
  "authority": [{ "action": "approve.spend", "maxAmount": { "value": 10000, "currency": "USD" } }],
  "channels": ["slack", "sms"],
  "availability": { "timezone": "America/New_York", "status": "available" },
  "sla": { "ackSeconds": 300, "decideSeconds": 900 },
  "delegates": ["human://acme.com/carol"],
  "keys": [{ "kid": "human://acme.com/bob#passkey-2026", "use": "webauthn", "kty": "EC", "crv": "P-256", "alg": "ES256", "x": "…", "y": "…", "credentialId": "…", "rpId": "acme.com" }],
  "issuer": "https://gateway.acme.com",
  "signature": { "alg": "Ed25519", "kid": "https://gateway.acme.com#key-1", "sig": "…" }
}
```

- `channels` MUST list channel types only. Contact addresses MUST NOT appear in a card.
- `availability.status` MAY be coarse or omitted for requesters outside the organisation.
- Cards MUST be signed by their `issuer` (§7). Requesters MUST reject a card whose signature does not verify.
- Live fields (`availability.status`, `capacity.open`) change after the card is signed. A gateway serving cards as resources MUST serve them as issued, so the signature still verifies, and MAY report live status separately.
- `authority` is published so requesters can choose sensible addresses. It is not a security boundary. The gateway enforces authority when it selects approvers (§5).

### 4. `hatp/directory/resolve`

Resolves an address to a ranked list of eligible people.

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "hatp/directory/resolve",
  "params": {
    "address": "human://acme.com/role/finance-approver?quorum=1-of-1&exclude=human://acme.com/dana",
    "requirement": { "action": "approve.spend", "amount": { "value": 2140, "currency": "USD" } },
    "deadline": "2026-10-29T18:15:00Z"
  }
}
```

```json
{
  "candidates": [
    { "id": "human://acme.com/bob", "score": 0.92, "reasons": ["available", "authority-ok"] },
    { "id": "human://acme.com/alice", "score": 0.40, "reasons": ["authority-ok", "busy"] }
  ],
  "quorum": { "required": 1, "of": 2 }
}
```

- A gateway MUST NOT return a candidate whose authority does not cover `requirement`, or who is excluded.
- If fewer eligible candidates exist than `quorum.required`, the gateway MUST return the error `QUORUM_UNREACHABLE` (§8).
- Resolution is advisory. The gateway makes the final selection when it handles an ask (§5) and MAY choose differently.

### 5. `hatp/ask/approve`

Asks eligible humans to approve one action and returns their signed Approvals.

#### 5.1 Actions and digests

An **Action** is the structured description of what is approved. This SEP defines one action type. Other types (such as the multi-server transaction plan of HATP) MAY be defined by later revisions.

```json
{
  "type": "mcp.tools/call",
  "server": "https://payments.example",
  "tool": "charge_card",
  "arguments": { "amount": { "value": 2140, "currency": "USD" }, "payee": "Lufthansa", "cardRef": "corp-4471" },
  "toolDigest": "sha256:Xq3…"
}
```

- `server` is the gated server's `serverId` (§2).
- `arguments` are exactly the arguments the requester will send in `tools/call`.
- `toolDigest` is OPTIONAL. When present it is the digest (§7) of the tool's definition as returned by `tools/list`: `name`, `description`, `inputSchema`, and `annotations` if present. It binds the approval to the version of the tool the human was shown.
- `payment` is OPTIONAL. It is REQUIRED when the tool is paid and the server, not the arguments, sets the price and payee (§6.1). It states the most the human agrees to pay, and to whom.

```json
{
  "type": "mcp.tools/call",
  "server": "https://data.example",
  "tool": "premium_report",
  "arguments": { "ticker": "ACME" },
  "payment": {
    "network": "eip155:8453",
    "asset": "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "maxAmount": "2500000",
    "payTo": "0x9a3f…"
  }
}
```

- `network` is a [CAIP-2](https://chainagnostic.org/CAIPs/caip-2) chain ID and `asset` a [CAIP-19](https://chainagnostic.org/CAIPs/caip-19) asset ID, so a token on a given chain can be named exactly. `maxAmount` is a decimal string in the asset's atomic units (here 2.50 USDC). `payTo` is the payee as the payment scheme identifies it.
- `payment` is covered by the action digest like every other member. It does not choose a payment rail: HATP leaves rails to AP2 and x402. It only fixes what the approval covers.

The **action digest** is `"sha256:" + base64url(SHA-256(JCS(action)))`, where JCS is the JSON Canonicalization Scheme (RFC 8785).

#### 5.2 Request

```json
{
  "jsonrpc": "2.0", "id": 2, "method": "hatp/ask/approve",
  "params": {
    "address": "human://acme.com/role/finance-approver?quorum=1-of-1&exclude=human://acme.com/dana",
    "requirement": { "action": "approve.spend", "amount": { "value": 2140, "currency": "USD" } },
    "action": { "type": "mcp.tools/call", "server": "https://payments.example", "tool": "charge_card", "arguments": { … } },
    "actionDigest": "sha256:9f2c…",
    "decideBy": "2026-10-29T18:15:00Z",
    "purpose": "Flight FRA→SFO for the Q4 customer visit",
    "_meta": {
      "io.modelcontextprotocol/clientCapabilities": {
        "extensions": { "ai.probita/human-gateway": {}, "io.modelcontextprotocol/tasks": {} }
      }
    }
  }
}
```

The gateway:

1. MUST recompute the digest of `action` and return `ACTION_MISMATCH` if it differs from `actionDigest`.
2. MUST select `quorum.required` distinct eligible humans, applying authority, `exclude`, and organisational separation-of-duty policy. The gateway MUST exclude the requester's principal from approving its own request whenever it can identify that principal, whatever the requester sends.
3. MUST render the ask from the structured `action` (tool, arguments, server, and `payment` when present: the maximum amount in the asset's display units, the asset, the network and the payee). Agent-supplied free text (`purpose`) MUST be shown separately and labelled as provided by the agent.
4. MUST authenticate each human at the moment of decision and record how (§5.4).
5. MAY escalate when an approver misses their `sla.decideSeconds`: reassign to another eligible candidate or to a delegate. Every reassignment MUST be recorded in `routedVia`.
6. MUST stop asking and return `DEADLINE_EXCEEDED` when `decideBy` passes without quorum.

#### 5.3 Waiting

Human decisions take minutes or hours. If the requester declared `io.modelcontextprotocol/tasks`, the gateway SHOULD return a `CreateTaskResult` and complete the task with the result in §5.4. If the requester did not declare it, the gateway MAY hold the request open until a decision or `decideBy`. Requesters MUST NOT apply a short default timeout to this method.

- A gateway error during a task completes it as `failed`, with the result `{ "hatpError": { "code": "<§8 code>", "message": "…" } }`, so the code survives the task.
- Cancelling the task (`tasks/cancel`), or the request when no task is used, MUST withdraw every open ask for it. A human who has not yet decided can then no longer approve.

#### 5.4 Result and the Approval object

```json
{
  "decision": "approve",
  "approvals": [
    {
      "type": "hatp.approval",
      "actionDigest": "sha256:9f2c…",
      "decision": "approve",
      "approver": "human://acme.com/bob",
      "routedVia": ["human://acme.com/role/finance-approver", "human://acme.com/alice", "human://acme.com/bob"],
      "routingReason": "alice did not decide within SLA; reassigned to bob",
      "authentication": {
        "method": "webauthn", "at": "2026-10-29T18:04:51Z", "assurance": "human-signed",
        "webauthn": { "kid": "human://acme.com/bob#passkey-2026", "credentialId": "…", "authenticatorData": "…", "clientDataJSON": "…", "signature": "…" }
      },
      "audience": "https://payments.example",
      "nonce": "b8Kq…",
      "decidedAt": "2026-10-29T18:04:51Z",
      "expiresAt": "2026-10-29T18:34:51Z",
      "issuer": "https://gateway.acme.com",
      "signature": { "alg": "Ed25519", "kid": "https://gateway.acme.com#key-1", "sig": "…" }
    }
  ]
}
```

- `decision` is `approve` only when `quorum.required` approvals exist. It is `reject` as soon as any selected approver rejects or quorum becomes impossible.
- A `reject` result carries only the signed rejections. Approvals already given by other members of the failed quorum MUST NOT be returned, so none can be presented alone to a tool that requires fewer approvers.
- If every eligible human has been asked and too few decided before `decideBy`, the gateway returns `QUORUM_UNREACHABLE`.
- `expiresAt` is in the passkey challenge (§7.1), so it is fixed when the ask goes out, before the human decides. The reference gateway sets it to a validity window (default 10 minutes) after the latest moment that ask could be decided: the end of the approver's `sla.decideSeconds`, or `decideBy` if sooner.
- Each Approval MUST be signed (§7) over the object without its `signature` field.
- `assurance` is one of:
  - `human-signed`: the human also signed the decision with a passkey listed in their card, carried in `authentication.webauthn` (§7.1). RECOMMENDED for actions above an organisation-defined threshold.
  - `gateway-attested`: the gateway's signature only, after the gateway authenticated the human. The `authentication` block records how.
- The gateway signs every Approval with its own key, at either assurance.
- `audience` MUST equal the action's `server`.
- `expiresAt` MUST be set. Gateways SHOULD keep the validity window short (minutes, not days).

### 6. Approval-gated tools

A gated server marks a tool as requiring approval in the tool's `_meta`:

```json
{
  "name": "charge_card",
  "inputSchema": { … },
  "_meta": {
    "ai.probita/human-gateway": {
      "requires": {
        "address": "human://acme.com/role/finance-approver",
        "requirement": { "action": "approve.spend", "amountFrom": "/amount" },
        "assurance": "human-signed"
      }
    }
  }
}
```

`amountFrom` is a JSON Pointer into the call's arguments. It lets a requester build `requirement` without guessing.

The requester passes the Approvals in the `tools/call` request:

```json
{
  "method": "tools/call",
  "params": {
    "name": "charge_card",
    "arguments": { … },
    "_meta": { "ai.probita/human-gateway": { "approvals": [ { "type": "hatp.approval", … } ] } }
  }
}
```

Before running a gated tool, the server MUST check all of the following and MUST NOT run the tool if any check fails:

1. Each Approval's `actionDigest` equals the digest of `{ type: "mcp.tools/call", server: <own serverId>, tool: <name>, arguments: <arguments as received> }`, plus `toolDigest` when the Approval's action carried one, plus `payment` for a paid tool (§6.1). The server can only recompute that digest if it knows the `toolDigest` value, so a gated server that accepts `toolDigest` MUST compute it from its current tool definition. A changed definition then fails this check. For a paid tool, the `payment` the requester passed MUST also match the server's own terms (§6.1).
2. The signature verifies against a key of `issuer`, where `issuer` is in `trustedGateways`. For a `human-signed` Approval, the passkey assertion also verifies against the approver's card, issued by a trusted gateway (§7.1).
3. `audience` equals the server's `serverId`.
4. `decidedAt` ≤ now < `expiresAt`.
5. `nonce` has not been accepted before within `expiresAt`. The server MUST record accepted nonces until they expire. A nonce is consumed only when the tool runs: a call the server answers without running the tool (for example with its x402 payment terms, or an error) MUST NOT record it, so the paid retry of the same call is not refused as a replay.
6. The approvals meet the tool's `requires`: enough distinct approvers, with at least the required `assurance`.

If approvals are missing or fail a check, the server MUST return the JSON-RPC error `-32050` with `data.code` `APPROVAL_REQUIRED` or `APPROVAL_INVALID`. For `APPROVAL_REQUIRED`, `data.requires` MUST repeat the tool's `requires` so the requester can ask a gateway and retry.

#### 6.1 Paid tools

Some paid tools do not take the price as an argument. In x402 over MCP, the server answers the first `tools/call` with its payment terms (amount in atomic units, asset, network, payee), and the client repeats the call with the same arguments and the signed payment in `params._meta["x402/payment"]`. An approval over `{ server, tool, arguments }` then covers any price and any payee, and the approver never sees either.

A gated server whose tool is paid this way MUST declare it in `requires`:

```json
"requires": {
  "address": "human://acme.com/role/finance-approver",
  "requirement": { "action": "approve.spend", "amountFrom": "payment" },
  "payment": { "network": "eip155:8453", "asset": "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  "assurance": "human-signed"
}
```

- `"amountFrom": "payment"` means the amount to check authority against is the action's `payment.maxAmount` in `payment.asset`. A requirement amount MAY be `{ "value": "<atomic units>", "asset": "<CAIP-19>" }` as well as `{ "value", "currency" }`; a gateway that cannot convert the asset to a card's `maxAmount` currency MUST treat authority as not covered.
- The requester asks for an approval with an action that includes `payment` (§5.1), and passes that `payment` object back next to the Approvals, in `_meta["ai.probita/human-gateway"].payment`, so the server can recompute the digest.
- **The payer checks the terms.** For a paid tool the gated server is also the payee, so a check that only it runs cannot protect the payer. Before signing a payment, the payer's client or wallet MUST check the server's terms against the approved `payment`: same `network`, `asset` and `payTo`, and an amount no greater than `maxAmount`. If any differs, it MUST NOT sign, and SHOULD ask for a new approval showing the new terms.
- The gated server additionally checks, in §6 check 1, that the `payment` it was given matches its own terms in the same way. This catches honest mismatches early; it is not what protects the payer.
- A cap ("up to $800", Open Question 2) is the same check with `maxAmount` as the cap. A standing approval (Open Question 4) MUST also keep a running total across calls, because a limit per payment is not a limit in total.

### 7. Signatures and canonical form

- Canonical form: JCS (RFC 8785). Digests: `"sha256:" + base64url(SHA-256(JCS(value)))`.
- Signatures: Ed25519, detached, `{ "alg": "Ed25519", "kid": "…", "sig": "<base64url>" }`, computed over `JCS(object without "signature")`.
- Keys are JWK (OKP/Ed25519), except passkeys in Human Cards (§7.1). They are published in the gateway's capability settings (§2) and in Human Cards (§3.2). Operators SHOULD also publish gateway keys at a well-known HTTPS location, so gated servers can pin them without connecting to the gateway.

#### 7.1 Passkeys

A passkey cannot sign an arbitrary JSON object: WebAuthn signs `authenticatorData ‖ SHA-256(clientDataJSON)`, and `clientDataJSON` carries a challenge. A `human-signed` Approval therefore carries a WebAuthn assertion whose challenge is a digest of the decision:

```
challenge = base64url(SHA-256(JCS({ "type": "hatp.approval.challenge",
                                    "actionDigest", "decision", "approver", "audience", "nonce", "expiresAt" })))
```

- A passkey in a Human Card is a JWK with `"use": "webauthn"` (P-256/ES256 or Ed25519/EdDSA), its base64url `credentialId`, and the WebAuthn `rpId` it is registered for.
- A verifier MUST check that the assertion's `kid` and `credentialId` name a passkey on the approver's card; that `clientDataJSON` has `type` `webauthn.get`, the challenge above, and an `https` origin on the key's `rpId`; that `authenticatorData` starts with SHA-256(`rpId`) and has the user-present and user-verified flags; and that the signature verifies with the card key.
- Because `decision` is in the challenge, an assertion made to reject cannot be presented as an approval. Because the passkey is on the card the organisation's issuer signed, a compromised gateway cannot make a `human-signed` Approval alone.

### 8. Errors

JSON-RPC errors use code `-32050` with `data.code`:

| `data.code` | Meaning |
|---|---|
| `ACTION_MISMATCH` | `actionDigest` does not match `action` |
| `AUTHORITY_INSUFFICIENT` | No eligible human has the required authority |
| `QUORUM_UNREACHABLE` | Not enough eligible humans for the quorum |
| `DEADLINE_EXCEEDED` | `decideBy` passed without a decision |
| `APPROVAL_REQUIRED` | A gated tool was called without approvals |
| `APPROVAL_INVALID` | Approvals were present but failed a check in §6 |

A rejection by a human is not an error. It is a result with `"decision": "reject"`.

## Rationale

**Why an extension, not core.** Most MCP deployments are a single user at a single client, and elicitation serves them well. Routing to other people, signing and verification matter to organisations, regulated industries and multi-agent systems. An optional extension lets them adopt it without adding to every implementation.

**Why not extend elicitation.** Elicitation is a request from server to client, answered by whoever is at the client. This SEP is about who answers, which is a different question. The two compose: a gateway MAY deliver an ask through elicitation (for example URL-mode elicitation to a passkey page) when the selected approver is the connected user.

**Why sign over the arguments.** An approval that says "Bob approved charge_card" can be replayed with different arguments. Binding the digest of the exact arguments (and optionally the tool definition) closes that gap. It also defeats a server that changes a tool's description after approval ("rug pull"), when `toolDigest` is used.

**Why the gated server verifies.** The agent and client are the parties being supervised. If only they checked the approval, the check would protect nothing. Verification by the server that performs the action makes the approval enforceable. Payment terms are the exception: when the server is also the payee, the check that protects the payer runs where the payment is signed (§6.1).

**Why role addresses.** Agents should not need to know an organisation chart. `human://acme.com/role/finance-approver` keeps that knowledge in the gateway, which can apply delegation, availability and separation of duties.

**Why Ed25519 and detached signatures.** They are small and fast, and verification needs no extra infrastructure. A JWS/COSE envelope can be added in a later revision without changing what is signed.

**Alternatives considered.**
- *OAuth step-up / CIBA* authenticates the user at the client and issues a token for a scope. A token says "this session may charge cards". It does not say "Bob approved this charge". It also has no role routing or quorum.
- *IETF draft-rosenberg-cheq* provides signed human confirmation of individual actions and could serve as a delivery mechanism behind a gateway. It does not address role routing, quorum or escalation.
- *AP2 mandates* cover payments. This SEP is not specific to payments and can carry an AP2 mandate reference in `purpose` or a later action type.

**Related work.** A2A Agent Cards (Human Cards follow the same idea for people). IETF draft-sato-soos-hem (escalation lifecycle, without plan-bound signatures). Twilio A2H (typed intents to humans over channels; a candidate delivery layer behind a gateway).

## Backward Compatibility

The extension is additive and opt-in. Peers that do not advertise `ai.probita/human-gateway` are unaffected.

A gated server that receives a call to a gated tool from a client without the extension MUST still refuse to run it. It SHOULD return `APPROVAL_REQUIRED` with a text explanation, so a human operator understands why. Servers MAY keep ungated tools available to such clients.

The existing HATP reference implementation advertises its binding under `capabilities.experimental.hatp`. It will move to `capabilities.extensions["ai.probita/human-gateway"]` with this SEP.

## Reference Implementation

- [`hatp-protocol`](https://www.npmjs.com/package/hatp-protocol) (TypeScript, zero runtime dependencies): Human Cards and card signing, directory resolution with authority, exclusion and quorum, Human Gateway with SLA escalation and delegation, signed Approvals bound to a digest, offline verification.
- [`hatp-mcp`](https://www.npmjs.com/package/hatp-mcp): runs HATP participants and Human Gateways as MCP servers on the official TypeScript SDK (`@modelcontextprotocol/sdk`).
- Runnable demo: a browser approver and tool servers over MCP (`node demo/trip.ts`, `npm run demo:mcp`) at https://github.com/probita-ai/hatp.

Status against this SEP:

| Part | Status |
|---|---|
| Human Cards, signing, verification | Implemented |
| Resolution with authority, exclude, quorum | Implemented, including `hatp/directory/resolve` over MCP |
| Signed Approvals, escalation, `routedVia` | Implemented, in HATP transactions and for single actions |
| `human-signed` with passkeys (§7.1) | Implemented, in transactions (challenge over the plan digest) and for single actions (challenge above); browser demo with `--passkey` |
| `payment` in actions, payer-side check (§6.1) | Implemented (`paymentTermsProblem`) |
| Cards as MCP resources | Implemented (`serveHumanGateway`, `mcpHumanGateway().cards()`) |
| `hatp/ask/approve` with `mcp.tools/call` actions | Implemented, with negotiation and requester exclusion |
| Approval-gated tools (§6) | Implemented (`gateTools`, `callGatedTool`) |
| Tasks-based waiting | Implemented: a task-augmented ask returns a task at once; cancelling it, or the request, withdraws the asks |
| Questions (`hatp/ask/choose`, `form`, `text`) | Implemented, with signed Answers ([hatp-asks.md](../hatp-asks.md)) |
| Conformance scenario | Planned |

## Security Implications

| Threat | Mitigation |
|---|---|
| Approval reused for different arguments or a different tool | `actionDigest` covers server, tool and arguments; servers recompute it (§6, check 1) |
| Approval replayed for the same call | Single-use `nonce`, short `expiresAt`, server-side nonce record (§6, checks 4–5) |
| Approval presented to a different server | `audience` check (§6, check 3) |
| Price or payee set by the server outside the arguments (x402 and similar) | `payment` in the action, covered by `actionDigest` and rendered in the ask; the payer's client or wallet checks the server's terms against it before signing (§6.1) |
| Paid retry refused as a replay | Nonce consumed only when the tool runs (§6, check 5) |
| Tool definition changed after the human saw it | Optional `toolDigest` (§5.1) |
| Agent or client forges an approval | Gated server verifies the signature against keys of a trusted gateway or a card it issued; agents hold no signing keys |
| Rogue or compromised gateway | Gated servers trust only listed gateways and SHOULD pin their keys; `human-signed` assurance limits what a compromised gateway alone can produce |
| Agent claims authority it lacks, or approves its own request | Gateway enforces authority and separation of duties; requester-supplied `exclude` is advisory only |
| Prompt injection into the ask ("Approve — this is routine") | Asks rendered from structured `action`; agent text labelled and separated (§5.2.3) |
| Approval fatigue (rubber-stamping) | Gateways SHOULD rate-limit asks per human, batch similar asks, and show effect summaries |
| Exposure of personal data | Cards hold channel types only; availability MAY be coarse or hidden outside the org; contact details never leave the gateway |
| Coerced or mistaken approval | Out of scope for the protocol; `authentication` records method and time for later review |

Gateways hold personal data and authentication material. Operators should treat a gateway with the same care as an identity provider.

## Open Questions

1. Should Approvals for `mcp.tools/call` and HATP transaction plans share one digest field (`actionDigest`), with the plan as an action type? HATP v0.1 uses `planDigest`.
2. Resolved: there is no approve-with-constraints. A human who wants "up to $800" rejects with a reason and a new action is requested. `payment.maxAmount` (§6.1) stays: the requester proposes that cap, and the human signs it as part of the action.
3. How should a gated server discover a gateway's keys without connecting to it: a well-known URL, a Server Card field, or both?
4. Should standing approvals (a signed policy covering future actions, rather than one action) be defined here or in a separate extension?

## Copyright

This document is placed in the public domain or under the CC0-1.0-Universal license, whichever is more permissive.
