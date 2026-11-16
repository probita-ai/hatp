// spec/schemas/hatp.schema.json: the v0.1 types still describe what the SDK produces, and the v0.3 Journal
// types (#55) accept the shapes in spec/hatp-journal.md and refuse the ones it forbids.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createSigner, hashObject, signObject } from "../src/index.ts";
import type { Signature, Signer } from "../src/index.ts";
import { buildWorld, tripPlan } from "./fixtures.ts";

const schema = JSON.parse(readFileSync(new URL("../../spec/schemas/hatp.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
ajv.addSchema(schema);
const check = (def: string, value: unknown) => {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${def}`)!;
  return validate(value) ? undefined : ajv.errorsText(validate.errors);
};
const valid = (def: string, value: unknown) => assert.equal(check(def, value), undefined, `${def} should be valid`);
const invalid = (def: string, value: unknown) => assert.notEqual(check(def, value), undefined, `${def} should be refused`);

const d = (s: string) => hashObject(s); // any well-formed digest
type Doc = Record<string, unknown> & { signature?: Signature };
const sign = (o: Doc, signer: Signer) => signObject<Doc>(o, signer);
const recorder = createSigner("mcp://gateway.acme.com/hatp");
const crm = createSigner("mcp://crm.acme.com/hatp");
const at = "2026-10-31T14:02:10Z";

const executeReceipt = sign({ type: "hatp.receipt", txnId: "run_1", branchId: "e2", callDigest: d("call"), phase: "execute", outcome: "done", issuedAt: at, issuer: crm.id }, crm);
const entry = (o: Record<string, unknown> = {}) => ({
  type: "hatp.journal.entry", runId: "run_1", entryId: "e2", seq: 2, agent: "agent://acme.com/sales-bot", onBehalfOf: "human://acme.com/dana",
  participant: crm.id, tool: "update_deal", callDigest: d("call"), arguments: { deal: "D-881", stage: "Won" },
  dependsOn: [{ entryId: "e1", source: "declared" }], undo: { kind: "compensate", undoBy: "2026-11-07T14:02:10Z" }, compensationToken: "ctk_9QwX",
  effect: { summary: "Deal D-881 stage: Proposal → Won", resource: "crm://acme/deal/D-881", version: "v13", uses: ["crm://acme/contact/C-17"] },
  receipt: executeReceipt, recordedAt: at, prevHash: d("prev"), ...o,
});

test("what the SDK produces for a transaction still fits the v0.1 types", async () => {
  const w = buildWorld();
  const record = await w.coordinator.run(tripPlan());
  assert.equal(record.state, "COMMITTED");
  valid("Plan", record.plan);
  for (const r of record.receipts) valid("Receipt", r);
  for (const a of record.approvals) valid("Approval", a);
});

test("receipts carry exactly one of planDigest and callDigest, and journal phases are allowed", () => {
  valid("Receipt", executeReceipt);
  valid("Receipt", { ...executeReceipt, phase: "check" });
  invalid("Receipt", { ...executeReceipt, planDigest: d("plan") });
  const { callDigest: _, ...neither } = executeReceipt;
  invalid("Receipt", neither);
  valid("Receipt", { ...executeReceipt, phase: "compensate", outcome: "reversed", detail: { effect: { summary: "Stage: Won → Proposal", versionBefore: "v13", version: "v14", sideEffects: [] } } });
  invalid("Receipt", { ...executeReceipt, phase: "compensate", detail: { effect: { summary: "no sideEffects list" } } });
});

test("undo declarations: compensate needs a window, none and via ui need a reason", () => {
  valid("UndoDeclaration", { kind: "compensate", windowSeconds: 604800 });
  valid("UndoDeclaration", { kind: "none", reason: "Delivered to external recipients" });
  valid("UndoDeclaration", { kind: "compensate", via: "ui", windowSeconds: 2592000, reason: "Restored from the app's Voided list" });
  invalid("UndoDeclaration", { kind: "compensate" });
  invalid("UndoDeclaration", { kind: "none" });
  invalid("UndoDeclaration", { kind: "compensate", via: "ui", windowSeconds: 60 });
  invalid("UndoDeclaration", { kind: "unknown" }); // unknown is the Recorder's verdict, never a declaration
});

test("journal entries: compensate needs undoBy, confirmed links name who confirmed, not-run calls have no receipt", () => {
  valid("JournalEntry", entry());
  valid("JournalEntry", entry({ undo: { kind: "unknown" }, effect: undefined, compensationToken: undefined, receipt: sign({ ...executeReceipt, signature: undefined, issuer: recorder.id }, recorder) }));
  invalid("JournalEntry", entry({ undo: { kind: "compensate" } }));
  invalid("JournalEntry", entry({ seq: 0 }));
  invalid("JournalEntry", entry({ undo: undefined }));
  invalid("JournalEntry", entry({ dependsOn: [{ entryId: "e1", source: "confirmed" }] }));
  valid("JournalEntry", entry({ dependsOn: [{ entryId: "e1", source: "confirmed", confirmedBy: "human://acme.com/eve", confirmedAt: at }] }));
  invalid("JournalEntry", entry({ intake: { unresolved: true, problems: [] } }));

  const notRun = { ...entry({ outcome: "not-run", reason: "rejected by human://acme.com/team-lead" }), undo: undefined, compensationToken: undefined, receipt: undefined, effect: undefined };
  valid("JournalEntry", JSON.parse(JSON.stringify(notRun)));
  invalid("JournalEntry", JSON.parse(JSON.stringify({ ...notRun, reason: undefined })));
  invalid("JournalEntry", JSON.parse(JSON.stringify({ ...notRun, receipt: executeReceipt })));
});

test("a Run Record is 0.3, and its events say what they need to", () => {
  const run = sign({
    type: "hatp.journal.run", hatp: "0.3", runId: "run_1", agent: "agent://acme.com/sales-bot", onBehalfOf: "human://acme.com/dana",
    recorder: recorder.id, policyDigest: d("policy"), startedAt: at, entries: [entry()],
    events: [
      { type: "reviewed", by: "human://acme.com/dana", at, prevHash: d("a") },
      { type: "reversal", reversalId: "rev_1", recordDigest: d("rr"), outcomes: { e2: "reversed" }, at, prevHash: d("b") },
      { type: "remedy", txnId: "txn_1", remedies: "e4", at, prevHash: d("c") },
    ],
    spend: { perRun: [{ value: 120, currency: "USD" }] }, issuedAt: at,
  }, recorder);
  valid("RunRecord", JSON.parse(JSON.stringify(run)));
  invalid("RunRecord", { ...run, hatp: "0.1" });
  invalid("RunEvent", { type: "reviewed", at, prevHash: d("a") });
  invalid("RunEvent", { type: "reversal", reversalId: "rev_1", recordDigest: d("rr"), outcomes: { e2: "undone" }, at, prevHash: d("b") });
});

test("a Reversal Plan: every branch carries exactly one of ifVersion and force", () => {
  const plan = {
    hatp: "0.3", txnId: "rev_1", reversalOf: "run_1", initiator: recorder.id, onBehalfOf: "human://acme.com/dana", requestedBy: "human://acme.com/dana",
    purpose: "Wrong deal", deadline: "2026-10-31T16:00:00Z",
    branches: [
      { branchId: "undo-e5", participant: "mcp://calendar.acme.com/hatp", tier: "compensate", operation: { undo: "e5", ifVersion: "evt-3" }, effect: "Cancel 'Kickoff with Globex'", sideEffects: ["Attendees receive a cancellation notice"] },
      { branchId: "undo-e2", participant: crm.id, tier: "compensate", operation: { undo: "e2", force: true }, effect: "Deal D-881 stage: Won → Proposal" },
    ],
    notReversible: [{ entryId: "e4", reason: "Delivered to external recipients", summary: "Email to buyer@globex.com" }],
    unresolved: [{ entryId: "e6", problems: ["dependsOn e9: no such entry"] }],
    readSince: [{ runId: "run_9", entryId: "e3", agent: "agent://acme.com/forecast", source: "declared", summary: "Q4 forecast counted D-881 as Won" }],
    approvals: [{ groupId: "undo", address: "human://acme.com/role/team-lead", quorum: { required: 1 }, requirement: { action: "approve.undo" }, decideBy: "2026-10-31T15:45:00Z" }],
  };
  valid("ReversalPlan", plan);
  const branch = (operation: Record<string, unknown>) => ({ ...plan, branches: [{ ...plan.branches[1], operation }] });
  invalid("ReversalPlan", branch({ undo: "e2" }));
  invalid("ReversalPlan", branch({ undo: "e2", ifVersion: "v13", force: true }));
  invalid("ReversalPlan", branch({ undo: "e2", force: false }));
  invalid("ReversalPlan", { ...plan, hatp: "0.1" });
  invalid("ReversalPlan", { ...plan, branches: [{ ...plan.branches[0], tier: "final" }] });
  invalid("ReversalPlan", { ...plan, approvals: [] });
  invalid("Plan", plan); // a Reversal Plan is not an ordinary 0.1 Plan
});

test("hatp/journal/check results", () => {
  const receipt = { ...executeReceipt, phase: "check" };
  valid("JournalCheck", { undoable: false, undoBy: "2026-11-07T14:02:10Z", conflict: { currentVersion: "v15", summary: "Stage changed by human://acme.com/eve" }, sideEffects: [], cost: null, remedy: null, receipt });
  valid("JournalCheck", { undoable: true, conflict: null, receipt });
  invalid("JournalCheck", { undoable: true });
  invalid("JournalCheck", { undoable: false, conflict: { summary: "no version" }, receipt });
});
