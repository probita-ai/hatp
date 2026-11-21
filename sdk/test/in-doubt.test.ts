// Calls that never answer (spec/hatp-journal.md J§5.4, #113) and Recorder crash recovery (J§6.4, #114).
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { callDigest, createRecorder, createSigner, executeReceipt, HatpError, KeyRing, readRecorderLog, RecorderFileLog, signObject, verifyRecord, verifyRunRecord } from "../src/index.ts";
import type { JournalResult, JournalServer, Participant, Receipt, RecorderLogItem, RecorderOptions, ResolvedEvent, RunRecord, Signer } from "../src/index.ts";

const schema = JSON.parse(readFileSync(new URL("../../spec/schemas/hatp.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
ajv.addSchema(schema);
const fits = (r: RunRecord) => {
  const v = ajv.getSchema(`${schema.$id}#/$defs/RunRecord`)!;
  assert.ok(v(JSON.parse(JSON.stringify(r))), ajv.errorsText(v.errors));
};

const dana = "human://acme.com/dana";
const agent = "agent://acme.com/sales-bot";
const never = () => new Promise<never>(() => {});

/**
 * A journal CRM that does what J§5.4 asks of a participant: a repeated (runId, entryId) is performed at most once
 * and answered with the same result. `lose` performs the call and drops the reply; `down` fails before performing.
 */
function crm() {
  const signer = createSigner("mcp://crm.acme.com/hatp");
  const performed = new Map<string, JournalResult>();
  const deals = new Map<string, { stage: string; version: number }>();
  const reversed = new Map<string, Receipt>();
  const s = {
    id: signer.id, signer, deals, performed,
    attempts: 0,
    lose: 0, down: 0, hang: false, refuse: false, hangCompensate: false, compensations: 0,
    undo: { update_deal: { kind: "compensate" as const, windowSeconds: 3600 }, charge: { kind: "compensate" as const, windowSeconds: 3600 } },
    amountFrom: { charge: "/amount" },
    async call({ tool, arguments: args, journal }: Parameters<JournalServer["call"]>[0]) {
      s.attempts++;
      if (s.hang) return never();
      if (s.down > 0) { s.down--; throw new Error("connection refused"); }
      if (s.refuse) throw new HatpError("APPROVAL_REQUIRED", "this tool needs an approval");
      const key = `${journal.runId}/${journal.entryId}`;
      let res = performed.get(key);
      if (!res) {
        const id = String(args.deal ?? "charge");
        const d = deals.get(id) ?? { stage: "Proposal", version: 0 };
        const before = d.stage;
        deals.set(id, { stage: String(args.stage ?? before), version: d.version + 1 });
        res = {
          entryId: journal.entryId,
          undo: { kind: "compensate", undoBy: new Date(Date.now() + 3600_000).toISOString() },
          compensationToken: `ctk_${key}`,
          effect: { summary: `${id}: ${before} → ${String(args.stage)}`, resource: `crm://acme/deal/${id}`, version: `v${d.version + 1}`, uses: [] },
          receipt: executeReceipt(signer, { runId: journal.runId, entryId: journal.entryId, callDigest: callDigest({ runId: journal.runId, entryId: journal.entryId, tool, arguments: args }) }),
        };
        performed.set(key, res);
      }
      if (s.lose > 0) { s.lose--; throw new Error("socket hang up"); }
      return { result: { ok: true }, journal: res };
    },
    async compensate(req: Parameters<NonNullable<JournalServer["compensate"]>>[0]) {
      if (s.hangCompensate) return never();
      const done = reversed.get(req.compensationToken);
      if (done) return { receipt: done }; // idempotent (§7.4)
      s.compensations++;
      const receipt = signObject<Receipt>({ type: "hatp.receipt", txnId: req.txnId, branchId: req.branchId, planDigest: req.planDigest, phase: "compensate", outcome: "reversed", detail: { effect: { summary: "restored", sideEffects: [] } }, issuedAt: new Date().toISOString(), issuer: signer.id }, signer);
      reversed.set(req.compensationToken, receipt);
      return { receipt };
    },
  } satisfies JournalServer & Record<string, unknown>;
  return s;
}

/** A server that knows nothing about HATP, and so must never be asked twice. */
function legacy() {
  const s = { id: "mcp://notes.example", attempts: 0, fail: true, async call() { s.attempts++; if (s.fail) throw new Error("timeout"); return { result: { ok: true } }; } };
  return s;
}

/** A gateway that approves every Reversal Plan at once. */
const yes: Participant = { id: "mcp://gateway.acme.com/hatp", async prepare() { return { vote: "yes", approvals: [] } as never; } } as unknown as Participant;

function world(o: { crm?: ReturnType<typeof crm>; notes?: ReturnType<typeof legacy>; signer?: Signer; log?: RecorderLogItem[]; extra?: Partial<RecorderOptions> } = {}) {
  const c = o.crm ?? crm();
  const notes = o.notes ?? legacy();
  const signer = o.signer ?? createSigner("mcp://recorder.acme.com/hatp");
  const keyring = new KeyRing().add(c.signer.publicJwk);
  const servers = new Map<string, JournalServer>([[c.id, c], [notes.id, notes]]);
  const log = o.log ?? [];
  const recorder = createRecorder({
    id: signer.id, signer, servers: (id) => servers.get(id), keyring,
    inDoubt: { retries: 2, retryMs: 1 },
    reversal: { gateway: yes, approver: "human://acme.com/role/team-lead", selfApprove: true, retries: 0, retryMs: 1 },
    log: { append: (i) => log.push(i) },
    ...o.extra,
  });
  const verify = (r: RunRecord) => verifyRunRecord(r, { recorderKeys: [signer.publicJwk], keyring });
  return { recorder, crm: c, notes, signer, keyring, log, verify };
}

// ---------------------------------------------------------------------------------------------
// #113: calls that never answer

test("a lost reply is retried, and the journal server performs the call once", async () => {
  const w = world();
  w.crm.lose = 1;
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  const { entry } = await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { deal: "D-881", stage: "Won" } });
  assert.equal(w.crm.attempts, 2);
  assert.equal(w.crm.performed.size, 1, "performed once");
  assert.equal(w.crm.deals.get("D-881")?.version, 1);
  assert.equal(entry.outcome, undefined);
  assert.equal(entry.undo?.kind, "compensate", "the retry's answer is the participant's, so it is reversible");
  const record = await w.recorder.closeRun(runId);
  assert.deepEqual(w.verify(record), { ok: true, problems: [] });
});

test("a server without the journal is never asked twice: its call is in doubt at once", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  const err = await w.recorder.call(runId, { participant: w.notes.id, tool: "append", arguments: {} }).catch((e) => e);
  assert.match(String(err), /timeout/);
  assert.equal(err.entry.outcome, "in-doubt", "the agent's error carries the entry");
  assert.equal(w.notes.attempts, 1);
  await assert.rejects(w.recorder.resolve(runId, "e1"), (e: unknown) => e instanceof HatpError && e.code === "NOT_SUPPORTED");
  const record = await w.recorder.closeRun(runId);
  assert.deepEqual(w.verify(record), { ok: true, problems: [] });
  fits(record);
});

