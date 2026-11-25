// Reversal (spec/hatp-journal.md J§8, #57): the reversal set, checks, a Reversal Plan approved through the
// Human Gateway, compensation latest first, and a Reversal Record that verifies offline.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { callDigest, createHumanGateway, createRecorder, createSigner, Directory, executeReceipt, HatpError, KeyRing, signCard, signObject, verifyRecord, verifyRunRecord } from "../src/index.ts";
import type { Ask, HumanChannel, HumanDecision, JournalCheckResult, JournalReceipt, JournalServer, Receipt, ReversalRecord, ReverseResult, Signer, UndoDeclaration } from "../src/index.ts";

const schema = JSON.parse(readFileSync(new URL("../../spec/schemas/hatp.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
ajv.addSchema(schema);
const fits = (def: string, value: unknown) => {
  const v = ajv.getSchema(`${schema.$id}#/$defs/${def}`)!;
  assert.ok(v(JSON.parse(JSON.stringify(value))), `${def}: ${ajv.errorsText(v.errors)}`);
};

const dana = "human://acme.com/dana";
const erin = "human://acme.com/erin";
const lead = "human://acme.com/role/team-lead";
const agent = "agent://acme.com/sales-bot";

/** A tool server with versioned records it can really put back, and a switchboard for failures. */
function server(id: string, undo: Record<string, UndoDeclaration>, o: { check?: boolean } = {}) {
  const signer = createSigner(id);
  const records = new Map<string, { value: unknown; version: number; history: unknown[] }>();
  const tokens = new Map<string, { resource: string; before: unknown }>();
  const fail = new Map<string, "error" | "silent" | "in-doubt" | "lost">(); // entryId → how its compensation fails
  const compensated: string[] = [];
  const resourceOf = (tool: string, args: Record<string, unknown>) => `${id}/${tool.split("_")[1]}/${String(args.id)}`;
  const s: JournalServer & { signer: Signer; records: typeof records; fail: typeof fail; compensated: string[]; edit(resource: string, value: unknown): void } = {
    id, signer, undo, records, fail, compensated,
    edit(resource, value) { const r = records.get(resource)!; r.history.push(r.value); r.value = value; r.version++; },
    async call({ tool, arguments: args, journal }) {
      const d = undo[tool];
      const resource = resourceOf(tool, args);
      const cur = records.get(resource) ?? { value: undefined, version: 0, history: [] };
      tokens.set(`ctk_${journal.runId}_${journal.entryId}`, { resource, before: cur.value });
      records.set(resource, { value: args.value ?? args, version: cur.version + 1, history: [...cur.history, cur.value] });
      const uses = Array.isArray(args.uses) ? (args.uses as string[]) : [];
      return {
        result: { ok: true },
        journal: {
          entryId: journal.entryId,
          undo: d.kind === "compensate" ? { kind: "compensate", undoBy: new Date(Date.now() + d.windowSeconds! * 1000).toISOString() } : { kind: "none" },
          compensationToken: d.kind === "compensate" ? `ctk_${journal.runId}_${journal.entryId}` : undefined,
          effect: { summary: `${tool} ${String(args.id)}`, resource, version: args.unversioned ? undefined : `v${cur.version + 1}`, uses },
          receipt: executeReceipt(signer, { runId: journal.runId, entryId: journal.entryId, callDigest: callDigest({ runId: journal.runId, entryId: journal.entryId, tool, arguments: args }) }),
        },
      };
    },
    async compensate(req) {
      const how = fail.get(req.branchId);
      if (how === "error") throw new HatpError("COMPENSATION_FAILED", "the record is locked");
      if (how === "silent") throw new Error("socket hang up");
      if (how === "in-doubt") throw new HatpError("OUTCOME_UNKNOWN", "the reversal was running when this server stopped");
      const t = tokens.get(req.compensationToken);
      if (!t) throw new HatpError("COMPENSATION_FAILED", "unknown token");
      const r = records.get(t.resource)!;
      if (!req.force && req.ifVersion !== `v${r.version}`) throw new HatpError("UNDO_CONFLICT", `now at v${r.version}`);
      const versionBefore = `v${r.version}`;
      r.value = t.before; r.version++;
      compensated.push(req.branchId);
      if (how === "lost") { fail.delete(req.branchId); throw new Error("socket hang up"); } // it happened, but the answer is lost
      const receipt = signObject<Receipt>({
        type: "hatp.receipt", txnId: req.txnId, branchId: req.branchId, planDigest: req.planDigest, phase: "compensate", outcome: "reversed",
        detail: { effect: { summary: `restored ${t.resource}`, resource: t.resource, versionBefore, version: `v${r.version}`, sideEffects: undo[Object.keys(undo)[0]].sideEffects ?? [] } },
        issuedAt: new Date().toISOString(), issuer: id,
      }, signer);
      return { receipt };
    },
  };
  if (o.check !== false) {
    s.check = async (req): Promise<JournalCheckResult> => {
      const t = tokens.get(req.compensationToken)!;
      const r = records.get(t.resource)!;
      const conflict = req.ifVersion && req.ifVersion !== `v${r.version}` ? { currentVersion: `v${r.version}`, summary: `changed to ${JSON.stringify(r.value)} since` } : null;
      const receipt = signObject<JournalReceipt>({ type: "hatp.receipt", txnId: req.runId, branchId: req.entryId, callDigest: "sha256:" + "A".repeat(43), phase: "check", outcome: conflict ? "conflict" : "undoable", issuedAt: new Date().toISOString(), issuer: id }, signer);
      return { undoable: !conflict, conflict, sideEffects: undo[Object.keys(undo)[0]].sideEffects, receipt };
    };
  }
  return s;
}

function world(o: { decide?: (human: string) => HumanDecision["decision"] | undefined; selfApprove?: boolean; leadMembers?: string[] } = {}) {
  const crm = server("mcp://crm.acme.com/hatp", { create_contact: { kind: "compensate", windowSeconds: 3600 }, update_deal: { kind: "compensate", windowSeconds: 3600 } });
  const calendar = server("mcp://calendar.acme.com/hatp", { create_event: { kind: "compensate", windowSeconds: 3600, sideEffects: ["Attendees receive a cancellation notice"] } });
  const email = server("mcp://email.acme.com/hatp", { send_email: { kind: "none", reason: "Delivered to external recipients" } });
  const servers = new Map<string, JournalServer>([[crm.id, crm], [calendar.id, calendar], [email.id, email]]);

  const issuer = createSigner("https://directory.acme.com");
  const directory = new Directory([issuer.publicJwk]);
  for (const who of o.leadMembers ?? ["dana", "erin"]) {
    directory.add(signCard({ id: `human://acme.com/${who}`, displayName: who, org: "acme.com", roles: ["team-lead"], authority: [{ action: "approve.undo" }], channels: ["web"], availability: { status: "available" }, sla: { decideSeconds: 60 }, keys: [], issuer: issuer.id }, issuer));
  }
  const asks: Ask[] = [];
  const channel: HumanChannel = {
    deliver: (ask, human, signal) => new Promise((resolve, reject) => {
      asks.push(ask);
      signal.addEventListener("abort", () => reject(new Error("withdrawn")), { once: true });
      const d = (o.decide ?? (() => "approve"))(human.id);
      if (d) setTimeout(() => resolve({ decision: d, method: "test" }), 2);
    }),
  };
  const gatewaySigner = createSigner("mcp://gateway.acme.com/hatp");
  const gateway = createHumanGateway({ id: gatewaySigner.id, signer: gatewaySigner, directory, channel });
  const signer = createSigner("mcp://recorder.acme.com/hatp");
  const keyring = new KeyRing().add(crm.signer.publicJwk, calendar.signer.publicJwk, email.signer.publicJwk, gatewaySigner.publicJwk, signer.publicJwk);
  const recorder = createRecorder({
    id: signer.id, signer, servers: (id) => servers.get(id), keyring,
    reversal: { gateway, approver: lead, decideSeconds: 60, selfApprove: o.selfApprove, retries: 1, retryMs: 5 },
  });
  return { recorder, crm, calendar, email, gateway, asks, keyring, signer };
}

type W = ReturnType<typeof world>;
const done = (r: ReverseResult) => { assert.notEqual(r.state, "NOTHING_TO_REVERSE"); return r as Exclude<ReverseResult, { state: "NOTHING_TO_REVERSE" }>; };

/** The D-881 run from the spec: a contact, a deal that uses it, a meeting, and an email nobody can unsend. */
async function d881(w: W) {
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana, purpose: "Tidy up the Q4 pipeline" });
  const call = (participant: string, tool: string, args: Record<string, unknown>) => w.recorder.call(runId, { participant, tool, arguments: args });
  await call(w.crm.id, "create_contact", { id: "C-17", uses: [] });                                                   // e1
  await call(w.crm.id, "update_deal", { id: "D-881", value: "Won", uses: [`${w.crm.id}/contact/C-17`] });             // e2, declared on e1
  await call(w.calendar.id, "create_event", { id: "E-55", uses: [`${w.crm.id}/deal/D-881`] });                        // e3, declared on e2
  await call(w.email.id, "send_email", { id: "M-1", uses: [`${w.crm.id}/deal/D-881`] });                              // e4, declared on e2
  return runId;
}

test("reversing a deal takes back what was built on it, latest first, and says what stays", async () => {
  const w = world();
  const runId = await d881(w);
  const r = done(await w.recorder.reverse(runId, { scope: { entries: ["e2"] }, requestedBy: dana, reason: "Wrong deal; the customer has not signed" }));

  assert.equal(r.state, "COMMITTED");
  assert.deepEqual(r.plan.branches.map((b) => b.operation.undo), ["e3", "e2"], "latest first; e1 was not asked for and nothing it needs is undone");
  assert.deepEqual(r.plan.notReversible, [{ entryId: "e4", reason: "Delivered to external recipients", summary: "send_email M-1" }]);
  assert.deepEqual(r.outcomes, { e3: "reversed", e2: "reversed" });
  assert.equal(w.crm.records.get(`${w.crm.id}/deal/D-881`)?.value, undefined, "the deal is back as it was");
  assert.deepEqual(w.calendar.compensated, ["e3"]);

  // The approver saw the structured plan; Dana asked, so Dana did not approve.
  assert.equal(w.asks.length, 1);
  const ask = w.asks[0];
  assert.equal(ask.routedVia.at(-1), erin);
  assert.deepEqual(ask.summary.reversal?.notReversible.map((n) => n.entryId), ["e4"]);
  assert.deepEqual(ask.summary.reversal?.branches.find((b) => b.entryId === "e3")?.sideEffects, ["Attendees receive a cancellation notice"]);
  assert.equal(ask.agentProvidedText, "Wrong deal; the customer has not signed");
  assert.equal(r.record.approvals[0].approver, erin);

  // What the Recorder produced fits the schema.
  fits("ReversalPlan", r.plan);
  fits("RunRecord", w.recorder.get(runId));

  // Both records verify offline; the run records the reversal without editing any entry.
  assert.deepEqual(verifyRecord(r.record, w.keyring), { ok: true, problems: [] });
  const run = w.recorder.get(runId);
  assert.deepEqual(verifyRunRecord(run, { recorderKeys: [w.signer.publicJwk], keyring: w.keyring }), { ok: true, problems: [] });
  const ev = run.events.at(-1)!;
  assert.equal(ev.type, "reversal");
  assert.deepEqual(ev.type === "reversal" && ev.outcomes, { e3: "reversed", e2: "reversed" });
  assert.deepEqual(w.recorder.review(runId).closed.map((i) => [i.entryId, i.reason]), [["e2", "reversed"], ["e3", "reversed"]]);

  // An entry can't be reversed twice.
  const again = await w.recorder.reverse(runId, { scope: { entries: ["e2", "e3"] }, requestedBy: dana });
  assert.equal(again.state, "NOTHING_TO_REVERSE");
});

test("newer work is never overwritten silently: a conflict is left out, unless the human forces it", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { id: "D-881", value: "Won", uses: [] } });
  w.crm.edit(`${w.crm.id}/deal/D-881`, "Negotiation (eve)");

  const left = await w.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: dana });
  assert.equal(left.state, "NOTHING_TO_REVERSE");
  assert.match(left.state === "NOTHING_TO_REVERSE" ? left.notReversible[0].reason : "", /^conflict: changed to "Negotiation \(eve\)"/);
  assert.equal(w.crm.records.get(`${w.crm.id}/deal/D-881`)?.value, "Negotiation (eve)");

  const forced = done(await w.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: dana, force: ["e1"] }));
  assert.deepEqual(forced.plan.branches[0].operation, { undo: "e1", force: true });
  assert.equal(w.asks.at(-1)?.summary.reversal?.branches[0].force, true, "the ask says it overwrites");
  assert.equal(forced.state, "COMMITTED");
  const receipt = forced.record.receipts.find((x) => x.phase === "compensate")!;
  assert.equal((receipt.detail?.effect as { versionBefore: string }).versionBefore, "v2", "the receipt records the newer version that was overwritten");
});

