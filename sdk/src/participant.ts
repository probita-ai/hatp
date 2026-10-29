// Helper for building resource participants (tool servers) — spec §5.2, §6.2, §7.
import { planDigest, signObject, verifyObject } from "./crypto.ts";
import type { Signer } from "./crypto.ts";
import { HatpError } from "./types.ts";
import type {
  Branch,
  CommitResult,
  CompensateRequest,
  Decision,
  Jwk,
  Money,
  Participant,
  Phase,
  PhaseRequest,
  Plan,
  PrepareRequest,
  Quote,
  Receipt,
  RenewRequest,
  Tier,
  Vote,
} from "./types.ts";

export interface OperationContext {
  txnId: string;
  branchId: string;
  plan: Plan;
  branch: Branch;
  /** Set by prepare for hold-tier operations; passed back to commit/abort. */
  holdRef?: string;
}

export type PrepareOutcome =
  | { ok: true; holdRef?: string; amount?: Money }
  | { ok: false; code: string; message: string };

export interface OperationHandler {
  tier: Tier;
  /** hold: place the hold. compensate/final: validate only, no effect. */
  prepare(args: Record<string, unknown>, ctx: OperationContext): Promise<PrepareOutcome>;
  /**
   * hold: convert hold into effect. compensate/final: perform the effect.
   * Throw only when the effect did not happen: the coordinator treats it as a definite failure.
   */
  commit(args: Record<string, unknown>, ctx: OperationContext): Promise<{ compensationToken?: string; detail?: Record<string, unknown> }>;
  /** hold: release the hold. Others: usually nothing to do. */
  abort?(args: Record<string, unknown>, ctx: OperationContext): Promise<void>;
  /** compensate tier only. */
  compensate?(token: string, ctx: OperationContext): Promise<void>;
  /** hold tier, approval-first mode: non-binding price without placing a hold. */
  quote?(args: Record<string, unknown>, ctx: OperationContext): Promise<{ amount?: Money }>;
}

export interface ResourceParticipantOptions {
  id: string;
  signer: Signer;
  operations: Record<string, OperationHandler>;
  maxLeaseSeconds?: number;
  /** Longest a hold may last from prepare, renewals included; reported as holdHorizon. Unset: renewals are uncapped. */
  maxHoldSeconds?: number;
  /** When set, commit/abort decisions must be signed by one of these coordinator keys. */
  coordinatorKeys?: Jwk[];
  now?: () => number;
}

interface BranchRecord {
  state: "PREPARED" | "VOTED_NO" | "COMMITTED" | "ABORTED" | "RELEASED" | "COMPENSATED";
  ctx: OperationContext;
  leaseExpiresAt?: number;
  holdHorizon?: number;
  results: Map<Phase, unknown>;
  /** A commit still running, so a retry that arrives meanwhile joins it instead of repeating the effect. */
  committing?: Promise<CommitResult>;
}

