// Discovery layer: human:// addresses, signed Human Cards, and candidate ranking (spec §4).
import { signObject, verifyObject } from "./crypto.ts";
import type { Signer } from "./crypto.ts";
import { HatpError } from "./types.ts";
import type { Assurance, HatpCode, HumanCard, Jwk, Money, Requirement, RoutingRule } from "./types.ts";
import { passkeysOf } from "./webauthn.ts";

export interface HumanAddress {
  org: string;
  kind: "person" | "role" | "pool";
  name: string;
  skills: string[];
  exclude: string[];
  quorum?: { required: number; of: number };
}

export function parseHumanAddress(address: string): HumanAddress {
  const m = /^human:\/\/([^/]+)\/(?:(role|pool)\/)?([^/?]+)(?:\?(.*))?$/.exec(address);
  if (!m) throw new HatpError("PLAN_INVALID", `bad human address: ${address}`);
  const params = new URLSearchParams(m[4] ?? "");
  const q = params.get("quorum");
  let quorum: HumanAddress["quorum"];
  if (q) {
    const qm = /^(\d+)-of-(\d+)$/.exec(q);
    if (!qm) throw new HatpError("PLAN_INVALID", `bad quorum: ${q}`);
    quorum = { required: Number(qm[1]), of: Number(qm[2]) };
  }
  return {
    org: m[1],
    kind: (m[2] as "role" | "pool" | undefined) ?? "person",
    name: decodeURIComponent(m[3]),
    skills: params.getAll("skill"),
    exclude: params.getAll("exclude"),
    quorum,
  };
}

export function signCard(card: HumanCard, issuer: Signer): HumanCard {
  return signObject({ ...card, issuer: issuer.id }, issuer);
}

export interface Candidate {
  id: string;
  score: number;
  reasons: string[];
}

export interface ResolveRequest {
  address: string;
  requirement?: Requirement;
  /** Amounts to check authority against, one per currency, in place of `requirement.amount`. The gateway derives these from the plan (spec §6.3). */
  amounts?: Money[];
  /** People who may not decide this request, on top of those in the address: the plan's onBehalfOf (separation of duties). */
  exclude?: string[];
  deadline?: string;
  /** `human-signed`: only humans with a passkey on their card can be chosen (spec §8.4). */
  assurance?: Assurance;
  now?: number;
}

export interface ResolveResult {
  candidates: Candidate[];
  quorum: { required: number; of: number };
}

export interface Exclusion {
  rule: RoutingRule;
  detail?: string;
}

/** Everyone the address matched, and the rule that excluded them if one did. */
export interface Evaluation extends ResolveResult {
  evaluated: { id: string; excluded?: Exclusion }[];
  /** Set when too few candidates are eligible. `resolve` throws it. */
  shortfall?: { code: HatpCode; message: string };
}

/** Every amount must be covered. Currencies are compared without conversion: authority in one does not cover another. */
function authorityGap(card: HumanCard, req?: Requirement, amounts?: Money[]): Exclusion | undefined {
  if (!req) return undefined;
  const entries = card.authority.filter((a) => a.action === req.action);
  if (!entries.length) return { rule: "authority", detail: `no ${req.action} authority` };
  for (const m of amounts ?? (req.amount ? [req.amount] : [])) {
    if (entries.some((a) => !a.maxAmount)) continue;
    const limits = entries.filter((a) => a.maxAmount!.currency === m.currency).map((a) => a.maxAmount!.value);
    if (!limits.length) return { rule: "currency", detail: `no authority in ${m.currency}` };
    const limit = Math.max(...limits);
    if (limit < m.value) return { rule: "authority", detail: `limit ${limit} ${m.currency} < ${m.value} ${m.currency}` };
  }
  return undefined;
}

const STATUS_WEIGHT = { available: 1, busy: 0.5, away: 0.2, offline: 0 } as const;

export class Directory {
  private cards = new Map<string, HumanCard>();
  private issuerKeys: Jwk[];

  /** Cards are only accepted when signed by one of `issuerKeys` (spec §4.2). */
  constructor(issuerKeys: Jwk[]) {
    this.issuerKeys = issuerKeys;
  }