test("an HATP error is an answer: the call is recorded as not run, with no receipt", async () => {
  const w = world();
  w.crm.refuse = true;
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await assert.rejects(w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { deal: "D-881", stage: "Won" } }), (e: unknown) => e instanceof HatpError && e.code === "APPROVAL_REQUIRED");
  assert.equal(w.crm.attempts, 1, "a refusal is not retried");
  const record = await w.recorder.closeRun(runId);
  assert.equal(record.entries[0].outcome, "not-run");
  assert.match(record.entries[0].reason ?? "", /refused by mcp:\/\/crm.acme.com\/hatp: APPROVAL_REQUIRED/);
  assert.equal(record.entries[0].receipt, undefined);
  assert.deepEqual(w.verify(record), { ok: true, problems: [] });
  fits(record);
});

test("an in-doubt entry is never reversed, doesn't block later entries, and still counts toward spending caps", async () => {
  const w = world({ extra: { autonomy: { policy: { unknown: "allow", none: "allow", compensateViaUi: "allow", spend: { perRun: { value: 100, currency: "USD" } } } } } });
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  w.crm.down = 3;
  await assert.rejects(w.recorder.call(runId, { participant: w.crm.id, tool: "charge", arguments: { amount: { value: 80, currency: "USD" } } }));
  await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { deal: "D-881", stage: "Won" } });
  assert.deepEqual(w.recorder.get(runId).spend, { perRun: [{ value: 80, currency: "USD" }] }, "it may have moved the money, so it counts");

  const review = w.recorder.review(runId);
  assert.deepEqual(review.inDoubt.map((i) => i.entryId), ["e1"]);
  const r = await w.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: dana });
  assert.notEqual(r.state, "NOTHING_TO_REVERSE");
  if (r.state === "NOTHING_TO_REVERSE") return;
  assert.deepEqual(r.plan.notReversible?.map((n) => [n.entryId, n.reason.split(":")[0]]), [["e1", "in doubt"]]);
  assert.deepEqual(r.outcomes, { e2: "reversed" }, "e2 depends on e1 by default, and is reversed anyway");
});

