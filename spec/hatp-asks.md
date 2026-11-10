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

## 8. Open questions

1. Should a quorum of answers be able to require agreement (all choose the same option), or is that always the requester's business?
2. A2H and CHEQ as delivery channels behind a gateway (v0.1 §11) are not defined yet.
