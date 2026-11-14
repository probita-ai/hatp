# HATP Asks: questions for humans outside transactions

**Status:** Draft
**Target:** HATP v0.2. Builds on the Human Gateway ([hatp-v0.1.md](hatp-v0.1.md) §6.3, §8.4) and the [Human Gateway SEP](sep/0000-human-gateway.md). References written §6.3 point to the v0.1 spec; SEP §5 points to the SEP; A§3 points to this document.

The key words MUST, MUST NOT, SHOULD and MAY are to be interpreted as described in RFC 2119 and RFC 8174.

## 1. Purpose

A transaction asks humans to approve a plan, and `hatp/ask/approve` (SEP §5) asks them to approve one tool call. Agents also need things from humans that aren't approvals: which of two flights, a cost centre, a short note for the hotel. These asks reach the right person the same way: by role, authority and availability, with escalation and delegation. The result is a signed **Answer** that anyone can check later.

An approval authorises an action. An Answer is information. A tool server MUST NOT accept an Answer in place of an Approval.

## 2. Methods

| Method | Question `kind` | Answer |
|---|---|---|
| `hatp/ask/choose` | `choose` | `{ "choices": ["<option id>", …] }` |
| `hatp/ask/form` | `form` | `{ "values": { "<field>": <string \| number \| boolean>, … } }` |
| `hatp/ask/text` | `text` | `{ "text": "…" }` |

Each method takes only its own kind and MUST answer `PLAN_INVALID` for another. Like `hatp/ask/approve`, these methods are served by a Human Gateway that advertises `ai.probita/human-gateway`, and only to clients that declared it (SEP §2).

## 3. Request

```json
{
  "jsonrpc": "2.0", "id": 7, "method": "hatp/ask/choose",
  "params": {
    "address": "human://acme.com/role/travel-coordinator?quorum=1-of-1",
    "question": {
      "kind": "choose",
      "prompt": "Which flight should Dana take to Boston?",
      "options": [{ "id": "ua1520", "label": "UA 1520, 08:10, $412" }, { "id": "dl404", "label": "DL 404, 11:45, $389" }],
      "minChoices": 1, "maxChoices": 1
    },
    "questionDigest": "sha256:…",
    "decideBy": "2026-11-10T18:15:00Z",
    "purpose": "Customer visit, Boston",
    "audience": "agent://acme.com/travel-bot",
    "requirement": { "action": "answer.travel" },
    "assurance": "gateway-attested"
  }
}
```

- `questionDigest` is `"sha256:" + base64url(SHA-256(JCS(question)))`. The gateway MUST recompute it and answer `ACTION_MISMATCH` if it differs.
- `choose`: at least two options with distinct, non-empty `id`s. `minChoices` defaults to 1 and `maxChoices` to 1.
- `form`: `fields` maps names to `{ "type": "string" | "number" | "integer" | "boolean" }`. Strings MAY have `minLength`, `maxLength`, `enum` and `format`; numbers MAY have `minimum` and `maximum`. `required` lists fields that must be answered. This is the flat subset MCP elicitation uses, so a gateway can deliver a form through elicitation when the chosen human is the connected user.
- `text`: `maxLength` is OPTIONAL.
- `requirement.action`, when present, limits who may answer to humans whose card lists that action. Amounts don't apply to questions.
- `audience` names who will rely on the answer. It is signed into the Answer.
- `assurance: "human-signed"` means an answer only counts when the human's passkey signs it (§5).

## 4. Selection, delivery and declining

