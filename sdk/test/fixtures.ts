// A small in-process world: three tool servers, one payments server, a human directory, and a scripted human channel.
import {
  createCoordinator,
  createHumanGateway,
  createResourceParticipant,
  createSigner,
  Directory,
  KeyRing,
  MemoryLog,
  newTxnId,
  signCard,
} from "../src/index.ts";
import type { HumanCard, HumanChannel, HumanDecision, Participant, Plan } from "../src/index.ts";

export type Script = Record<string, { decision: HumanDecision["decision"]; afterMs?: number } | "ignore">;

export interface WorldOptions {
  script?: Script;
  hotelAvailable?: boolean;
  paymentsFail?: boolean;
  airlineQuote?: number;
  airlineHoldPrice?: number;
  leaseSeconds?: number;
  airlineMaxHoldSeconds?: number;
}

export function buildWorld(o: WorldOptions = {}) {
  const asked: string[] = [];
  const effects: string[] = [];
  const keyring = new KeyRing();
  const signer = (id: string) => {
    const s = createSigner(id);
    keyring.add(s.publicJwk);
    return s;
  };

  // ---- directory ----
  const issuer = signer("https://directory.acme.com");
  const directory = new Directory([issuer.publicJwk]);
  const card = (local: string, extra: Partial<HumanCard>): HumanCard =>
    signCard(
      {
        id: `human://acme.com/${local}`, displayName: local, org: "acme.com", roles: ["finance-approver"],
        authority: [{ action: "approve.spend", maxAmount: { value: 10000, currency: "USD" } }],
        channels: ["web"], availability: { status: "available" }, sla: { decideSeconds: 5 }, capacity: { maxOpen: 10, open: 0 },
        keys: [], issuer: issuer.id, ...extra,
      },
      issuer,
    );
  directory
    .add(card("alice", { capacity: { maxOpen: 10, open: 0 }, delegates: ["human://acme.com/carol"] }))
    .add(card("bob", { capacity: { maxOpen: 10, open: 3 } }))
    .add(card("carol", { capacity: { maxOpen: 10, open: 6 } }))
    .add(card("dana", { capacity: { maxOpen: 10, open: 0 } })) // the requester; also holds the role
    .add(card("erin", { authority: [{ action: "approve.spend", maxAmount: { value: 500, currency: "USD" } }] }));

  const script: Script = o.script ?? { "human://acme.com/alice": { decision: "approve" } };
  const channel: HumanChannel = {
    deliver(ask, human, signal) {
      asked.push(human.id);
      const s = script[human.id];
      return new Promise((resolve, reject) => {
        if (!s || s === "ignore") {
          signal.addEventListener("abort", () => reject(new Error("withdrawn")), { once: true });
          return;
        }
        const t = setTimeout(() => resolve({ decision: s.decision, method: "test" }), s.afterMs ?? 1);
        signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("withdrawn")); }, { once: true });
      });
    },
  };
  const gateway = createHumanGateway({ id: "mcp://gateway.acme.com/hatp", signer: signer("mcp://gateway.acme.com/hatp"), directory, channel, msPerSecond: 10 });

  // ---- resource participants ----
  let seq = 0;
  const airline = createResourceParticipant({
    id: "mcp://airline.example/hatp",
    signer: signer("mcp://airline.example/hatp"),
    maxHoldSeconds: o.airlineMaxHoldSeconds,
    operations: {
      book_seat: {
        tier: "hold",
        async quote() { return { amount: { value: o.airlineQuote ?? 412, currency: "USD" } }; },
        async prepare() { return { ok: true, holdRef: `HLD-${++seq}`, amount: { value: o.airlineHoldPrice ?? 412, currency: "USD" } }; },
        async commit(args) { effects.push(`airline:ticketed:${args.seat}`); return { detail: { ticket: "TKT-1" } }; },
        async abort(_a, ctx) { effects.push(`airline:released:${ctx.holdRef}`); },
      },
    },
  });
  const hotel = createResourceParticipant({
    id: "mcp://hotels.example/hatp",
    signer: signer("mcp://hotels.example/hatp"),
    operations: {
      reserve_room: {
        tier: "hold",
        async prepare() {
          return o.hotelAvailable === false ? { ok: false, code: "UNAVAILABLE", message: "sold out" } : { ok: true, holdRef: "ROOM-9", amount: { value: 588, currency: "USD" } };
        },
        async commit() { effects.push("hotel:booked"); return {}; },
        async abort() { effects.push("hotel:released"); },
      },
    },
  });
  const calendar = createResourceParticipant({
    id: "mcp://calendar.acme.com/hatp",
    signer: signer("mcp://calendar.acme.com/hatp"),
    operations: {
      create_event: {
        tier: "compensate",
        async prepare() { return { ok: true }; },
        async commit() { effects.push("calendar:created"); return { compensationToken: "EVT-1" }; },
        async compensate(token) { effects.push(`calendar:deleted:${token}`); },
      },
    },
  });
  const payments = createResourceParticipant({
    id: "mcp://payments.acme.com/hatp",
    signer: signer("mcp://payments.acme.com/hatp"),
    operations: {
      charge_card: {
        tier: "final",
        async prepare() { return { ok: true }; },
        async commit() {
          if (o.paymentsFail) throw new Error("card declined");
          effects.push("payments:charged");
          return {};
        },
      },
    },
  });

  const all: Participant[] = [airline, hotel, calendar, payments, gateway];
  const coordinatorSigner = signer("agent://acme.com/coordinator");
  const log = new MemoryLog();
  const coordinator = createCoordinator({
    id: "agent://acme.com/coordinator",
    signer: coordinatorSigner,
    participants: (id) => all.find((p) => p.id === id),
    gateways: { "acme.com": gateway.id },
    keyring,
    log,
    leaseSeconds: o.leaseSeconds,
  });

  return { coordinator, keyring, directory, airline, hotel, calendar, payments, asked, effects, log, issuer };
}

export function tripPlan(overrides: Partial<Plan> = {}, approvalOverrides: Partial<NonNullable<Plan["approvals"]>[number]> = {}): Plan {
  const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
  return {
    hatp: "0.1",
    txnId: newTxnId(),
    initiator: "agent://acme.com/travel-bot",
    onBehalfOf: "human://acme.com/dana",
    purpose: "Customer visit, Boston",
    deadline: inMs(60_000),
    branches: [
      { branchId: "flight", participant: "mcp://airline.example/hatp", tier: "hold", operation: { tool: "book_seat", arguments: { flight: "UA 1520", seat: "14C" } }, amount: { value: 412, currency: "USD" } },
      { branchId: "hotel", participant: "mcp://hotels.example/hatp", tier: "hold", operation: { tool: "reserve_room", arguments: { hotel: "HBOS-22", nights: 2 } }, amount: { value: 588, currency: "USD" } },
      { branchId: "calendar", participant: "mcp://calendar.acme.com/hatp", tier: "compensate", operation: { tool: "create_event", arguments: { title: "Boston trip" } } },
      { branchId: "charge", participant: "mcp://payments.acme.com/hatp", tier: "final", operation: { tool: "charge_card", arguments: { card: "corp-dana" } } },
    ],
    approvals: [
      {
        groupId: "finance",
        address: "human://acme.com/role/finance-approver",
        quorum: { required: 1 },
        requirement: { action: "approve.spend", amount: { value: 1000, currency: "USD" } },
        decideBy: inMs(30_000),
        ...approvalOverrides,
      },
    ],
    ...overrides,
  };
}