test("a failed compensation keeps alive what it depends on; independent entries are still reversed", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: w.crm.id, tool: "create_contact", arguments: { id: "C-17", uses: [] } });                         // e1
  await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { id: "D-881", uses: [`${w.crm.id}/contact/C-17`] } }); // e2 on e1
  await w.recorder.call(runId, { participant: w.calendar.id, tool: "create_event", arguments: { id: "E-9", uses: [] } });                      // e3, independent
  w.crm.fail.set("e2", "error");

  const r = done(await w.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: dana }));
  assert.equal(r.state, "NEEDS_ATTENTION");
  assert.deepEqual(r.outcomes, { e3: "reversed", e2: "failed", e1: "skipped" });
  assert.ok(w.crm.records.get(`${w.crm.id}/contact/C-17`)?.value, "the contact e2 still relies on was not removed");
  assert.deepEqual(r.record.branches, { "undo-e3": "COMPENSATED", "undo-e2": "FAILED", "undo-e1": "ABORTED" });
  assert.ok(r.record.events.some((e) => e.type === "skipped" && e.data.blockedBy === "e2"));
  assert.deepEqual(verifyRecord(r.record, w.keyring), { ok: true, problems: [] });
});

test("a compensation that never answers is retried, then reported unknown", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { id: "D-1", uses: [] } });
  w.crm.fail.set("e1", "silent");
  const r = done(await w.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: dana }));
  assert.equal(r.state, "NEEDS_ATTENTION");
  assert.deepEqual(r.outcomes, { e1: "unknown" });
  assert.equal(r.record.branches["undo-e1"], "IN_DOUBT");
});

