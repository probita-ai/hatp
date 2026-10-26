// HATP demo: a travel agent books flight + hotel + calendar + card charge as one
// transaction, gated on a finance approver you play in the browser.
//
//   node demo/trip.ts                         # open http://localhost:4321 and decide
//   node demo/trip.ts --auto                  # approver clicks "approve" after 1s
//   node demo/trip.ts --scenario=hotel-sold-out | card-declined | escalate
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCoordinator,
  createHumanGateway,
  createResourceParticipant,
  createSigner,
  Directory,
  FileLog,
  KeyRing,
  newTxnId,
  signCard,
  verifyRecord,
} from "../sdk/src/index.ts";
import type { Ask, HumanCard, HumanChannel, HumanDecision, Participant, Plan, TxnEvent } from "../sdk/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = new Map(process.argv.slice(2).map((a) => [a.replace(/^--/, "").split("=")[0], a.split("=")[1] ?? "true"]));
const auto = args.has("auto");
const scenario = args.get("scenario") ?? "happy";
const PORT = Number(args.get("port") ?? 4321);

const c = { dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", reset: "\x1b[0m" };
const say = (who: string, msg: string, color = c.cyan) => console.log(`${color}${who.padEnd(12)}${c.reset} ${msg}`);

// ---------- keys & directory ----------
const keyring = new KeyRing();
const signer = (id: string) => {
  const s = createSigner(id);
  keyring.add(s.publicJwk);
  return s;
};
const issuer = signer("https://directory.acme.com");
const directory = new Directory([issuer.publicJwk]);
const human = (local: string, name: string, extra: Partial<HumanCard> = {}) =>
  directory.add(
    signCard(
      {
        id: `human://acme.com/${local}`, displayName: name, org: "acme.com", roles: ["finance-approver"],
        authority: [{ action: "approve.spend", maxAmount: { value: 10000, currency: "USD" } }],
        channels: ["web", "slack"], availability: { status: "available", timezone: "America/New_York" },
        sla: { decideSeconds: scenario === "escalate" ? 8 : 120 }, capacity: { maxOpen: 10, open: 1 },
        keys: [], issuer: issuer.id, ...extra,
      },
      issuer,
    ),
  );
human("alice", "Alice Moreno", { delegates: ["human://acme.com/carol"] });
human("bob", "Bob Chen", { capacity: { maxOpen: 10, open: 7 }, availability: { status: "busy" } });
human("carol", "Carol Diaz", { capacity: { maxOpen: 10, open: 4 } });
human("dana", "Dana Patel"); // the traveller: holds the role but must never approve her own trip

// ---------- web approver channel ----------
interface Pending { ask: Ask; human: HumanCard; resolve: (d: HumanDecision) => void; createdAt: number }
const pending = new Map<string, Pending>();
const events: { at: string; text: string; kind: string }[] = [];
const note = (text: string, kind = "info") => events.push({ at: new Date().toISOString(), text, kind });

const channel: HumanChannel = {
  deliver(ask, card, signal) {
    say("gateway", `ask → ${card.displayName} (${card.id}), SLA ${card.sla?.decideSeconds}s`, c.yellow);
    note(`Ask delivered to ${card.displayName}`, "ask");
    return new Promise((resolve, reject) => {
      pending.set(ask.askId, { ask, human: card, resolve, createdAt: Date.now() });
      if (auto && scenario !== "escalate") setTimeout(() => pending.get(ask.askId)?.resolve({ decision: "approve", method: "demo-auto" }), 1000);
      if (auto && scenario === "escalate" && card.id.endsWith("carol")) setTimeout(() => pending.get(ask.askId)?.resolve({ decision: "approve", method: "demo-auto" }), 1000);
      signal.addEventListener("abort", () => {
        if (pending.delete(ask.askId)) note(`Ask to ${card.displayName} withdrawn`, "withdrawn");
        reject(new Error("withdrawn"));
      }, { once: true });
    });
  },
  notify(e) {
    note(`Approvers notified: transaction ${e.outcome}`, e.outcome);
  },
};

const html = readFileSync(join(here, "approver.html"), "utf8");
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  } else if (req.method === "GET" && req.url === "/state") {
    const asks = [...pending.values()].map((p) => ({ ...p.ask, to: { id: p.human.id, name: p.human.displayName }, sla: p.human.sla?.decideSeconds, createdAt: p.createdAt }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ asks, events, done }));
  } else if (req.method === "POST" && req.url === "/decide") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { askId, decision } = JSON.parse(body || "{}");
      const p = pending.get(askId);
      if (!p || (decision !== "approve" && decision !== "reject")) return void res.writeHead(404).end();
      pending.delete(askId);
      say("human", `${p.human.displayName} clicked ${decision.toUpperCase()}`, decision === "approve" ? c.green : c.red);
      note(`${p.human.displayName} chose ${decision}`, decision);
      p.resolve({ decision, method: "demo-web-click" });
      res.writeHead(204).end();
    });
  } else {
    res.writeHead(404).end();
  }
});

