// The Recorder (spec/hatp-journal.md J§5–J§6, #56): journaled calls, one hash chain, signed Run Records.
// The first case plants an `unknown` entry on purpose, as the planted violations do for transactions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createRecorder, createSigner, executeReceipt, HatpError, KeyRing, signObject, verifyRunRecord } from "../src/index.ts";
import type { JournalResult, JournalServer, RunRecord, Reminder, Signer, UndoDeclaration } from "../src/index.ts";

const dana = "human://acme.com/dana";
const agent = "agent://acme.com/sales-bot";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const schema = JSON.parse(readFileSync(new URL("../../spec/schemas/hatp.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
ajv.addSchema(schema);
const fitsSchema = (r: RunRecord) => {
  const v = ajv.getSchema(`${schema.$id}#/$defs/RunRecord`)!;
  assert.ok(v(JSON.parse(JSON.stringify(r))), ajv.errorsText(v.errors));
};

/** A CRM that supports the journal: it reports each effect, signs a receipt and issues compensation tokens. */
function crm(o: { signer?: Signer; undo?: Record<string, UndoDeclaration>; tamper?: (r: JournalResult) => JournalResult; fail?: string } = {}): JournalServer & { signer: Signer; calls: string[] } {
  const signer = createSigner("mcp://crm.acme.com/hatp");
  const sign = o.signer ?? signer;
  const undo: Record<string, UndoDeclaration> = o.undo ?? {
    create_contact: { kind: "compensate", windowSeconds: 604800 },
    update_deal: { kind: "compensate", windowSeconds: 86400 },
    send_email: { kind: "none", reason: "Delivered to external recipients" },
  };
  const calls: string[] = [];
  let version = 0;
  return {
    id: signer.id, signer, undo, calls,
    async call({ tool, arguments: args, journal }) {
      calls.push(tool);
      if (o.fail === tool) throw new Error("socket hang up");
      const d = undo[tool];
      const resource = tool === "create_contact" ? `crm://acme/contact/${args.name}` : tool === "update_deal" ? `crm://acme/deal/${args.deal}` : undefined;
      const res: JournalResult = {
        entryId: journal.entryId,
        undo: d?.kind === "compensate" ? { kind: "compensate", undoBy: new Date(Date.now() + (d.windowSeconds ?? 60) * 1000).toISOString() } : { kind: "none" },
        compensationToken: d?.kind === "compensate" ? `ctk_${journal.entryId}` : undefined,
        effect: { summary: `${tool} ${JSON.stringify(args)}`, resource, version: `v${++version}`, uses: tool === "update_deal" ? [`crm://acme/contact/${args.contact}`] : tool === "create_contact" ? [] : undefined },
        receipt: executeReceipt(sign, { runId: journal.runId, entryId: journal.entryId, callDigest: digestOf(journal.runId, journal.entryId, tool, args) }),
      };
      return { result: { ok: true }, journal: o.tamper ? o.tamper(res) : res };
    },
  };
}
// The participant computes the digest itself, from what it received.
import { callDigest } from "../src/index.ts";
const digestOf = (runId: string, entryId: string, tool: string, args: Record<string, unknown>) => callDigest({ runId, entryId, tool, arguments: args });

/** A server that knows nothing about HATP. */
const legacy = (): JournalServer & { calls: string[] } => {
  const calls: string[] = [];
  return { id: "mcp://notes.example", calls, async call({ tool }) { calls.push(tool); return { result: { ok: true } }; } };
};

function world(o: { crm?: ReturnType<typeof crm>; review?: { remindBeforeSeconds: number; escalateBeforeSeconds?: number }; onReminder?: (r: Reminder) => void; keepArguments?: boolean } = {}) {
  const c = o.crm ?? crm();
  const notes = legacy();
  const signer = createSigner("mcp://recorder.acme.com/hatp");
  const keyring = new KeyRing().add(c.signer.publicJwk);
  const servers = new Map<string, JournalServer>([[c.id, c], [notes.id, notes]]);
  const recorder = createRecorder({ id: signer.id, signer, servers: (id) => servers.get(id), keyring, review: o.review, onReminder: o.onReminder, keepArguments: o.keepArguments });
  const verify = (r: RunRecord) => verifyRunRecord(r, { recorderKeys: [signer.publicJwk], keyring });
  return { recorder, signer, crm: c, notes, keyring, verify };
}

test("planted unknown: a call to a server without the journal is recorded, signed, and handled by the chain", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana, purpose: "Tidy up the Q4 pipeline" });
  const e1 = (await w.recorder.call(runId, { participant: w.crm.id, tool: "create_contact", arguments: { name: "C-17" } })).entry;
  const e2 = (await w.recorder.call(runId, { participant: w.notes.id, tool: "append_note", arguments: { text: "called Globex" } })).entry;
  const e3 = (await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { deal: "D-881", stage: "Won", contact: "C-17" } })).entry;
  const e4 = (await w.recorder.call(runId, { participant: w.notes.id, tool: "append_note", arguments: { text: "done" } })).entry;
  const record = await w.recorder.closeRun(runId);

  // The planted entry: real, signed by the Recorder only, and never reversible.
  assert.deepEqual(e2.undo, { kind: "unknown" });
  assert.equal(e2.receipt?.issuer, w.recorder.id);
  assert.equal(e2.compensationToken, undefined);
  assert.equal(e2.intake, undefined, "an unknown entry is not a broken one");

  // Participant entries carry the participant's word; links say where they came from.
  assert.equal(e1.undo?.kind, "compensate");
  assert.equal(e1.receipt?.issuer, w.crm.id);
  assert.deepEqual(e1.dependsOn, [], "create_contact declared it used nothing");
  assert.deepEqual(e3.dependsOn, [{ entryId: "e1", source: "declared" }], "update_deal declared it used the contact e1 created");
  assert.deepEqual(e4.dependsOn.map((l) => [l.entryId, l.source]), [["e1", "default"], ["e2", "default"], ["e3", "default"]], "nobody said: every earlier entry");

  assert.deepEqual(w.verify(record), { ok: true, problems: [] });
  fitsSchema(record);
  assert.deepEqual(record.entries.map((e) => e.seq), [1, 2, 3, 4]);

  const review = w.recorder.review(runId);
  assert.deepEqual(review.reversible.map((i) => i.entryId), ["e3", "e1"], "earliest window first: update_deal (1 day) before create_contact (7 days)");
  assert.deepEqual(review.irreversible.map((i) => i.entryId), ["e2", "e4"]);
  assert.match(review.irreversible[0].reason ?? "", /does not journal/);
});

