// Helper for building resource participants (tool servers) — spec §5.2, §6.2, §7.
import { planDigest, signObject, verifyObject } from "./crypto.js";
import { HatpError } from "./types.js";
export function createResourceParticipant(opts) {
    const now = opts.now ?? Date.now;
    const maxLease = opts.maxLeaseSeconds ?? 1800;
    const iso = (ms) => (ms === undefined ? undefined : new Date(ms).toISOString());
    // A lease never runs past the hold's horizon.
    const leaseUntil = (rec, seconds) => Math.min(now() + Math.min(seconds, maxLease) * 1000, rec.holdHorizon ?? Infinity);
    const branches = new Map();
    const key = (txnId, branchId) => `${txnId}/${branchId}`;
    const receipt = (phase, ctx, digest, outcome, detail) => signObject({ type: "hatp.receipt", txnId: ctx.txnId, branchId: ctx.branchId, planDigest: digest, phase, outcome, detail, issuedAt: new Date(now()).toISOString(), issuer: opts.id }, opts.signer);
    function context(req) {
        if (planDigest(req.plan) !== req.planDigest)
            throw new HatpError("PLAN_MISMATCH", "plan digest does not match plan");
        const branch = req.plan.branches.find((b) => b.branchId === req.branchId);
        if (!branch || branch.participant !== opts.id)
            throw new HatpError("TXN_UNKNOWN", `branch ${req.branchId} is not addressed to ${opts.id}`);
        const handler = opts.operations[branch.operation.tool];
        if (!handler)
            throw new HatpError("NOT_SUPPORTED", `operation ${branch.operation.tool}`);
        if (handler.tier !== branch.tier)
            throw new HatpError("NOT_SUPPORTED", `${branch.operation.tool} is tier ${handler.tier}, plan says ${branch.tier}`);
        return { branch, handler };
    }
    function checkDecision(d, expected, digest) {
        if (d.decision !== expected || d.planDigest !== digest)
            throw new HatpError("INVALID_STATE", "decision record does not match request");
        if (opts.coordinatorKeys && !opts.coordinatorKeys.some((k) => verifyObject(d, k))) {
            throw new HatpError("INVALID_STATE", "decision record signature not trusted");
        }
    }
    function lookup(txnId, branchId) {
        const rec = branches.get(key(txnId, branchId));
        if (!rec)
            throw new HatpError("TXN_UNKNOWN", `${txnId}/${branchId}`);
        return rec;
    }
    // Presumed abort: release holds whose lease ran out without a decision.
    async function expireIfNeeded(rec) {
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
        async quote(req) {
            const { branch, handler } = context(req);
            if (!handler.quote)
                throw new HatpError("NOT_SUPPORTED", "quote");
            const ctx = { txnId: req.txnId, branchId: req.branchId, plan: req.plan, branch };
            const q = await handler.quote(branch.operation.arguments, ctx);
            const validUntil = new Date(now() + 15 * 60_000).toISOString();
            const quoteRef = `Q-${req.txnId}-${req.branchId}`;
            return { amount: q.amount, quoteRef, validUntil, maxHoldSeconds: opts.maxHoldSeconds, receipt: receipt("quote", req, req.planDigest, "quoted", { amount: q.amount, quoteRef }) };
        },
        async prepare(req) {
            const existing = branches.get(key(req.txnId, req.branchId));
            if (existing?.results.has("prepare"))
                return existing.results.get("prepare"); // idempotent
            let branch;
            let handler;
            try {
                ({ branch, handler } = context(req));
            }
            catch (e) {
                const code = e instanceof HatpError ? e.code : "NOT_SUPPORTED";
                return { vote: "no", reason: { code, message: e.message }, receipt: receipt("prepare", req, req.planDigest, "no", { code }) };
            }
            const ctx = { txnId: req.txnId, branchId: req.branchId, plan: req.plan, branch };
            const outcome = await handler.prepare(branch.operation.arguments, ctx);
            const rec = { state: outcome.ok ? "PREPARED" : "VOTED_NO", ctx, results: new Map() };
            let vote;
            if (outcome.ok) {
                ctx.holdRef = outcome.holdRef;
                if (handler.tier === "hold") {
                    if (opts.maxHoldSeconds !== undefined)
                        rec.holdHorizon = now() + opts.maxHoldSeconds * 1000;
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
            }
            else {
                vote = { vote: "no", reason: { code: outcome.code, message: outcome.message }, receipt: receipt("prepare", req, req.planDigest, "no", { code: outcome.code }) };
            }
            rec.results.set("prepare", vote);
            branches.set(key(req.txnId, req.branchId), rec);
            return vote;
        },
        async commit(req) {
            const rec = lookup(req.txnId, req.branchId);
            if (rec.results.has("commit"))
                return rec.results.get("commit");
            checkDecision(req.decisionRecord, "commit", req.planDigest);
            await expireIfNeeded(rec);
            if (rec.state === "RELEASED")
                throw new HatpError("HOLD_EXPIRED", `${req.branchId} lease expired before commit`);
            if (rec.state !== "PREPARED")
                throw new HatpError("INVALID_STATE", `cannot commit from ${rec.state}`);
            const handler = opts.operations[rec.ctx.branch.operation.tool];
            const out = await handler.commit(rec.ctx.branch.operation.arguments, rec.ctx);
            rec.state = "COMMITTED";
            const result = {
                compensationToken: out.compensationToken,
                receipt: receipt("commit", req, req.planDigest, "committed", { ...out.detail, compensationToken: out.compensationToken }),
            };
            rec.results.set("commit", result);
            return result;
        },
        async abort(req) {
            const rec = branches.get(key(req.txnId, req.branchId));
            if (!rec)
                return { receipt: receipt("abort", req, req.planDigest, "unknown-branch") }; // never prepared: nothing to undo
            if (rec.results.has("abort"))
                return rec.results.get("abort");
            checkDecision(req.decisionRecord, "abort", req.planDigest);
            if (rec.state === "COMMITTED")
                throw new HatpError("INVALID_STATE", "already committed; use compensate");
            if (rec.state === "PREPARED") {
                await opts.operations[rec.ctx.branch.operation.tool].abort?.(rec.ctx.branch.operation.arguments, rec.ctx);
            }
            rec.state = "ABORTED";
            const result = { receipt: receipt("abort", req, req.planDigest, "aborted") };
            rec.results.set("abort", result);
            return result;
        },
        async compensate(req) {
            const rec = lookup(req.txnId, req.branchId);
            if (rec.results.has("compensate"))
                return rec.results.get("compensate");
            const handler = opts.operations[rec.ctx.branch.operation.tool];
            if (handler.tier !== "compensate" || !handler.compensate)
                throw new HatpError("NOT_SUPPORTED", "compensate");
            if (rec.state !== "COMMITTED")
                throw new HatpError("INVALID_STATE", `cannot compensate from ${rec.state}`);
            try {
                await handler.compensate(req.compensationToken, rec.ctx);
            }
            catch (e) {
                throw new HatpError("COMPENSATION_FAILED", e.message);
            }
            rec.state = "COMPENSATED";
            const result = { receipt: receipt("compensate", req, req.planDigest, "compensated") };
            rec.results.set("compensate", result);
            return result;
        },
        async renew(req) {
            const rec = lookup(req.txnId, req.branchId);
            await expireIfNeeded(rec);
            if (rec.state === "RELEASED")
                throw new HatpError("HOLD_EXPIRED", `${req.branchId} lease already expired`);
            if (rec.state !== "PREPARED" || rec.leaseExpiresAt === undefined)
                throw new HatpError("INVALID_STATE", "nothing to renew");
            rec.leaseExpiresAt = leaseUntil(rec, req.leaseSeconds);
            const leaseExpiresAt = iso(rec.leaseExpiresAt);
            return { leaseExpiresAt, receipt: receipt("renew", req, req.planDigest, "renewed", { leaseExpiresAt }) };
        },
    };
}
