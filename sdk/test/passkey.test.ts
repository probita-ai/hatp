// Human-signed approvals with passkeys (spec §8.4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalChallenge, createCoordinator, createSigner, verifyAssertion, verifyHumanSignature, verifyRecord } from "../src/index.ts";
import { buildWorld, FakeAuthenticator, tripPlan } from "./fixtures.ts";

const alice = "human://acme.com/alice";
const bob = "human://acme.com/bob";
const humanSigned = { assurance: "human-signed" as const };

test("a passkey approval is recorded as human-signed and verifies offline", async () => {
  const w = buildWorld({ passkeys: ["alice"], script: { [alice]: { decision: "approve", passkey: "sign" } } });
  const record = await w.coordinator.run(tripPlan({}, humanSigned));
  assert.equal(record.state, "COMMITTED");
  const [a] = record.approvals;
  assert.equal(a.authentication.assurance, "human-signed");
  assert.equal(a.authentication.method, "webauthn");
  assert.equal(a.authentication.webauthn?.kid, `${alice}#passkey-1`);
  assert.equal(verifyHumanSignature(a, w.directory.get(alice)), undefined);
  assert.deepEqual(verifyRecord(record, w.keyring, { cards: w.directory }), { ok: true, problems: [] });
});

test("a human-signed group asks only humans with a passkey on their card", async () => {
  // Alice ranks first but has no passkey; Bob does.
  const w = buildWorld({ passkeys: ["bob"], script: { [alice]: { decision: "approve" }, [bob]: { decision: "approve", passkey: "sign" } } });
  const record = await w.coordinator.run(tripPlan({}, humanSigned));
  assert.equal(record.state, "COMMITTED");
  assert.deepEqual(w.asked, [bob]);
});

test("no one with a passkey: the group votes no before anyone is asked", async () => {
  const w = buildWorld({ script: { [alice]: { decision: "approve" } } });
  const record = await w.coordinator.run(tripPlan({}, humanSigned));
  assert.equal(record.state, "ABORTED");
  assert.deepEqual(w.asked, []);
});

test("an approve without a passkey does not count in a human-signed group", async () => {
  const w = buildWorld({ passkeys: ["alice"], script: { [alice]: { decision: "approve" } } });
  const record = await w.coordinator.run(tripPlan({}, humanSigned));
  assert.equal(record.state, "ABORTED");
  assert.deepEqual(w.effects.filter((e) => e.startsWith("payments")), []);
});

test("a reject needs no passkey", async () => {
  const w = buildWorld({ passkeys: ["alice"], script: { [alice]: { decision: "reject" } } });
  const record = await w.coordinator.run(tripPlan({}, humanSigned));
  assert.equal(record.state, "ABORTED");
  assert.equal(record.approvals[0].decision, "reject");
  assert.equal(record.approvals[0].authentication.assurance, "gateway-attested");
});

for (const [mode, why] of [
  ["wrong-challenge", "a signature over the reject challenge can't approve"],
  ["no-uv", "the passkey must verify the user, not just their presence"],
  ["wrong-origin", "an assertion made on another site is refused"],
  ["wrong-key", "a key not on the card is refused"],
] as const) {
  test(`bad assertion (${mode}): ${why}; the gateway escalates`, async () => {
    const w = buildWorld({ passkeys: ["alice", "carol"], script: { [alice]: { decision: "approve", passkey: mode }, "human://acme.com/carol": { decision: "approve", passkey: "sign" } } });
    const record = await w.coordinator.run(tripPlan({}, humanSigned));
    assert.equal(record.state, "COMMITTED");
    const [a] = record.approvals;
    assert.equal(a.approver, "human://acme.com/carol"); // alice's delegate
    assert.match(a.routingReason ?? "", /alice's decision was not accepted/);
  });
}

test("without a required assurance, a passkey approval still upgrades to human-signed", async () => {
  const w = buildWorld({ passkeys: ["alice"], script: { [alice]: { decision: "approve", passkey: "sign" } } });
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.approvals[0].authentication.assurance, "human-signed");
});