test("a Recorder can't rewrite history: removing, reordering, editing or upgrading an entry breaks the record", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: w.crm.id, tool: "create_contact", arguments: { name: "C-17" } });
  await w.recorder.call(runId, { participant: w.notes.id, tool: "append_note", arguments: { text: "x" } });
  await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { deal: "D-881", stage: "Won", contact: "C-17" } });
  const honest = await w.recorder.closeRun(runId);
  // Each forgery is re-signed with the Recorder's own key: only the chain and participants' receipts can catch it.
  const forge = (f: (r: RunRecord) => void) => { const r = structuredClone(honest); delete r.signature; f(r); return w.verify(signObject(r, w.signer)); };
  const has = (v: { ok: boolean; problems: string[] }, re: RegExp) => { assert.equal(v.ok, false); assert.ok(v.problems.some((p) => re.test(p)), v.problems.join("\n")); };

  has(forge((r) => { r.entries.splice(1, 1); }), /seq 3, expected 2|chain covers/);
  has(forge((r) => { r.entries.splice(1, 1); r.entries[1].seq = 2; }), /chain covers/);
  has(forge((r) => { [r.entries[0], r.entries[1]] = [r.entries[1], r.entries[0]]; r.entries[0].seq = 1; r.entries[1].seq = 2; }), /chain|seq/);
  has(forge((r) => { r.entries[2].arguments = { deal: "D-999", stage: "Won", contact: "C-17" }; }), /arguments don't match callDigest/);
  has(forge((r) => { r.entries[1].undo = { kind: "compensate", undoBy: "2099-01-01T00:00:00Z" }; r.entries[1].compensationToken = "ctk_fake"; }), /needs the participant's receipt/);
  has(forge((r) => { r.entries[0].receipt!.callDigest = r.entries[1].callDigest; }), /receipt is for another call|does not verify/);
  // And without a re-signature, any change at all is caught by the Recorder's signature.
  const edited = structuredClone(honest);
  edited.purpose = "something else";
  has(w.verify(edited), /Recorder's signature/);
});

test("intake: an entry that fails a check is recorded as unresolved, never dropped", async () => {
  const stranger = createSigner("mcp://crm.acme.com/hatp", "mcp://crm.acme.com/hatp#key-9");
  const w = world({ crm: crm({ signer: stranger }) }); // receipts signed with a key the keyring doesn't hold
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  const bad = (await w.recorder.call(runId, { participant: w.crm.id, tool: "create_contact", arguments: { name: "C-17" } })).entry;
  assert.deepEqual(bad.intake?.problems, ["participant receipt does not verify"]);
  const ghost = (await w.recorder.call(runId, { participant: w.notes.id, tool: "append_note", arguments: {}, uses: ["e9"] })).entry;
  assert.deepEqual(ghost.intake?.problems, ["dependsOn e9: no such earlier entry"]);
  assert.deepEqual(w.recorder.review(runId).unresolved.map((i) => i.entryId), ["e1", "e2"]);
  const record = await w.recorder.closeRun(runId);
  fitsSchema(record);
  // The record is honest about the broken entries; only the bad receipt itself fails offline too.
  const v = w.verify(record);
  assert.deepEqual(v.problems, ["entry e1: participant receipt does not verify"]);
});

test("a participant can't make a call more reversible than its declaration, or vouch for an undeclared one", async () => {
  const w = world({
    crm: crm({
      undo: { send_email: { kind: "none", reason: "Delivered" }, update_deal: { kind: "compensate" } as UndoDeclaration },
      tamper: (r) => ({ ...r, undo: { kind: "compensate", undoBy: new Date(Date.now() + 1e6).toISOString() }, compensationToken: "ctk" }),
    }),
  });
  const runId = w.recorder.startRun({ agent });
  const email = (await w.recorder.call(runId, { participant: w.crm.id, tool: "send_email", arguments: { to: "buyer@globex.com" } })).entry;
  assert.equal(email.undo?.kind, "none");
  assert.equal(email.compensationToken, undefined, "a none entry holds no token");
  assert.match(email.intake?.problems[0] ?? "", /declared none but returned compensate/);
  const invalid = (await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { deal: "D-1" } })).entry;
  assert.equal(invalid.undo?.kind, "unknown", "a compensate declaration without windowSeconds is invalid");
  assert.match(invalid.intake?.problems[0] ?? "", /invalid: compensate needs a positive windowSeconds/);
  const undeclared = (await w.recorder.call(runId, { participant: w.crm.id, tool: "export_report", arguments: {} })).entry;
  assert.equal(undeclared.undo?.kind, "unknown");
});

