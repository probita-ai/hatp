// Questions outside transactions (spec/hatp-asks.md): choose, form and free text, with signed Answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerProblem, HatpError, questionDigest, questionProblem, verifyAnswer } from "../src/index.ts";
import type { AskQuestionRequest, Question } from "../src/index.ts";
import { buildWorld } from "./fixtures.ts";

const alice = "human://acme.com/alice";
const bob = "human://acme.com/bob";
const carol = "human://acme.com/carol";
const dana = "human://acme.com/dana";
const erin = "human://acme.com/erin";
const role = "human://acme.com/role/finance-approver";
const agent = "agent://acme.com/travel-bot";
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

const seat: Question = { kind: "choose", prompt: "Which flight?", options: [{ id: "ua1520", label: "UA 1520, 08:10" }, { id: "dl404", label: "DL 404, 11:45" }] };
const costCentre: Question = { kind: "form", prompt: "Booking details", fields: { costCentre: { type: "string", enum: ["R&D", "Sales"] }, nights: { type: "integer", minimum: 1, maximum: 14 }, refundable: { type: "boolean" } }, required: ["costCentre"] };
const note: Question = { kind: "text", prompt: "Anything the hotel should know?", maxLength: 20 };

const ask = (question: Question, o: Partial<AskQuestionRequest> = {}): AskQuestionRequest => ({ address: role, question, questionDigest: questionDigest(question), decideBy: inMs(30_000), purpose: "Boston trip", audience: agent, ...o });
const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof HatpError && e.code === code);
const keysOf = (w: ReturnType<typeof buildWorld>) => [w.gatewaySigner.publicJwk];

test("a choose question gets a signed answer that verifies offline", async () => {
  const w = buildWorld({ script: { [alice]: { decision: "approve", answer: { choices: ["dl404"] } } } });
  const r = await w.gateway.askQuestion(ask(seat), { principal: dana });
  assert.equal(r.status, "answered");
  const [a] = r.answers;
  assert.equal(a.responder, alice);
  assert.deepEqual(a.answer, { choices: ["dl404"] });
  assert.equal(a.audience, agent);
  assert.equal(verifyAnswer(a, { gatewayKeys: keysOf(w), question: seat, audience: agent }), undefined);

  // The answer can't be swapped, moved to another question, or presented to someone else.
  assert.match(verifyAnswer({ ...a, answer: { choices: ["ua1520"] } }, { gatewayKeys: keysOf(w) }) ?? "", /signed|answerDigest/);
  assert.match(verifyAnswer(a, { gatewayKeys: keysOf(w), question: note }) ?? "", /another question/);
  assert.match(verifyAnswer(a, { gatewayKeys: keysOf(w), audience: "agent://acme.com/other" }) ?? "", /addressed/);

  // The channel saw the question and the agent's context apart from it.
  assert.equal(w.questionAsks[0].agentProvidedText, "Boston trip");
});