test("a channel can't claim human-signed without an assertion", async () => {
  const w = buildWorld({ passkeys: ["alice"], script: { [alice]: { decision: "approve", claimHumanSigned: true } } });
  assert.equal((await w.coordinator.run(tripPlan())).approvals[0].authentication.assurance, "gateway-attested");
  const strict = buildWorld({ passkeys: ["alice"], script: { [alice]: { decision: "approve", claimHumanSigned: true } } });
  assert.equal((await strict.coordinator.run(tripPlan({}, humanSigned))).state, "ABORTED");
});

test("verifyRecord catches a tampered assertion and an unverifiable human-signed group", async () => {
  const w = buildWorld({ passkeys: ["alice"], script: { [alice]: { decision: "approve", passkey: "sign" } } });
  const record = await w.coordinator.run(tripPlan({}, humanSigned));
  assert.match(verifyRecord(record, w.keyring).problems.join(), /pass the approvers' cards/);

  // Swap in Bob's card for Alice: the key the assertion names is not on it.
  const forged = structuredClone(record);
  forged.approvals[0].approver = bob;
  const problems = verifyRecord(forged, w.keyring, { cards: w.directory }).problems.join("; ");
  assert.match(problems, /bad signature/); // the gateway's signature no longer covers it
  assert.match(problems, /not a passkey on human:\/\/acme.com\/bob's card/);
});

test("the coordinator refuses a human-signed approval whose passkey signature fails", async () => {
  const w = buildWorld({ passkeys: ["alice"], script: { [alice]: { decision: "approve", passkey: "sign" } } });
  // Cards that list a different passkey for Alice, as if her key had been replaced since.
  const replaced = new FakeAuthenticator(`${alice}#passkey-1`);
  const card = { ...w.directory.get(alice)!, keys: [replaced.key] };
  const coordinator = createCoordinator({
    id: "agent://acme.com/coordinator-2",
    signer: createSigner("agent://acme.com/coordinator-2"),
    participants: (id) => [w.airline, w.hotel, w.calendar, w.payments, w.gateway].find((p) => p.id === id),
    gateways: { "acme.com": w.gateway.id },
    keyring: w.keyring,
    cards: { get: (id) => (id === alice ? card : w.directory.get(id)) },
  });
  const record = await coordinator.run(tripPlan({}, humanSigned));
  assert.equal(record.state, "ABORTED");
  assert.ok(record.events.some((e) => /passkey signature does not verify|another credential/.test(JSON.stringify(e.data))));
});

test("Ed25519 passkeys verify too", () => {
  const auth = new FakeAuthenticator("human://acme.com/x#pk", "acme.com", "EdDSA");
  const challenge = approvalChallenge({ txnId: "t", groupId: "g", planDigest: "sha256:x", decision: "approve", approver: "human://acme.com/x", nonce: "n" });
  assert.equal(verifyAssertion(auth.assert(challenge), auth.key, challenge), undefined);
});

test("localhost is accepted over http; other hosts need https", () => {
  const auth = new FakeAuthenticator("human://acme.com/x#pk", "localhost");
  const c = approvalChallenge({ txnId: "t", groupId: "g", planDigest: "sha256:x", decision: "approve", approver: "human://acme.com/x", nonce: "n" });
  assert.equal(verifyAssertion(auth.assert(c, { origin: "http://localhost:4321" }), auth.key, c), undefined);
  const remote = new FakeAuthenticator("human://acme.com/y#pk", "acme.com");
  assert.match(verifyAssertion(remote.assert(c, { origin: "http://gateway.acme.com" }), remote.key, c) ?? "", /origin/);
  assert.match(verifyAssertion(remote.assert(c, { origin: "https://notacme.com" }), remote.key, c) ?? "", /origin/);
});