test("a call that never answers is retried, then recorded in doubt, and the agent still gets the error", async () => {
  const w = world({ crm: crm({ fail: "update_deal" }) });
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await assert.rejects(w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { deal: "D-881" } }), /socket hang up/);
  const record = await w.recorder.closeRun(runId);
  const [e] = record.entries;
  assert.equal(w.crm.calls.length, 3, "a journal server is asked again: it performs a repeated entry at most once");
  assert.equal(e.outcome, "in-doubt");
  assert.deepEqual(e.undo, { kind: "unknown" });
  assert.equal(e.receipt?.outcome, "in-doubt");
  assert.equal(e.intake, undefined, "in doubt is not broken");
  assert.match(e.reason ?? "", /no answer after 3 attempts: socket hang up; whether it took effect is unknown/);
  assert.deepEqual(w.verify(record), { ok: true, problems: [] });
  fitsSchema(record);
});

test("without keepArguments, entries hold only the call digest, and still verify", async () => {
  const w = world({ keepArguments: false });
  const runId = w.recorder.startRun({ agent });
  await w.recorder.call(runId, { participant: w.crm.id, tool: "create_contact", arguments: { name: "Private Person" } });
  const record = await w.recorder.closeRun(runId);
  assert.equal(record.entries[0].arguments, undefined);
  assert.ok(!("arguments" in JSON.parse(JSON.stringify(record.entries[0]))), "only the digest binds the entry to its arguments");
  assert.deepEqual(w.verify(record), { ok: true, problems: [] });
});

test("calls in one run are recorded in order even when the agent doesn't wait, and a closed run takes no more", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent });
  const calls = ["a", "b", "c"].map((name) => w.recorder.call(runId, { participant: w.crm.id, tool: "create_contact", arguments: { name } }));
  const entries = (await Promise.all(calls)).map((r) => r.entry);
  assert.deepEqual(entries.map((e) => [e.seq, e.arguments?.name]), [[1, "a"], [2, "b"], [3, "c"]]);
  w.recorder.acknowledge(runId, dana);
  const record = await w.recorder.closeRun(runId);
  assert.deepEqual(w.verify(record), { ok: true, problems: [] });
  assert.equal(record.events[0].type, "reviewed");
  await assert.rejects(w.recorder.call(runId, { participant: w.crm.id, tool: "create_contact", arguments: {} }), (e: unknown) => e instanceof HatpError && e.code === "INVALID_STATE");
  assert.throws(() => w.recorder.get("run_nope"), (e: unknown) => e instanceof HatpError && e.code === "RUN_UNKNOWN");
});

test("reminders go out before an undo window closes, escalate if unreviewed, and stop once someone looks", async () => {
  const reminders: Reminder[] = [];
  const short = crm({ undo: { update_deal: { kind: "compensate", windowSeconds: 1 } } });
  const w = world({ crm: short, review: { remindBeforeSeconds: 0.95, escalateBeforeSeconds: 0.5 }, onReminder: (r) => reminders.push(r) });
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: short.id, tool: "update_deal", arguments: { deal: "D-1" } });
  await wait(150);
  assert.deepEqual(reminders.map((r) => [r.to, r.onBehalfOf, r.entries[0].entryId]), [["principal", dana, "e1"]]);
  w.recorder.acknowledge(runId, dana);
  await wait(500);
  assert.equal(reminders.length, 1, "acknowledged: no escalation");

  // A second run left unreviewed escalates to the approver.
  const run2 = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(run2, { participant: short.id, tool: "update_deal", arguments: { deal: "D-2" } });
  await wait(650);
  assert.deepEqual(reminders.slice(1).map((r) => r.to), ["principal", "approver"]);
  assert.equal(w.recorder.review(run2).closed.length, 0);
  await wait(400);
  assert.deepEqual(w.recorder.review(run2).closed.map((i) => i.entryId), ["e1"], "after the window, the entry shows as closed");
  w.recorder.stop();
});