test("forms and free text are checked against the question before the gateway signs", async () => {
  const w = buildWorld({ script: { [alice]: { decision: "approve", answer: { values: { costCentre: "R&D", nights: 2 } } } } });
  const r = await w.gateway.askQuestion(ask(costCentre));
  assert.deepEqual(r.answers[0].answer, { values: { costCentre: "R&D", nights: 2 } });

  // Alice's channel sends an answer that doesn't fit: it isn't signed, and the question moves on.
  const w2 = buildWorld({ script: { [alice]: { decision: "approve", answer: { text: "a much longer note than allowed" } }, [dana]: { decision: "approve", answer: { text: "late check-in" } } } });
  const r2 = await w2.gateway.askQuestion(ask(note));
  assert.equal(r2.answers[0].responder, dana);
  assert.match(r2.answers[0].routingReason ?? "", /alice's decision was not accepted: text longer than 20/);
});

test("answerProblem and questionProblem catch what doesn't fit", () => {
  assert.equal(answerProblem(seat, { choices: ["ua1520"] }), undefined);
  assert.match(answerProblem(seat, { choices: ["ua1520", "dl404"] }) ?? "", /between 1 and 1/);
  assert.match(answerProblem(seat, { choices: ["af1"] }) ?? "", /not one of the options/);
  assert.match(answerProblem(seat, { text: "UA" }) ?? "", /choices/);
  assert.match(answerProblem(costCentre, { values: { nights: 2 } }) ?? "", /costCentre is required/);
  assert.match(answerProblem(costCentre, { values: { costCentre: "Ops" } }) ?? "", /one of R&D, Sales/);
  assert.match(answerProblem(costCentre, { values: { costCentre: "R&D", nights: 2.5 } }) ?? "", /integer/);
  assert.match(answerProblem(costCentre, { values: { costCentre: "R&D", extra: 1 } }) ?? "", /not a field/);
  assert.match(questionProblem({ kind: "choose", prompt: "?", options: [{ id: "a", label: "A" }] }) ?? "", /two options/);
  assert.match(questionProblem({ kind: "choose", prompt: "?", options: [{ id: "a", label: "A" }, { id: "a", label: "B" }] }) ?? "", /distinct/);
  assert.match(questionProblem({ kind: "form", prompt: "?", fields: { x: { type: "string" } }, required: ["y"] }) ?? "", /y is not in fields/);
  assert.match(questionProblem({ kind: "poll", prompt: "?" } as unknown as Question) ?? "", /unknown question kind/);
});

test("a decline hands the question to the next eligible human", async () => {
  const w = buildWorld({ script: { [alice]: { decision: "reject" }, [carol]: { decision: "approve" } } });
  const r = await w.gateway.askQuestion(ask(seat), { principal: dana });
  assert.equal(r.status, "answered");
  assert.equal(r.answers[0].responder, carol); // alice's delegate
  assert.deepEqual(r.declinedBy, [alice]);
  assert.match(r.answers[0].routingReason ?? "", /alice declined/);
});

test("when everyone declines, the result is declined, not an error", async () => {
  const everyone = Object.fromEntries([alice, bob, carol, dana, erin].map((h) => [h, { decision: "reject" as const }]));
  const w = buildWorld({ script: everyone });
  const r = await w.gateway.askQuestion(ask(seat));
  assert.equal(r.status, "declined");
  assert.deepEqual(r.answers, []);
  assert.equal(r.declinedBy.length, 5);
});

test("a quorum collects that many answers from distinct people", async () => {
  const w = buildWorld({ script: { [alice]: { decision: "approve", answer: { choices: ["ua1520"] } }, [dana]: { decision: "approve", answer: { choices: ["dl404"] } } } });
  const r = await w.gateway.askQuestion(ask(seat, { address: `${role}?quorum=2-of-3` }));
  assert.deepEqual(r.answers.map((a) => a.responder).sort(), [alice, dana]);
});

test("the requester never answers their own question, and the digest must match", async () => {
  const w = buildWorld({ script: { [alice]: { decision: "approve" }, [dana]: { decision: "approve" } } });
  const r = await w.gateway.askQuestion(ask(seat), { principal: alice });
  assert.equal(r.answers[0].responder, dana);
  await rejects(w.gateway.askQuestion({ ...ask(seat), question: note }), "ACTION_MISMATCH");
  await rejects(w.gateway.askQuestion(ask({ ...seat, options: [] })), "PLAN_INVALID");
});

test("deadline and nobody left to ask", async () => {
  const slow = buildWorld({ gatewayMsPerSecond: 1000, script: { [alice]: "ignore" } });
  await rejects(slow.gateway.askQuestion(ask(seat, { decideBy: inMs(40) })), "DEADLINE_EXCEEDED");
  const silent = buildWorld({ script: {} });
  await rejects(silent.gateway.askQuestion(ask(seat, { address: alice })), "QUORUM_UNREACHABLE");
});

test("human-signed answers: the passkey signs the answer itself", async () => {
  const w = buildWorld({ passkeys: ["alice", "bob"], script: { [alice]: { decision: "approve", passkey: "sign", answer: { choices: ["ua1520"] }, answerSent: { choices: ["dl404"] } }, [bob]: { decision: "approve", passkey: "sign", answer: { choices: ["dl404"] } } } });
  const r = await w.gateway.askQuestion(ask(seat, { assurance: "human-signed" }));
  // Alice's channel signed one answer and sent another: refused. Bob's verifies against his card.
  const [a] = r.answers;
  assert.equal(a.responder, bob);
  assert.equal(a.authentication.assurance, "human-signed");
  assert.equal(verifyAnswer(a, { gatewayKeys: keysOf(w), question: seat, card: w.directory.get(bob) }), undefined);
  assert.match(a.routingReason ?? "", /alice's decision was not accepted/);
});

test("withdrawing the request stops asking", async () => {
  const w = buildWorld({ script: { [alice]: "ignore" } });
  const ctl = new AbortController();
  const p = w.gateway.askQuestion(ask(seat), { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 5);
  await rejects(p, "INVALID_STATE");
  assert.deepEqual(w.asked, [alice]);
});

test("a gateway whose channel cannot deliver questions says so", async () => {
  const w = buildWorld();
  const { createHumanGateway } = await import("../src/index.ts");
  const g = createHumanGateway({ id: w.gateway.id, signer: w.gatewaySigner, directory: w.directory, channel: { deliver: () => new Promise(() => {}) } });
  await rejects(g.askQuestion(ask(seat)), "NOT_SUPPORTED");
});