test("a participant that can't tell whether its reversal happened (OUTCOME_UNKNOWN) is reported unknown, not failed", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { id: "D-1", uses: [] } });
  w.crm.fail.set("e1", "in-doubt");
  const r = done(await w.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: dana }));
  assert.deepEqual(r.outcomes, { e1: "unknown" });
  assert.equal(r.record.branches["undo-e1"], "IN_DOUBT");
  assert.equal(r.record.events.find((e) => e.type === "compensation-unknown")?.data.code, "OUTCOME_UNKNOWN");
});

test("a refusal after a compensation that got no answer is unknown: the lost attempt may have reversed it", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { id: "D-1", uses: [] } });
  w.crm.fail.set("e1", "lost");
  const r = done(await w.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: dana }));
  assert.deepEqual(w.crm.compensated, ["e1"], "the first attempt did reverse it");
  assert.deepEqual(r.outcomes, { e1: "unknown" }, "the retry's UNDO_CONFLICT comes from the first attempt's own change");
});

test("the principal's own simple undo can stand as the approval, when the policy allows it", async () => {
  const w = world({ selfApprove: true });
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { id: "D-1", uses: [] } });
  const r = done(await w.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: dana }));
  assert.equal(r.state, "COMMITTED");
  assert.equal(w.asks.length, 0, "nobody was asked");
  assert.ok(r.record.events.some((e) => e.type === "approved-by-request"));
  assert.deepEqual(verifyRecord(r.record, w.keyring), { ok: true, problems: [] });

  // Side effects always need an approval, even from the principal.
  await w.recorder.call(runId, { participant: w.calendar.id, tool: "create_event", arguments: { id: "E-1", uses: [] } });
  const withNotice = done(await w.recorder.reverse(runId, { scope: { entries: ["e2"] }, requestedBy: dana }));
  assert.equal(w.asks.length, 1);
  assert.equal(withNotice.state, "COMMITTED");
});

