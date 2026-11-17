// Reversibility-gated autonomy (spec/hatp-journal.md J§7, #58): allow what can be undone, ask for exactly this
// call before anything that can't, block what the organisation forbids, and cap the money an agent moves.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { callDigest, createHumanGateway, createRecorder, createSigner, Directory, executeReceipt, HatpError, hashObject, KeyRing, signCard, verifyRunRecord } from "../src/index.ts";
import type { ActionApproval, ActionAsk, AutonomyPolicy, HumanChannel, HumanDecision, JournalServer, RunRecord, UndoDeclaration } from "../src/index.ts";

const dana = "human://acme.com/dana";
const erin = "human://acme.com/erin";
const agent = "agent://acme.com/sales-bot";
const usd = (value: number) => ({ value, currency: "USD" });

const schema = JSON.parse(readFileSync(new URL("../../spec/schemas/hatp.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);
ajv.addSchema(schema);
const fitsSchema = (r: RunRecord) => {
  const v = ajv.getSchema(`${schema.$id}#/$defs/RunRecord`)!;
  assert.ok(v(JSON.parse(JSON.stringify(r))), ajv.errorsText(v.errors));
};

/** A journal server whose every operation is declared as given; `versioned: false` leaves effect.version out. */
function server(id: string, undo: Record<string, UndoDeclaration> | undefined, o: { amountFrom?: Record<string, string>; versioned?: boolean } = {}) {
  const signer = createSigner(id);
  const received: { tool: string; approvals?: ActionApproval[] }[] = [];
  const s: JournalServer & { signer: typeof signer; received: typeof received } = {
    id, signer, undo, amountFrom: o.amountFrom, received,
    async call({ tool, arguments: args, journal, approvals }) {
      received.push({ tool, approvals });
      if (!undo) return { result: { ok: true } };
      const d = undo[tool];
      return {
        result: { ok: true },
        journal: {
          entryId: journal.entryId,
          undo: d?.kind === "compensate" ? { kind: "compensate", undoBy: new Date(Date.now() + (d.windowSeconds ?? 60) * 1000).toISOString() } : { kind: "none" },
          compensationToken: d?.kind === "compensate" ? `ctk_${journal.entryId}` : undefined,
          effect: { summary: `${tool}`, resource: `${id}/${journal.entryId}`, version: o.versioned === false ? undefined : "v1", uses: [] },
          receipt: executeReceipt(signer, { runId: journal.runId, entryId: journal.entryId, callDigest: callDigest({ runId: journal.runId, entryId: journal.entryId, tool, arguments: args }) }),
        },
      };
    },
  };
  return s;
}

function world(o: { policy?: Partial<AutonomyPolicy>; decide?: (human: string) => HumanDecision["decision"] | undefined } = {}) {
  const crm = server("mcp://crm.acme.com/hatp", { update_deal: { kind: "compensate", windowSeconds: 604800 }, touch: { kind: "compensate", windowSeconds: 60 } });
  const email = server("mcp://email.acme.com/hatp", { send_email: { kind: "none", reason: "Delivered to external recipients" } });
  const legacy = server("mcp://wiki.acme.com", undefined);
  const payments = server("mcp://payments.acme.com/hatp", { charge_order: { kind: "compensate", windowSeconds: 604800 } }, { amountFrom: { charge_order: "/amount" } });
  const desktop = server("mcp://desktop.acme.com/hatp", { void_invoice_ui: { kind: "compensate", via: "ui", windowSeconds: 604800, reason: "Restored from the Voided list" } });
  const sloppy = server("mcp://sloppy.acme.com/hatp", { edit: { kind: "compensate", windowSeconds: 604800 } }, { versioned: false });
  const all = [crm, email, legacy, payments, desktop, sloppy];
  const servers = new Map<string, JournalServer>(all.map((x) => [x.id, x]));

  const issuer = createSigner("https://directory.acme.com");
  const directory = new Directory([issuer.publicJwk]);
  for (const who of ["dana", "erin"]) directory.add(signCard({ id: `human://acme.com/${who}`, displayName: who, org: "acme.com", roles: ["team-lead"], authority: [{ action: "approve.agent-call", maxAmount: usd(5000) }], channels: ["web"], availability: { status: "available" }, sla: { decideSeconds: 60 }, keys: [], issuer: issuer.id }, issuer));
  const asks: ActionAsk[] = [];
  const channel: HumanChannel = {
    deliver: () => new Promise(() => {}),
    deliverAction: (ask, human, signal) => new Promise((resolve, reject) => {
      asks.push(ask);
      signal.addEventListener("abort", () => reject(new Error("withdrawn")), { once: true });
      const d = (o.decide ?? (() => "approve"))(human.id);
      if (d) setTimeout(() => resolve({ decision: d, method: "test" }), 2);
    }),
  };
  const gwSigner = createSigner("mcp://gateway.acme.com/hatp");
  const gateway = createHumanGateway({ id: gwSigner.id, signer: gwSigner, directory, channel });
  const policy: AutonomyPolicy = { compensate: "allow", unknown: "ask", none: "ask", approver: "human://acme.com/role/team-lead", ...o.policy };
  const signer = createSigner("mcp://recorder.acme.com/hatp");
  const keyring = new KeyRing().add(...all.map((x) => x.signer.publicJwk));
  const recorder = createRecorder({ id: signer.id, signer, servers: (id) => servers.get(id), keyring, autonomy: { policy, gateway } });
  const verify = (r: RunRecord) => verifyRunRecord(r, { recorderKeys: [signer.publicJwk], keyring });
  return { recorder, crm, email, legacy, payments, desktop, sloppy, asks, policy, verify };
}

const refused = (code: string) => (e: unknown) => e instanceof HatpError && e.code === code;

test("what can be undone runs freely; an irreversible call waits for someone other than the principal to approve it", async () => {
  const w = world();
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: { deal: "D-881" } });
  assert.equal(w.asks.length, 0, "compensate: allow");

  const { entry } = await w.recorder.call(runId, { participant: w.email.id, tool: "send_email", arguments: { to: "buyer@globex.com" }, purpose: "Tell the buyer the deal closed" });
  assert.equal(w.asks.length, 1);
  const ask = w.asks[0];
  assert.deepEqual(ask.action.arguments, { to: "buyer@globex.com" }, "the human approves exactly this call");
  assert.equal(ask.agentProvidedText, "Tell the buyer the deal closed");
  assert.equal(ask.routedVia.at(-1), erin, "Dana is the principal: she never approves her own agent's call");
  assert.equal(entry.approvals?.[0].approver, erin);
  assert.equal(w.email.received[0].approvals?.[0].approver, erin, "the participant gets the Approvals with the call");

  const record = await w.recorder.closeRun(runId);
  assert.equal(record.policyDigest, hashObject(w.policy), "the run header binds the policy");
  assert.deepEqual(w.verify(record), { ok: true, problems: [] });
  fitsSchema(record);
});

test("a rejected call never runs, is journaled as not-run, and the agent gets the reason", async () => {
  const w = world({ decide: () => "reject" });
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await assert.rejects(w.recorder.call(runId, { participant: w.email.id, tool: "send_email", arguments: { to: "x@y.z" } }), refused("APPROVAL_REQUIRED"));
  assert.deepEqual(w.email.received, [], "nothing was forwarded");
  // An unknown tool is asked too, and rejected: also kept in the journal.
  await assert.rejects(w.recorder.call(runId, { participant: w.legacy.id, tool: "noop", arguments: {} }), refused("APPROVAL_REQUIRED"));

  const record = await w.recorder.closeRun(runId);
  const [e1] = record.entries;
  assert.equal(e1.outcome, "not-run");
  assert.match(e1.reason ?? "", /^rejected by human:\/\/acme\.com\/erin \(asked: none\)$/);
  assert.equal(e1.receipt, undefined);
  assert.deepEqual(w.recorder.review(runId).notRun.map((i) => i.entryId), ["e1", "e2"]);
  assert.deepEqual(w.verify(record), { ok: true, problems: [] });
  fitsSchema(record);
});

test("block refuses the call outright; overrides set a decision per operation, not per agent", async () => {
  const w = world({ policy: { overrides: { "mcp://wiki.acme.com#search": "allow", "mcp://crm.acme.com/hatp#update_deal": "block" } } });
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await assert.rejects(w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: {} }), refused("UNDO_POLICY_BLOCKED"));
  assert.deepEqual(w.crm.received, []);

  // One unknown tool doesn't cost the agent its autonomy elsewhere; the reviewed one runs, the others still ask.
  await w.recorder.call(runId, { participant: w.legacy.id, tool: "search", arguments: { q: "Globex" } });
  assert.equal(w.asks.length, 0);
  await w.recorder.call(runId, { participant: w.legacy.id, tool: "edit_page", arguments: {} });
  assert.equal(w.asks.length, 1, "edit_page is still unknown");
  const record = await w.recorder.closeRun(runId);
  assert.deepEqual(record.entries.map((e) => [e.tool, e.outcome ?? "done", e.undo?.kind]), [["update_deal", "not-run", undefined], ["search", "done", "unknown"], ["edit_page", "done", "unknown"]]);
  assert.match(record.entries[0].reason ?? "", /blocked by policy \(override\)/);
});