export function createResourceParticipant(opts: ResourceParticipantOptions): Participant & {
  /** Exposed for demos and tests: current state of every branch this participant knows. */
  inspect(): Record<string, string>;
} {
  const now = opts.now ?? Date.now;
  const maxLease = opts.maxLeaseSeconds ?? 1800;
  const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
  // A lease never runs past the hold's horizon.
  const leaseUntil = (rec: BranchRecord, seconds: number) => Math.min(now() + Math.min(seconds, maxLease) * 1000, rec.holdHorizon ?? Infinity);
  const branches = new Map<string, BranchRecord>();
  const key = (txnId: string, branchId: string) => `${txnId}/${branchId}`;

  const receipt = (phase: Phase, ctx: { txnId: string; branchId: string }, digest: string, outcome: string, detail?: Record<string, unknown>): Receipt =>
    signObject<Receipt>(
      { type: "hatp.receipt", txnId: ctx.txnId, branchId: ctx.branchId, planDigest: digest, phase, outcome, detail, issuedAt: new Date(now()).toISOString(), issuer: opts.id },
      opts.signer,
    );

  function context(req: PrepareRequest): { branch: Branch; handler: OperationHandler } {
    if (planDigest(req.plan) !== req.planDigest) throw new HatpError("PLAN_MISMATCH", "plan digest does not match plan");
    const branch = req.plan.branches.find((b) => b.branchId === req.branchId);
    if (!branch || branch.participant !== opts.id) throw new HatpError("TXN_UNKNOWN", `branch ${req.branchId} is not addressed to ${opts.id}`);
    const handler = opts.operations[branch.operation.tool];
    if (!handler) throw new HatpError("NOT_SUPPORTED", `operation ${branch.operation.tool}`);
    if (handler.tier !== branch.tier) throw new HatpError("NOT_SUPPORTED", `${branch.operation.tool} is tier ${handler.tier}, plan says ${branch.tier}`);
    return { branch, handler };
  }

  function checkDecision(d: Decision, expected: "commit" | "abort", digest: string) {
    if (d.decision !== expected || d.planDigest !== digest) throw new HatpError("INVALID_STATE", "decision record does not match request");
    if (opts.coordinatorKeys && !opts.coordinatorKeys.some((k) => verifyObject(d, k))) {
      throw new HatpError("INVALID_STATE", "decision record signature not trusted");
    }
  }

  function lookup(txnId: string, branchId: string): BranchRecord {
    const rec = branches.get(key(txnId, branchId));
    if (!rec) throw new HatpError("TXN_UNKNOWN", `${txnId}/${branchId}`);
    return rec;
  }

  // Presumed abort: release holds whose lease ran out without a decision.
  async function expireIfNeeded(rec: BranchRecord) {
    if (rec.state === "PREPARED" && rec.leaseExpiresAt !== undefined && now() > rec.leaseExpiresAt) {
      const handler = opts.operations[rec.ctx.branch.operation.tool];
      await handler.abort?.(rec.ctx.branch.operation.arguments, rec.ctx);
      rec.state = "RELEASED";
    }
  }

  return {
    id: opts.id,

    inspect() {
      return Object.fromEntries([...branches].map(([k, v]) => [k, v.state]));
    },

    async quote(req: PrepareRequest): Promise<Quote> {
      const { branch, handler } = context(req);
      if (!handler.quote) throw new HatpError("NOT_SUPPORTED", "quote");
      const ctx: OperationContext = { txnId: req.txnId, branchId: req.branchId, plan: req.plan, branch };
      const q = await handler.quote(branch.operation.arguments, ctx);
      const validUntil = new Date(now() + 15 * 60_000).toISOString();
      const quoteRef = `Q-${req.txnId}-${req.branchId}`;
      return { amount: q.amount, quoteRef, validUntil, maxHoldSeconds: opts.maxHoldSeconds, receipt: receipt("quote", req, req.planDigest, "quoted", { amount: q.amount, quoteRef }) };
    },

    async prepare(req: PrepareRequest): Promise<Vote> {
      const existing = branches.get(key(req.txnId, req.branchId));
      if (existing) await expireIfNeeded(existing);
      // Idempotent, except that a released hold may be placed again (spec §6.2).
      if (existing?.results.has("prepare") && existing.state !== "RELEASED") return existing.results.get("prepare") as Vote;

      let branch: Branch;
      let handler: OperationHandler;
      try {
        ({ branch, handler } = context(req));
      } catch (e) {
        const code = e instanceof HatpError ? e.code : "NOT_SUPPORTED";
        return { vote: "no", reason: { code, message: (e as Error).message }, receipt: receipt("prepare", req, req.planDigest, "no", { code }) };
      }

      const ctx: OperationContext = { txnId: req.txnId, branchId: req.branchId, plan: req.plan, branch };
      const outcome = await handler.prepare(branch.operation.arguments, ctx);
      const rec: BranchRecord = { state: outcome.ok ? "PREPARED" : "VOTED_NO", ctx, results: new Map() };
      let vote: Vote;
      if (outcome.ok) {
        ctx.holdRef = outcome.holdRef;
        if (handler.tier === "hold") {
          if (opts.maxHoldSeconds !== undefined) rec.holdHorizon = now() + opts.maxHoldSeconds * 1000;
          rec.leaseExpiresAt = leaseUntil(rec, req.leaseSeconds);
        }
        const holdHorizon = iso(rec.holdHorizon);
        vote = {
          vote: "yes",
          holdRef: outcome.holdRef,
          amount: outcome.amount,
          leaseExpiresAt: iso(rec.leaseExpiresAt),
          holdHorizon,
          receipt: receipt("prepare", req, req.planDigest, "yes", { holdRef: outcome.holdRef, amount: outcome.amount, holdHorizon }),
        };
      } else {
        vote = { vote: "no", reason: { code: outcome.code, message: outcome.message }, receipt: receipt("prepare", req, req.planDigest, "no", { code: outcome.code }) };
      }
      rec.results.set("prepare", vote);
      branches.set(key(req.txnId, req.branchId), rec);
      return vote;
    },

    async commit(req: PhaseRequest): Promise<CommitResult> {
      const rec = lookup(req.txnId, req.branchId);
      if (rec.results.has("commit")) return rec.results.get("commit") as CommitResult;
      if (rec.committing) return rec.committing;
      checkDecision(req.decisionRecord, "commit", req.planDigest);
      await expireIfNeeded(rec);
      if (rec.state === "RELEASED") throw new HatpError("HOLD_EXPIRED", `${req.branchId} lease expired before commit`);
      if (rec.state !== "PREPARED") throw new HatpError("INVALID_STATE", `cannot commit from ${rec.state}`);
      if (rec.committing) return rec.committing; // another commit started while this one checked expiry

      const handler = opts.operations[rec.ctx.branch.operation.tool];
      rec.committing = (async () => {
        let out;
        try {
          out = await handler.commit(rec.ctx.branch.operation.arguments, rec.ctx);
        } catch (e) {
          throw new HatpError("COMMIT_FAILED", (e as Error).message); // definite: the effect did not happen
        }
        rec.state = "COMMITTED";
        const result: CommitResult = {
          compensationToken: out.compensationToken,
          receipt: receipt("commit", req, req.planDigest, "committed", { ...out.detail, compensationToken: out.compensationToken }),
        };
        rec.results.set("commit", result);
        return result;
      })();
      try {
        return await rec.committing;
      } finally {
        rec.committing = undefined;
      }
    },

    async abort(req: PhaseRequest): Promise<{ receipt: Receipt }> {
      const rec = branches.get(key(req.txnId, req.branchId));
      if (!rec) return { receipt: receipt("abort", req, req.planDigest, "unknown-branch") }; // never prepared: nothing to undo
      if (rec.results.has("abort")) return rec.results.get("abort") as { receipt: Receipt };
      checkDecision(req.decisionRecord, "abort", req.planDigest);
      if (rec.state === "COMMITTED") throw new HatpError("INVALID_STATE", "already committed; use compensate");
      if (rec.state === "PREPARED") {
        await opts.operations[rec.ctx.branch.operation.tool].abort?.(rec.ctx.branch.operation.arguments, rec.ctx);
      }
      rec.state = "ABORTED";
      const result = { receipt: receipt("abort", req, req.planDigest, "aborted") };
      rec.results.set("abort", result);
      return result;
    },

    async compensate(req: CompensateRequest): Promise<{ receipt: Receipt }> {
      const rec = lookup(req.txnId, req.branchId);
      if (rec.results.has("compensate")) return rec.results.get("compensate") as { receipt: Receipt };
      const handler = opts.operations[rec.ctx.branch.operation.tool];
      if (handler.tier !== "compensate" || !handler.compensate) throw new HatpError("NOT_SUPPORTED", "compensate");
      if (rec.state !== "COMMITTED") throw new HatpError("INVALID_STATE", `cannot compensate from ${rec.state}`);
      try {
        await handler.compensate(req.compensationToken, rec.ctx);
      } catch (e) {
        throw new HatpError("COMPENSATION_FAILED", (e as Error).message);
      }
      rec.state = "COMPENSATED";
      const result = { receipt: receipt("compensate", req, req.planDigest, "compensated") };
      rec.results.set("compensate", result);
      return result;
    },

    async renew(req: RenewRequest): Promise<{ leaseExpiresAt: string; receipt: Receipt }> {
      const rec = lookup(req.txnId, req.branchId);
      await expireIfNeeded(rec);
      if (rec.state === "RELEASED") throw new HatpError("HOLD_EXPIRED", `${req.branchId} lease already expired`);
      if (rec.state !== "PREPARED" || rec.leaseExpiresAt === undefined) throw new HatpError("INVALID_STATE", "nothing to renew");
      rec.leaseExpiresAt = leaseUntil(rec, req.leaseSeconds);
      const leaseExpiresAt = iso(rec.leaseExpiresAt)!;
      return { leaseExpiresAt, receipt: receipt("renew", req, req.planDigest, "renewed", { leaseExpiresAt }) };
    },
  };
}