The gateway selects and asks humans as for an approval (SEP §5.2): eligibility, `exclude`, separation of duties (the requester's principal never answers its own question), quorum, SLA escalation to delegates and then the next candidate, and `DEADLINE_EXCEEDED` when `decideBy` passes.

- **Everything in `question` is written by the requester**, the prompt as well as the option labels, unlike an approval, which the gateway renders from a structured action. A channel MUST label the whole question as provided by the requester, and show `purpose` apart from it.
- A human MAY **decline**. A decline is not an answer: the question passes to the next eligible human, as when an SLA is missed, and the decline is recorded in `routingReason`.
- The gateway MUST check each answer against the question (§3) before signing it. An answer that doesn't fit is not signed, and the question passes on.
- A quorum `M-of-N` collects `M` Answers from `M` distinct humans. The gateway does not combine them: the requester sees each one.

## 5. Result and the Answer object

```json
{
  "status": "answered",
  "declinedBy": ["human://acme.com/alice"],
  "answers": [
    {
      "type": "hatp.answer",
      "questionDigest": "sha256:…",
      "answer": { "choices": ["dl404"] },
      "answerDigest": "sha256:…",
      "responder": "human://acme.com/carol",
      "routedVia": ["human://acme.com/role/travel-coordinator", "human://acme.com/alice", "human://acme.com/carol"],
      "routingReason": "human://acme.com/alice declined",
      "authentication": { "method": "slack-sso", "at": "2026-11-10T18:04:51Z", "assurance": "gateway-attested" },
      "audience": "agent://acme.com/travel-bot",
      "nonce": "b8Kq…",
      "decidedAt": "2026-11-10T18:04:51Z",
      "issuer": "https://gateway.acme.com",
      "signature": { "alg": "Ed25519", "kid": "https://gateway.acme.com#key-1", "sig": "…" }
    }
  ]
}
```

- `status` is `answered` when the quorum's Answers exist. It is `declined` when every eligible human was asked, none is left, and at least one declined. If none declined and too few answered, the gateway returns `QUORUM_UNREACHABLE`.
- `answerDigest` is the digest of `answer`. The gateway signs the Answer without its `signature` field, as for Approvals (SEP §7).
- Answers have no `expiresAt`: they record what a human said, and authorise nothing.

**Passkeys.** An approval's challenge can be fixed before the human decides, because there are only two decisions. An answer's can't, so the channel computes it once the human has answered:

```
challenge = base64url(SHA-256(JCS({ "type": "hatp.answer.challenge", "questionDigest", "answerDigest",
                                    "responder", "nonce", "audience": <audience or null> })))
```

The gateway checks the assertion against a passkey on the responder's card, as in SEP §7.1. An answer swapped after the human signed it fails that check.

**Relying on an Answer.** A relying party checks the gateway's signature, that `answerDigest` matches `answer`, that `questionDigest` matches the question it asked, that the answer fits that question, and, when it names itself, that `audience` is itself.

## 6. Waiting

Like `hatp/ask/approve`, these asks may take hours. A requester that declared `io.modelcontextprotocol/tasks` SHOULD send them as task-augmented requests, and the gateway returns a task at once and completes it with the result. A gateway error completes the task as `failed` with `{ "hatpError": { "code", "message" } }`. Cancelling the task, or the request when no task is used, MUST withdraw every open ask for it.

## 7. Errors

The codes of SEP §8 apply, with `ACTION_MISMATCH` meaning that `questionDigest` doesn't match `question`, and `PLAN_INVALID` for a malformed question. A decline is not an error.

## 8. Delivery channels

A **channel** carries one ask to one human the gateway has already chosen and brings back what that human did. In the reference SDK this is `HumanChannel`: `deliver` for a vote on a transaction, `deliverAction` for `hatp/ask/approve`, `deliverQuestion` for the asks in this document. Slack, email, a web page and MCP elicitation are channels. So are other protocols that reach humans, such as Twilio A2H and CHEQ.

The division of work is the same whatever the channel:

| The gateway | The channel |
|---|---|
| Resolves the address, checks eligibility, `exclude` and separation of duties | Shows the ask to the one human it was given |
| Counts the quorum, runs SLA escalation and delegation | Authenticates that human, as well as it can |
| Withdraws asks at `decideBy` or on cancel | Returns the decision, or nothing |
| Checks the decision and signs the Approval or Answer | Reports how the human was authenticated |

A channel MUST NOT pick humans, forward an ask, count votes or sign. The rules below follow from that.

### 8.1 Rules for every channel

- **One ask, one human.** The gateway gives the channel one human at a time. A decision that comes back from anyone else is not a decision: the gateway records it in `routingReason` and keeps waiting, then escalates as for a missed SLA. Delegation happens only through the delegates on the human's card (SEP §5.2), so it appears in `routedVia`.
- **Authentication is evidence, not a signature.** The channel reports `method` (for example `slack-sso`, `a2h`, `cheq`) and any evidence it received. The gateway records it in `authentication` and signs the Approval or Answer itself. With `assurance: "gateway-attested"` the result is only as strong as the channel's login.
- **`human-signed` needs the HATP challenge.** A passkey assertion counts only when it signs the challenge in SEP §7.1 (approvals) or §5 (answers). A channel that can't put that exact challenge in front of the authenticator MUST NOT be used for a `human-signed` ask. The gateway treats that human as unreachable on this channel and moves on. A signature the channel collected over its own challenge is recorded as evidence and does not raise the assurance.
- **Requester text is labelled.** §4 applies on every channel: the whole question is shown as provided by the requester, with `purpose` shown apart from it. For `hatp/ask/approve`, the channel shows the gateway's rendering of the action, not text the requester supplied.
- **Withdrawal reaches the channel.** When the gateway withdraws an ask (deadline, cancel, quorum reached, escalation), it MUST cancel the delivery. A decision that arrives after that does not count, whatever the channel says.
- **Late decisions are recorded, not counted.** When a channel does receive a decision for a withdrawn ask, the gateway SHOULD record it: the ask, the human, what they decided, when it arrived, and why the ask had been withdrawn (`deadline`, `sla`, `cancelled`, `decided` or `transaction-ended`). The record is signed with `type: "hatp.late-decision"` and `counted: false`. It is not an Approval or an Answer. A relying party MUST NOT accept it as one, and it never changes a vote or a result. For a question, it carries the `answerDigest` of what the human answered, not the answer itself. This applies to transaction votes and `hatp/ask/approve` as well as to the asks in this document.

### 8.2 Twilio A2H

An A2H gateway can sit behind a Human Gateway as a channel. The Human Gateway sends one A2H request per human it chose, addressed to that human and not to a group. Approvals and `choose` asks map to A2H's approval-style intents, and `form` and `text` to its data-collection intents. The Human Gateway turns each A2H response into a `HumanDecision` or `HumanAnswer`.

A2H plans its own N-of-M approval and delegation. Behind a Human Gateway, HATP's are the ones that count:

- Each A2H request asks for one response from one human. The gateway MUST NOT send a role or group and let A2H gather several responses, because it can't check eligibility, `exclude` or separation of duties for people it didn't choose.
- A2H delegation SHOULD be turned off for these requests. If A2H forwards an ask anyway, the response comes from someone the gateway didn't ask, and §8.1 applies: it doesn't count.
- An A2H response that reports several approvers counts as one decision at most, from the human the gateway asked. The quorum is counted by the gateway from distinct humans it chose.

A2H's evidence of who responded goes into `authentication`. When the A2H gateway can carry the HATP challenge to the human's passkey, the assertion is passed back unchanged and the ask can be `human-signed`. Otherwise A2H asks are `gateway-attested`.

### 8.3 CHEQ

CHEQ (draft-rosenberg-cheq) gets a human's signed confirmation of a single action. It fits `hatp/ask/approve` and transaction votes, which are yes or no on something the gateway rendered. It doesn't fit `choose`, `form` or `text`, and a gateway MUST NOT deliver a question as a CHEQ confirmation.

The text the human confirms over CHEQ MUST be the gateway's rendering of the action or Plan, so that the confirmation and the Approval's digest describe the same thing. The CHEQ confirmation is recorded as evidence in `authentication`. The Approval is still signed by the gateway. As in §8.1, the ask is `human-signed` only when the confirmation is a passkey assertion over the HATP challenge.

## 9. Open questions

1. Should a quorum of answers be able to require agreement (all choose the same option), or is that always the requester's business?
2. Should a gateway publish which channels it uses for each human, so that a requester can tell in advance whether a `human-signed` ask can reach them?
