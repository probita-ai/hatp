// A small in-process world: three tool servers, one payments server, a human directory, and a scripted human channel.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
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
  webauthnKeyFromSpki,
} from "../src/index.ts";
import type { CoordinatorOptions, HumanCard, HumanChannel, HumanDecision, Participant, Plan, WebAuthnAssertion, WebAuthnKey } from "../src/index.ts";

/** How a scripted human signs: with their passkey, or one of the ways an assertion can be wrong. */
export type PasskeyMode = "sign" | "wrong-challenge" | "no-uv" | "wrong-origin" | "wrong-key";

export type Script = Record<string, { decision: HumanDecision["decision"]; afterMs?: number; passkey?: PasskeyMode; claimHumanSigned?: boolean } | "ignore">;

/** A software authenticator: what a browser and platform passkey produce for navigator.credentials.get. */
export class FakeAuthenticator {
  readonly key: WebAuthnKey;
  private privateKey: KeyObject;
  readonly rpId: string;
  private counter = 0;
  constructor(kid: string, rpId = "acme.com", alg: "ES256" | "EdDSA" = "ES256") {
    this.rpId = rpId;
    const pair = alg === "ES256" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("ed25519");
    this.privateKey = pair.privateKey;
    const spki = pair.publicKey.export({ format: "der", type: "spki" });
    this.key = webauthnKeyFromSpki(spki, { kid, credentialId: randomBytes(16).toString("base64url"), rpId });
  }
  assert(challenge: string, o: { origin?: string; userVerified?: boolean } = {}): WebAuthnAssertion {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: o.origin ?? `https://gateway.${this.rpId}`, crossOrigin: false }));
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    const flags = 0x01 | (o.userVerified === false ? 0 : 0x04);
    const authenticatorData = Buffer.concat([createHash("sha256").update(this.rpId).digest(), Buffer.from([flags]), counter]);
    const signed = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
    const signature = this.key.kty === "EC" ? sign("sha256", signed, { key: this.privateKey, dsaEncoding: "der" }) : sign(null, signed, this.privateKey);
    const b = (x: Buffer) => x.toString("base64url");
    return { kid: this.key.kid, credentialId: this.key.credentialId, authenticatorData: b(authenticatorData), clientDataJSON: b(clientDataJSON), signature: b(signature) };
  }
}

export interface WorldOptions {
  script?: Script;
  hotelAvailable?: boolean;
  paymentsFail?: boolean;
  airlineQuote?: number;
  airlineHoldPrice?: number;
  leaseSeconds?: number;
  airlineMaxHoldSeconds?: number;
  airlineMaxLeaseSeconds?: number;
  /** Milliseconds per SLA second in the gateway. Default 10, so 5 s SLAs time out in 50 ms. */
  gatewayMsPerSecond?: number;
  coordinator?: Partial<CoordinatorOptions>;
  /**
   * Versions the calendar and payments dry runs observe (spec §7.1): the first is read at prepare,
   * the next just before commit. Unset: they report no preconditions.
   */
  calendarVersions?: { version: string; scope?: string }[];
  paymentsVersions?: { version: string; scope?: string }[];
  /** Humans (local names) who have a passkey on their card. */
  passkeys?: string[];
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
  const authenticators = new Map<string, FakeAuthenticator>();
  for (const local of o.passkeys ?? []) authenticators.set(`human://acme.com/${local}`, new FakeAuthenticator(`human://acme.com/${local}#passkey-1`));
  const stranger = new FakeAuthenticator("human://acme.com/mallory#passkey-1");
  const card = (local: string, extra: Partial<HumanCard>): HumanCard =>
    signCard(
      {
        id: `human://acme.com/${local}`, displayName: local, org: "acme.com", roles: ["finance-approver"],
        authority: [{ action: "approve.spend", maxAmount: { value: 10000, currency: "USD" } }],
        channels: ["web"], availability: { status: "available" }, sla: { decideSeconds: 5 }, capacity: { maxOpen: 10, open: 0 },
        keys: authenticators.has(`human://acme.com/${local}`) ? [authenticators.get(`human://acme.com/${local}`)!.key] : [], issuer: issuer.id, ...extra,
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
        const decide = (): HumanDecision => {
          const auth = authenticators.get(human.id);
          if (!s.passkey || !auth) return { decision: s.decision, method: "test", assurance: s.claimHumanSigned ? "human-signed" : undefined };
          const challenge = s.passkey === "wrong-challenge" ? ask.challenges[s.decision === "approve" ? "reject" : "approve"] : ask.challenges[s.decision];
          const signer = s.passkey === "wrong-key" ? stranger : auth;
          const webauthn = signer.assert(challenge, { userVerified: s.passkey !== "no-uv", origin: s.passkey === "wrong-origin" ? "https://evil.example" : undefined });
          return { decision: s.decision, method: "test", webauthn: s.passkey === "wrong-key" ? { ...webauthn, kid: auth.key.kid, credentialId: auth.key.credentialId } : webauthn };
        };
        const t = setTimeout(() => resolve(decide()), s.afterMs ?? 1);
        signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("withdrawn")); }, { once: true });
      });
    },
  };
  const gateway = createHumanGateway({ id: "mcp://gateway.acme.com/hatp", signer: signer("mcp://gateway.acme.com/hatp"), directory, channel, msPerSecond: o.gatewayMsPerSecond ?? 10 });

  // ---- resource participants ----
  const reads = (seq?: { version: string; scope?: string }[]) => {
    let i = 0;
    return (resource: string) => {
      const v = seq![Math.min(i++, seq!.length - 1)];
      return { resource, version: v.version, scope: v.scope };
    };
  };
  const calendarRead = o.calendarVersions && reads(o.calendarVersions);
  const paymentsRead = o.paymentsVersions && reads(o.paymentsVersions);
  let seq = 0;
  const airline = createResourceParticipant({
    id: "mcp://airline.example/hatp",
    signer: signer("mcp://airline.example/hatp"),
    maxHoldSeconds: o.airlineMaxHoldSeconds,
    maxLeaseSeconds: o.airlineMaxLeaseSeconds,
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
        async prepare() { return { ok: true, preconditions: calendarRead ? [calendarRead("calendar://dana")] : undefined }; },
        observe: calendarRead ? async (resources) => resources.map(calendarRead) : undefined,
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
        async prepare() { return { ok: true, preconditions: paymentsRead ? [paymentsRead("card://corp-dana")] : undefined }; },
        observe: paymentsRead ? async (resources) => resources.map(paymentsRead) : undefined,
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
    ...o.coordinator,
  });

  return { coordinator, gateway, keyring, directory, authenticators, airline, hotel, calendar, payments, asked, effects, log, issuer };
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