test("a short undo window, an undo through the UI, or a missing version doesn't earn autonomy", async () => {
  const w = world({ policy: { minWindowSeconds: 3600 } });
  const runId = w.recorder.startRun({ agent, onBehalfOf: dana });
  await w.recorder.call(runId, { participant: w.crm.id, tool: "touch", arguments: {} });                 // 60 s window < 3600
  assert.equal(w.asks.length, 1);
  await w.recorder.call(runId, { participant: w.desktop.id, tool: "void_invoice_ui", arguments: {} });   // via ui: ask by default
  assert.equal(w.asks.length, 2);
  await w.recorder.call(runId, { participant: w.sloppy.id, tool: "edit", arguments: { n: 1 } });         // looks reversible, first time
  assert.equal(w.asks.length, 2);
  await w.recorder.call(runId, { participant: w.sloppy.id, tool: "edit", arguments: { n: 2 } });         // but returned no version: now unknown
  assert.equal(w.asks.length, 3);
  await w.recorder.call(runId, { participant: w.crm.id, tool: "update_deal", arguments: {} });           // a long window still runs
  assert.equal(w.asks.length, 3);
});

test("spending caps: a run's total and a principal's rolling total each turn allow into ask", async () => {
  const w = world({ policy: { spend: { perRun: usd(500), perPeriod: { ...usd(800), periodSeconds: 86400 } } } });
  const charge = (runId: string, amount: unknown) => w.recorder.call(runId, { participant: w.payments.id, tool: "charge_order", arguments: { amount } });
  const run = w.recorder.startRun({ agent, onBehalfOf: dana });
  await charge(run, usd(300));
  await charge(run, usd(150));
  assert.equal(w.asks.length, 0);
  await charge(run, usd(100)); // 550 > 500
  assert.equal(w.asks.length, 1);
  assert.deepEqual(w.asks[0].amount, usd(100), "the gateway checks authority against the amount in the call");
  assert.deepEqual(w.recorder.get(run).spend, { perRun: [usd(550)] }, "approved calls count too");

  // A new run starts its own run total, but the principal's rolling total remembers: 550 + 300 > 800.
  const run2 = w.recorder.startRun({ agent, onBehalfOf: dana });
  await charge(run2, usd(200));
  assert.equal(w.asks.length, 1);
  await charge(run2, usd(100));
  assert.equal(w.asks.length, 2);
  // Someone else's agent has its own budget.
  const run3 = w.recorder.startRun({ agent, onBehalfOf: erin });
  await charge(run3, usd(400));
  assert.equal(w.asks.length, 2);

  // An amount that can't be read can't be checked against anyone's authority either: the gateway refuses the
  // ask, and the call never runs. A currency without a cap, where another has one, is asked.
  await assert.rejects(charge(run3, "a lot"), refused("PLAN_INVALID"));
  assert.match(w.recorder.get(run3).entries.at(-1)?.reason ?? "", /^not approved: PLAN_INVALID \(asked: compensate; no amount at \/amount\)$/);
  assert.equal(w.payments.received.length, 6, "the unreadable charge was not forwarded");
  // EUR has no cap here, so it is asked; and nobody holds authority in EUR, so the gateway can't route it.
  await assert.rejects(charge(run3, { value: 10, currency: "EUR" }), refused("AUTHORITY_INSUFFICIENT"));
  assert.equal(w.payments.received.length, 6, "nor the EUR charge");
  assert.match(w.recorder.get(run3).entries.at(-1)?.reason ?? "", /no cap for EUR/);
  fitsSchema(await w.recorder.closeRun(run3));
});

test("a policy that can ask needs an approver and a gateway; settings must be allow, ask or block", () => {
  const signer = createSigner("mcp://recorder.acme.com/hatp");
  const make = (policy: AutonomyPolicy, gateway = true) => createRecorder({ id: signer.id, signer, servers: () => undefined, autonomy: { policy, gateway: gateway ? { askApprove: async () => ({ decision: "approve", approvals: [] }) } : undefined } });
  assert.throws(() => make({}), refused("PLAN_INVALID"), "the defaults ask before unknown and none calls");
  assert.throws(() => make({ approver: "human://acme.com/role/lead" }, false), refused("PLAN_INVALID"));
  assert.throws(() => make({ compensate: "maybe" as never, approver: "x" }), refused("PLAN_INVALID"));
  assert.doesNotThrow(() => make({ compensate: "allow", compensateViaUi: "block", unknown: "block", none: "block" }, false));
});