test("resolve: asked again later, an answer is chained as a resolution, and the entry becomes reversible", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  w.crm.lose = 3; // performed on the first attempt, every reply lost
  await assert.rejects(w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { deal: "D-881", stage: "Won" } }));
  w.crm.down = 3;
  assert.equal((await w.recorder.resolve(runId, "e1")).state, "in-doubt", "still no answer: stays in doubt, nothing chained");
  assert.equal(w.recorder.get(runId).events.length, 0);

  const res = await w.recorder.resolve(runId, "e1");
  assert.equal(res.state, "done");
  assert.equal(res.entry.undo?.kind, "compensate");
  assert.equal(w.crm.performed.size, 1, "performed once, across every attempt");
  await assert.rejects(w.recorder.resolve(runId, "e1"), (e: unknown) => e instanceof HatpError && e.code === "INVALID_STATE");

  const r = await w.recorder.reverse(runId, { scope: { entries: ["e1"] }, requestedBy: dana });
  assert.equal(r.state, "COMMITTED");
  const record = await w.recorder.closeRun(runId);
  assert.equal(record.entries[0].outcome, "in-doubt", "the entry itself is never edited");
  assert.deepEqual(record.events.map((e) => e.type), ["resolved", "reversal"]);
  assert.deepEqual(w.verify(record), { ok: true, problems: [] });
  fits(record);
});

test("the verifier refuses a forged resolution, a second one, or an in-doubt entry that claims undo", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  w.crm.lose = 3;
  await assert.rejects(w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { deal: "D-881", stage: "Won" } }));
  await w.recorder.resolve(runId, "e1");
  const good = w.recorder.get(runId);
  const resign = (r: RunRecord) => signObject<RunRecord>({ ...r, signature: undefined }, w.signer);
  const problems = (r: RunRecord) => w.verify(resign(r)).problems.join("\n");

  const ev = good.events[0] as ResolvedEvent;
  const forged = { ...ev, receipt: { ...ev.receipt!, callDigest: "sha256:" + "B".repeat(43) } };
  assert.match(problems({ ...good, events: [forged] }), /receipt is for another call/);
  assert.match(problems({ ...good, events: [ev, { ...ev, prevHash: "sha256:x" }] }), /resolved more than once/);
  assert.match(problems({ ...good, entries: [{ ...good.entries[0], undo: { kind: "compensate", undoBy: ev.undo!.undoBy } }] }), /in doubt, but carries undo information/);
});

// ---------------------------------------------------------------------------------------------
// #114: Recorder crash recovery