test("an undo someone else asked for needs an approval, and the run's principal may give it", async () => {
  const w = world({ leadMembers: ["dana"] });
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { id: "D-1", uses: [] } });
  const r = done(await w.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: "agent://acme.com/monitor", reason: "anomaly: deal closed without a signature" }));
  assert.equal(r.plan.onBehalfOf, undefined, "an agent asked: nobody is excluded as the requester");
  assert.equal(r.state, "COMMITTED");
  assert.equal(r.record.approvals[0].approver, dana);
});

test("a declined reversal changes nothing, and the run still records that it was asked", async () => {
  const w = world({ decide: () => "reject" });
  const runId = await d881(w);
  const r = done(await w.recorder.reverse(runId, { scope: { entries: ["e2"] }, requestedBy: dana }));
  assert.equal(r.state, "ABORTED");
  assert.deepEqual(r.outcomes, {});
  assert.deepEqual(w.crm.compensated, []);
  assert.equal(w.crm.records.get(`${w.crm.id}/deal/D-881`)?.value, "Won");
  const ev = w.recorder.get(runId).events.at(-1)!;
  assert.equal(ev.type, "reversal");
  assert.deepEqual(verifyRecord(r.record, w.keyring), { ok: true, problems: [] });
});

test("readers since: other runs that used the value being changed are listed, and nothing of theirs is undone", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { id: "D-881", value: "Won", uses: [] } });
  const forecast = w.recorder.startRun({ agent: "agent://acme.com/forecast", onBehalfOf: erin });
  await w.recorder.call(forecast, { participant: w.calendar.id, tool: "create_event", arguments: { id: "Q4-review", uses: [`${w.crm.id}/deal/D-881`] } });

  const r = done(await w.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: dana }));
  assert.deepEqual(r.plan.readSince, [{ runId: forecast, entryId: "e1", agent: "agent://acme.com/forecast", source: "declared", summary: "create_event Q4-review" }]);
  assert.equal(w.asks[0].summary.reversal?.readSince.length, 1);
  assert.deepEqual(w.calendar.compensated, []);
});

