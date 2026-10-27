// Discovery layer: human:// addresses, signed Human Cards, and candidate ranking (spec §4).
import { signObject, verifyObject } from "./crypto.js";
import { HatpError } from "./types.js";
export function parseHumanAddress(address) {
    const m = /^human:\/\/([^/]+)\/(?:(role|pool)\/)?([^/?]+)(?:\?(.*))?$/.exec(address);
    if (!m)
        throw new HatpError("PLAN_INVALID", `bad human address: ${address}`);
    const params = new URLSearchParams(m[4] ?? "");
    const q = params.get("quorum");
    let quorum;
    if (q) {
        const qm = /^(\d+)-of-(\d+)$/.exec(q);
        if (!qm)
            throw new HatpError("PLAN_INVALID", `bad quorum: ${q}`);
        quorum = { required: Number(qm[1]), of: Number(qm[2]) };
    }
    return {
        org: m[1],
        kind: m[2] ?? "person",
        name: decodeURIComponent(m[3]),
        skills: params.getAll("skill"),
        exclude: params.getAll("exclude"),
        quorum,
    };
}
export function signCard(card, issuer) {
    return signObject({ ...card, issuer: issuer.id }, issuer);
}
function authorityCovers(card, req) {
    if (!req)
        return true;
    return card.authority.some((a) => {
        if (a.action !== req.action)
            return false;
        if (!req.amount)
            return true;
        if (!a.maxAmount)
            return true;
        return a.maxAmount.currency === req.amount.currency && a.maxAmount.value >= req.amount.value;
    });
}
const STATUS_WEIGHT = { available: 1, busy: 0.5, away: 0.2, offline: 0 };
export class Directory {
    cards = new Map();
    issuerKeys;
    /** Cards are only accepted when signed by one of `issuerKeys` (spec §4.2). */
    constructor(issuerKeys) {
        this.issuerKeys = issuerKeys;
    }
    add(card) {
        if (!this.issuerKeys.some((k) => verifyObject(card, k)))
            throw new HatpError("PLAN_INVALID", `card ${card.id} has no valid issuer signature`);
        this.cards.set(card.id, card);
        return this;
    }
    get(id) {
        return this.cards.get(id);
    }
    /** Update live fields (status, open asks) without re-signing; these are advisory. */
    setLive(id, live) {
        const c = this.cards.get(id);
        if (!c)
            return;
        if (live.status)
            c.availability = { ...c.availability, status: live.status };
        if (live.open !== undefined)
            c.capacity = { ...c.capacity, open: live.open };
    }
    resolve(req) {
        const addr = parseHumanAddress(req.address);
        const excluded = new Set([...addr.exclude, ...(req.exclude ?? [])]);
        const now = req.now ?? Date.now();
        const secondsLeft = req.deadline ? (Date.parse(req.deadline) - now) / 1000 : Infinity;
        const matches = [...this.cards.values()].filter((c) => {
            if (c.org !== addr.org)
                return false;
            if (addr.kind === "person")
                return c.id === `human://${addr.org}/${addr.name}`;
            if (addr.kind === "role")
                return c.roles.includes(addr.name);
            return (c.pools ?? []).includes(addr.name);
        });
        const candidates = [];
        for (const c of matches) {
            if (excluded.has(c.id))
                continue;
            if (!addr.skills.every((s) => c.skills?.includes(s)))
                continue;
            if (!authorityCovers(c, req.requirement))
                continue;
            const status = c.availability?.status ?? "available";
            if (status === "offline")
                continue;
            const reasons = [status, "authority-ok"];
            const max = c.capacity?.maxOpen ?? 10;
            const open = c.capacity?.open ?? 0;
            const loadFree = max > 0 ? Math.max(0, 1 - open / max) : 0;
            reasons.push(`load ${open}/${max}`);
            const decide = c.sla?.decideSeconds ?? 900;
            const fitsDeadline = decide <= secondsLeft;
            if (!fitsDeadline)
                reasons.push("sla-exceeds-deadline");
            const score = STATUS_WEIGHT[status] * 0.5 + loadFree * 0.3 + (fitsDeadline ? 0.2 : 0);
            candidates.push({ id: c.id, score: Math.round(score * 100) / 100, reasons });
        }
        candidates.sort((a, b) => b.score - a.score);
        const required = addr.quorum?.required ?? 1;
        if (candidates.length < required) {
            throw new HatpError(candidates.length === 0 && matches.length > 0 ? "AUTHORITY_INSUFFICIENT" : "QUORUM_UNREACHABLE", `${address(req)} needs ${required}, found ${candidates.length} eligible`);
        }
        return { candidates, quorum: { required, of: candidates.length } };
    }
}
function address(req) {
    return req.address.split("?")[0];
}