  add(card: HumanCard): this {
    if (!this.issuerKeys.some((k) => verifyObject(card, k))) throw new HatpError("PLAN_INVALID", `card ${card.id} has no valid issuer signature`);
    this.cards.set(card.id, card);
    return this;
  }

  get(id: string): HumanCard | undefined {
    return this.cards.get(id);
  }

  /** Update live fields (status, open asks) without re-signing; these are advisory. */
  setLive(id: string, live: { status?: NonNullable<HumanCard["availability"]>["status"]; open?: number }) {
    const c = this.cards.get(id);
    if (!c) return;
    if (live.status) c.availability = { ...c.availability, status: live.status };
    if (live.open !== undefined) c.capacity = { ...c.capacity, open: live.open };
  }

  resolve(req: ResolveRequest): ResolveResult {
    const { candidates, quorum, shortfall } = this.evaluate(req);
    if (shortfall) throw new HatpError(shortfall.code, shortfall.message);
    return { candidates, quorum };
  }

  /** Like `resolve`, but reports a shortfall instead of throwing, so the per-person results survive it. */
  evaluate(req: ResolveRequest): Evaluation {
    const addr = parseHumanAddress(req.address);
    const separated = new Set(req.exclude ?? []);
    const now = req.now ?? Date.now();
    const secondsLeft = req.deadline ? (Date.parse(req.deadline) - now) / 1000 : Infinity;

    const matches = [...this.cards.values()].filter((c) => {
      if (c.org !== addr.org) return false;
      if (addr.kind === "person") return c.id === `human://${addr.org}/${addr.name}`;
      if (addr.kind === "role") return c.roles.includes(addr.name);
      return (c.pools ?? []).includes(addr.name);
    });

    const exclusion = (c: HumanCard): Exclusion | undefined => {
      if (separated.has(c.id)) return { rule: "separation-of-duties" };
      if (addr.exclude.includes(c.id)) return { rule: "address" };
      const missing = addr.skills.filter((s) => !c.skills?.includes(s));
      if (missing.length) return { rule: "skill", detail: `missing ${missing.join(", ")}` };
      const gap = authorityGap(c, req.requirement, req.amounts);
      if (gap) return gap;
      if (req.assurance === "human-signed" && passkeysOf(c).length === 0) return { rule: "assurance", detail: "no passkey on card" };
      if (c.availability?.status === "offline") return { rule: "offline" };
      return undefined;
    };

    const candidates: Candidate[] = [];
    const evaluated: Evaluation["evaluated"] = [];
    for (const c of matches) {
      const excluded = exclusion(c);
      evaluated.push({ id: c.id, excluded });
      if (excluded) continue;
      const status = c.availability?.status ?? "available";

      const reasons = [status, "authority-ok"];
      if (req.assurance === "human-signed") reasons.push("passkey");
      const max = c.capacity?.maxOpen ?? 10;
      const open = c.capacity?.open ?? 0;
      const loadFree = max > 0 ? Math.max(0, 1 - open / max) : 0;
      reasons.push(`load ${open}/${max}`);
      const decide = c.sla?.decideSeconds ?? 900;
      const fitsDeadline = decide <= secondsLeft;
      if (!fitsDeadline) reasons.push("sla-exceeds-deadline");

      const score = STATUS_WEIGHT[status] * 0.5 + loadFree * 0.3 + (fitsDeadline ? 0.2 : 0);
      candidates.push({ id: c.id, score: Math.round(score * 100) / 100, reasons });
    }
    candidates.sort((a, b) => b.score - a.score);

    const required = addr.quorum?.required ?? 1;
    const shortfall = candidates.length >= required ? undefined : {
      code: (candidates.length === 0 && matches.length > 0 ? "AUTHORITY_INSUFFICIENT" : "QUORUM_UNREACHABLE") as HatpCode,
      message: `${address(req)} needs ${required}, found ${candidates.length} eligible`,
    };
    return { candidates, quorum: { required, of: candidates.length }, evaluated, shortfall };
  }
}

function address(req: ResolveRequest) {
  return req.address.split("?")[0];
}