// ---------- tool servers ----------
const tool = (id: string) => ({ id, signer: signer(id) });
const airline = createResourceParticipant({
  ...tool("mcp://airline.example/hatp"),
  operations: {
    book_seat: {
      tier: "hold",
      async prepare(a) { say("airline", `hold seat ${a.seat} on ${a.flight} (20 min lease)`); return { ok: true, holdRef: "HLD-77812", amount: { value: 412, currency: "USD" } }; },
      async commit(a) { say("airline", `${c.green}ticketed${c.reset} seat ${a.seat}`); return { detail: { ticket: "016-2219934410" } }; },
      async abort() { say("airline", `${c.dim}hold released${c.reset}`); },
    },
  },
});
const hotel = createResourceParticipant({
  ...tool("mcp://hotels.example/hatp"),
  operations: {
    reserve_room: {
      tier: "hold",
      async prepare(a) {
        if (scenario === "hotel-sold-out") { say("hotel", `${c.red}sold out${c.reset} for ${a.nights} nights → vote NO`); return { ok: false, code: "UNAVAILABLE", message: "No rooms" }; }
        say("hotel", `hold room at ${a.hotel}, ${a.nights} nights`);
        return { ok: true, holdRef: "ROOM-4410", amount: { value: 588, currency: "USD" } };
      },
      async commit() { say("hotel", `${c.green}booked${c.reset}`); return { detail: { confirmation: "HB-99812" } }; },
      async abort() { say("hotel", `${c.dim}hold released${c.reset}`); },
    },
  },
});
const calendar = createResourceParticipant({
  ...tool("mcp://calendar.acme.com/hatp"),
  operations: {
    create_event: {
      tier: "compensate",
      async prepare() { say("calendar", "validated (no effect yet)"); return { ok: true }; },
      async commit(a) { say("calendar", `${c.green}event created${c.reset}: ${a.title}`); return { compensationToken: "EVT-5521" }; },
      async compensate(t) { say("calendar", `${c.yellow}compensated${c.reset}: deleted ${t}`); },
    },
  },
});
const payments = createResourceParticipant({
  ...tool("mcp://payments.acme.com/hatp"),
  operations: {
    charge_card: {
      tier: "final",
      async prepare() { say("payments", "validated card (no charge yet)"); return { ok: true }; },
      async commit() {
        if (scenario === "card-declined") { say("payments", `${c.red}card declined${c.reset}`); throw new Error("card declined"); }
        say("payments", `${c.green}charged${c.reset} $1,000.00 (irreversible, runs before holds commit)`);
        return {};
      },
    },
  },
});
const gateway = createHumanGateway({ id: "mcp://gateway.acme.com/hatp", signer: signer("mcp://gateway.acme.com/hatp"), directory, channel });

// ---------- coordinator ----------
mkdirSync(join(here, "out"), { recursive: true });
const participants: Participant[] = [airline, hotel, calendar, payments, gateway];
const coordinator = createCoordinator({
  id: "agent://acme.com/coordinator",
  signer: signer("agent://acme.com/coordinator"),
  participants: (id) => participants.find((p) => p.id === id),
  gateways: { "acme.com": gateway.id },
  keyring,
  log: new FileLog(join(here, "out", "decision-log.jsonl")),
  onEvent: (e: TxnEvent) => {
    if (["begin", "decision", "rollback", "end"].includes(e.type)) say("coordinator", `${e.type} ${JSON.stringify(e.data)}`, c.dim);
    note(`coordinator: ${e.type} ${e.data.branchId ?? e.data.decision ?? e.data.state ?? ""}`, e.type);
  },
});

const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const plan: Plan = {
  hatp: "0.1",
  txnId: newTxnId(),
  initiator: "agent://acme.com/travel-bot",
  onBehalfOf: "human://acme.com/dana",
  purpose: "Dana's customer visit to Boston, Nov 3–5. (Text written by the agent.)",
  deadline: inMin(20),
  branches: [
    { branchId: "flight", participant: airline.id, tier: "hold", operation: { tool: "book_seat", arguments: { flight: "UA 1520", date: "2026-11-03", seat: "14C" } }, amount: { value: 412, currency: "USD" } },
    { branchId: "hotel", participant: hotel.id, tier: "hold", operation: { tool: "reserve_room", arguments: { hotel: "Harborview Boston", nights: 2 } }, amount: { value: 588, currency: "USD" } },
    { branchId: "calendar", participant: calendar.id, tier: "compensate", operation: { tool: "create_event", arguments: { title: "Boston customer visit", start: "2026-11-03" } } },
    { branchId: "charge", participant: payments.id, tier: "final", operation: { tool: "charge_card", arguments: { card: "corp-card-dana" } } },
  ],
  approvals: [
    {
      groupId: "finance",
      address: "human://acme.com/role/finance-approver",
      quorum: { required: 1 },
      requirement: { action: "approve.spend", amount: { value: 1000, currency: "USD" } },
      decideBy: inMin(15),
    },
  ],
};

let done: null | { state: string; verified: boolean; file: string } = null;

server.listen(PORT, async () => {
  console.log(`\nHATP demo — scenario: ${scenario}${auto ? " (auto-approve)" : ""}`);
  if (!auto) console.log(`${c.yellow}Open http://localhost:${PORT} to act as the finance approver.${c.reset}`);
  if (scenario === "escalate") console.log(`${c.dim}Alice's SLA is 8s. Don't answer as Alice; watch it escalate to her delegate Carol.${c.reset}`);
  console.log();

  const record = await coordinator.run(plan);
  const verification = verifyRecord(record, keyring);
  const file = join(here, "out", `record-${record.plan.txnId}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  done = { state: record.state, verified: verification.ok, file };

  const color = record.state === "COMMITTED" ? c.green : record.state === "ABORTED" ? c.yellow : c.red;
  console.log(`\n${color}Transaction ${record.state}${c.reset}`);
  for (const a of record.approvals) console.log(`  approval: ${a.decision} by ${a.approver} via ${a.routedVia.slice(1).join(" → ")}${a.routingReason ? ` (${a.routingReason})` : ""}`);
  console.log(`  branches: ${Object.entries(record.branches).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`  record verified offline: ${verification.ok ? c.green + "yes" : c.red + "NO " + verification.problems.join("; ")}${c.reset}`);
  console.log(`  ${c.dim}${file}${c.reset}\n`);
  setTimeout(() => server.close(), auto ? 0 : 3000);
});
