// Locks with fencing tokens (spec §7.6). A lock keeps two writers apart while both are alive; the
// fencing token stops a writer that was paused past its lock's expiry from overwriting newer work.
import { randomBytes } from "node:crypto";
import { HatpError } from "./types.ts";

export type LockMode = "exclusive" | "shared";

export interface LockRequest {
  resource: string;
  mode?: LockMode;
  ttlSeconds: number;
  /** The transaction the lock is for, if any. Recorded, not enforced. */
  txnId?: string;
}

export interface LockGrant {
  lockToken: string;
  /** Increases with every grant for this resource. Send it with every write the lock guards. */
  fencingToken: number;
  expiresAt: string;
}

/** What serves hatp/lock/acquire, renew and release. */
export interface LockService {
  acquire(req: LockRequest): Promise<LockGrant>;
  renew(req: { resource: string; lockToken: string; ttlSeconds: number }): Promise<{ expiresAt: string; fencingToken: number }>;
  release(req: { resource: string; lockToken: string }): Promise<Record<string, never>>;
}

export interface LockManagerOptions {
  /** Longest a lock may be held per grant or renewal. Default 300. */
  maxTtlSeconds?: number;
  now?: () => number;
}

interface Held {
  lockToken: string;
  mode: LockMode;
  fencingToken: number;
  expiresAt: number;
  txnId?: string;
}

/** An in-memory lock service. Fencing tokens never go down for a resource, even after every lock on it is released. */
export function createLockManager(opts: LockManagerOptions = {}): LockService & { inspect(resource: string): Held[] } {
  const now = opts.now ?? Date.now;
  const maxTtl = opts.maxTtlSeconds ?? 300;
  const held = new Map<string, Held[]>();
  const counters = new Map<string, number>();
  const live = (resource: string) => {
    const list = (held.get(resource) ?? []).filter((h) => h.expiresAt > now()); // an expired lock frees itself
    held.set(resource, list);
    return list;
  };
  const ttl = (seconds: number) => {
    if (!(seconds > 0)) throw new HatpError("PLAN_INVALID", "ttlSeconds must be positive");
    return Math.min(seconds, maxTtl) * 1000;
  };
  const find = (resource: string, lockToken: string) => {
    const h = live(resource).find((x) => x.lockToken === lockToken);
    if (!h) throw new HatpError("LOCK_CONFLICT", `${resource}: lock not held, or it expired`);
    return h;
  };

  return {
    inspect: (resource) => live(resource).map((h) => ({ ...h })),

    async acquire({ resource, mode = "exclusive", ttlSeconds, txnId }) {
      if (mode !== "exclusive" && mode !== "shared") throw new HatpError("PLAN_INVALID", `unknown lock mode ${mode}`);
      const list = live(resource);
      if (list.some((h) => h.mode === "exclusive") || (mode === "exclusive" && list.length)) {
        throw new HatpError("LOCK_CONFLICT", `${resource} is locked by another owner`);
      }
      const fencingToken = (counters.get(resource) ?? 0) + 1;
      counters.set(resource, fencingToken);
      const grant: Held = { lockToken: randomBytes(16).toString("base64url"), mode, fencingToken, expiresAt: now() + ttl(ttlSeconds), txnId };
      list.push(grant);
      return { lockToken: grant.lockToken, fencingToken, expiresAt: new Date(grant.expiresAt).toISOString() };
    },

    async renew({ resource, lockToken, ttlSeconds }) {
      const h = find(resource, lockToken);
      h.expiresAt = now() + ttl(ttlSeconds);
      return { expiresAt: new Date(h.expiresAt).toISOString(), fencingToken: h.fencingToken }; // renewal keeps the token
    },

    async release({ resource, lockToken }) {
      held.set(resource, live(resource).filter((h) => h.lockToken !== lockToken)); // releasing twice is harmless
      return {};
    },
  };
}

/**
 * Kept by a participant whose writes a lock guards: it remembers the highest fencing token seen per
 * resource and refuses any write with a lower one (spec §7.6). An equal token is the same holder writing again.
 */
export function createFencingGuard() {
  const seen = new Map<string, number>();
  return {
    check(resource: string, fencingToken: number): void {
      if (!Number.isSafeInteger(fencingToken)) throw new HatpError("PLAN_INVALID", "fencingToken must be an integer");
      const highest = seen.get(resource) ?? 0;
      if (fencingToken < highest) throw new HatpError("STALE_FENCING_TOKEN", `${resource}: fencing token ${fencingToken} is older than ${highest}`);
      seen.set(resource, fencingToken);
    },
    highest: (resource: string) => seen.get(resource),
  };
}
export type FencingGuard = ReturnType<typeof createFencingGuard>;