test("a crash while a call is in flight: the restarted Recorder asks the journal server again and records the answer", async () => {
  const c = crm();
  const signer = createSigner("mcp://recorder.acme.com/hatp");
  const first = world({ crm: c, signer });
  const runId = first.recorder.startRun({ agent, onBehalfOf: dana, purpose: "Tidy up the Q4 pipeline" });
  await first.recorder.call(runId, { participant: c.id, tool: "update_deal", arguments: { deal: "D-1", stage: "Won" } });
  // The process dies after the call left: the participant performed it, the Recorder never heard back.
  const lost = c.call.bind(c);
  c.call = async (req) => { await lost(req); return never(); };
  void first.recorder.call(runId, { participant: c.id, tool: "update_deal", arguments: { deal: "D-2", stage: "Lost" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(first.log.map((l) => l.kind), ["run", "intent", "item", "intent"], "the intent is logged before the call leaves");

  c.call = lost;
  const second = world({ crm: c, signer });
  const out = await second.recorder.recover(first.log);
  assert.deepEqual(out.runs, [runId]);
  assert.equal(out.recorded.length, 1);
  assert.equal(out.recorded[0].entryId, "e2");
  assert.equal(out.recorded[0].undo?.kind, "compensate", "the journal server's answer, so it can be undone");
  assert.equal(c.performed.size, 2, "the retry did not perform D-2 again");

  // The run carries on where it was, gap-free and in one chain.
  const { entry } = await second.recorder.call(runId, { participant: c.id, tool: "update_deal", arguments: { deal: "D-3", stage: "Won" } });
  assert.equal(entry.seq, 3);
  const record = await second.recorder.closeRun(runId);
  assert.deepEqual(second.verify(record), { ok: true, problems: [] });
  fits(record);
});

test("a crash while a call to a server without the journal is in flight: it is recorded in doubt, never sent again", async () => {
  const notes = legacy();
  const signer = createSigner("mcp://recorder.acme.com/hatp");
  const log: RecorderLogItem[] = [];
  const first = world({ notes, signer, log });
  const runId = first.recorder.startRun({ agent });
  notes.call = async () => { notes.attempts++; return never(); };
  void first.recorder.call(runId, { participant: notes.id, tool: "append", arguments: { text: "hi" } });
  await new Promise((r) => setTimeout(r, 5));

  const second = world({ notes, signer, log: [] });
  const out = await second.recorder.recover(log);
  assert.equal(notes.attempts, 1);
  assert.equal(out.recorded[0].outcome, "in-doubt");
  assert.match(out.recorded[0].reason ?? "", /stopped before recording the call/);
  assert.deepEqual(second.verify(await second.recorder.closeRun(runId)), { ok: true, problems: [] });
});

test("recovery restores spending totals and review state, survives a torn last line, and refuses a tampered log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hatp-recorder-"));
  const path = join(dir, "recorder.log");
  const signer = createSigner("mcp://recorder.acme.com/hatp");
  const c = crm();
  const policy = { unknown: "allow" as const, none: "allow" as const, compensateViaUi: "allow" as const, spend: { perRun: { value: 100, currency: "USD" } } };
  const first = createRecorder({ id: signer.id, signer, servers: () => c, keyring: new KeyRing().add(c.signer.publicJwk), autonomy: { policy }, log: new RecorderFileLog(path) });
  const runId = first.startRun({ agent, onBehalfOf: dana });
  await first.call(runId, { participant: c.id, tool: "charge", arguments: { amount: { value: 60, currency: "USD" } } });
  first.acknowledge(runId, dana);
  appendFileSync(path, '{"kind":"intent","intent":{"runId'); // the process died mid-write

  const items = readRecorderLog(path);
  assert.equal(items.length, 4, "the torn line is skipped");
  const gateway = { askApprove: async () => ({ decision: "reject" as const, approvals: [] }) } as never;
  const second = createRecorder({ id: signer.id, signer, servers: () => c, keyring: new KeyRing().add(c.signer.publicJwk), autonomy: { policy: { ...policy, approver: "human://acme.com/role/team-lead" }, gateway } });
  await second.recover(items);
  assert.deepEqual(second.get(runId).spend, { perRun: [{ value: 60, currency: "USD" }] });
  assert.equal(second.review(runId).reviewed?.by, dana);
  // 60 + 60 passes the cap of 100: the restored total turns allow into ask, and the ask is rejected.
  await assert.rejects(second.call(runId, { participant: c.id, tool: "charge", arguments: { amount: { value: 60, currency: "USD" } } }), (e: unknown) => e instanceof HatpError && e.code === "APPROVAL_REQUIRED");

  const tampered = items.map((i) => (i.kind === "item" && i.item.type === "hatp.journal.entry" ? { ...i, item: { ...i.item, tool: "something_else" } } : i));
  const third = createRecorder({ id: signer.id, signer, servers: () => c });
  await assert.rejects(third.recover(tampered), (e: unknown) => e instanceof HatpError && e.code === "INVALID_STATE" && /breaks its hash chain/.test(e.message));
  await assert.rejects(second.recover(items), /already open/);
});

test("a crash mid-reversal: the logged decision is finished after the restart, and each entry is compensated once", async () => {
  const c = crm();
  const signer = createSigner("mcp://recorder.acme.com/hatp");
  const first = world({ crm: c, signer });
  const runId = first.recorder.startRun({ agent, onBehalfOf: dana });
  await first.recorder.call(runId, { participant: c.id, tool: "update_deal", arguments: { deal: "D-1", stage: "Won" } });
  await first.recorder.call(runId, { participant: c.id, tool: "update_deal", arguments: { deal: "D-2", stage: "Won" } });
  // The first compensation succeeds, then the process dies during the second.
  const real = c.compensate.bind(c);
  let n = 0;
  c.compensate = async (req) => (++n === 1 ? real(req) : never());
  void first.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: dana });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(first.log.some((l) => l.kind === "reversal"), "the decision is logged before any compensation");
  assert.equal(c.compensations, 1);

  c.compensate = real;
  const second = world({ crm: c, signer });
  const out = await second.recorder.recover(first.log);
  assert.equal(out.reversals.length, 1);
  const r = out.reversals[0];
  if (r.state === "NOTHING_TO_REVERSE") assert.fail();
  assert.equal(r.state, "COMMITTED");
  assert.deepEqual(r.outcomes, { e2: "reversed", e1: "reversed" });
  assert.equal(c.compensations, 2, "compensate is idempotent: the one already done was answered from the participant's record");
  assert.ok(r.record.events.some((e) => e.type === "recovered"));
  assert.deepEqual(verifyRecord(r.record, new KeyRing().add(c.signer.publicJwk, signer.publicJwk)), { ok: true, problems: [] });
  const record = second.recorder.get(runId);
  assert.deepEqual(record.events.map((e) => e.type), ["reversal"]);
  assert.deepEqual(second.verify(record), { ok: true, problems: [] });
  assert.deepEqual(second.recorder.review(runId).closed.map((i) => i.reason), ["reversed", "reversed"]);
});