test("an unversioned entry is reversed only by force, and a Reversal Record can't claim more than happened", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { id: "D-1", uses: [], unversioned: true } });
  const plain = await w.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: dana });
  assert.match(plain.state === "NOTHING_TO_REVERSE" ? plain.notReversible[0].reason : "", /unversioned/);
  const r = done(await w.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: dana, force: ["e1"] }));
  assert.equal(r.state, "COMMITTED");

  // Planted: drop the participant's compensate receipt but keep COMMITTED, and re-sign as the Recorder.
  const forged: ReversalRecord = structuredClone(r.record);
  delete forged.signature;
  forged.receipts = forged.receipts.filter((x) => x.phase !== "compensate");
  const v = verifyRecord(signObject(forged, w.signer), w.keyring);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /without a reversed receipt for e1/.test(p)), v.problems.join("\n"));
});

test("reverse refuses scopes that name nothing, and Recorders built without reversal", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await assert.rejects(w.recorder.reverse(runId, { scope: { from: 1 }, requestedBy: dana }), (e: unknown) => e instanceof HatpError && e.code === "PLAN_INVALID");
  await assert.rejects(w.recorder.reverse(runId, { scope: { entries: ["e7"] }, requestedBy: dana }), (e: unknown) => e instanceof HatpError && e.code === "PLAN_INVALID");
  const bare = createRecorder({ id: w.signer.id, signer: w.signer, servers: () => undefined });
  const r2 = bare.startRun({ agent });
  await assert.rejects(bare.reverse(r2, { scope: { from: 1 }, requestedBy: dana }), (e: unknown) => e instanceof HatpError && e.code === "NOT_SUPPORTED");
});
