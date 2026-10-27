// Human Gateway: humans as transaction participants (spec §6.3, §8.4).
// Resolves human:// addresses, delivers asks over pluggable channels, escalates on SLA
// expiry, enforces quorum, and returns approvals signed over the plan digest.
import { nonce, planDigest, signObject } from "./crypto.js";
import { HatpError } from "./types.js";
export function summarize(plan, group) {
    const totals = new Map();
    for (const b of plan.branches) {
        if (b.amount)
            totals.set(b.amount.currency, (totals.get(b.amount.currency) ?? 0) + b.amount.value);
    }
    return {
        onBehalfOf: plan.onBehalfOf,
        initiator: plan.initiator,
        deadline: plan.deadline,
        decideBy: group.decideBy,
        lines: plan.branches.map((b) => ({ participant: b.participant, tool: b.operation.tool, arguments: b.operation.arguments, amount: b.amount, tier: b.tier })),
        totals: [...totals].map(([currency, value]) => ({ currency, value })),
    };
}
/**
 * Escalation order: the delegates of the human who just missed their SLA come first, then the
 * remaining candidates in rank order. Each human is asked at most once per approval group.
 */
function escalationOrder(directory, candidates) {
    const used = new Set();
    return (after) => {
        const delegates = after ? directory.get(after)?.delegates ?? [] : [];
        const pick = [...delegates.filter((d) => candidates.includes(d)), ...candidates].find((id) => !used.has(id));
        if (pick)
            used.add(pick);
        return pick;
    };
}
/**
 * Worst-case SLA seconds before an approval group stops waiting, assuming every human asked
 * times out: each of the `required` slots walks the escalation chain in parallel (spec §6.3).
 */
export function escalationWorstCase(directory, candidates, required) {
    const next = escalationOrder(directory, candidates);
    const sla = (id) => directory.get(id)?.sla?.decideSeconds ?? 900;
    const slots = Array.from({ length: required }, () => {
        const human = next();
        return { human, end: human ? sla(human) : 0 };
    });
    for (;;) {
        const active = slots.filter((s) => s.human);
        if (!active.length)
            break;
        const s = active.reduce((a, b) => (b.end < a.end ? b : a)); // the next ask to time out escalates first
        s.human = next(s.human);
        if (s.human)
            s.end += sla(s.human);
    }
    return Math.max(0, ...slots.map((s) => s.end));
}
export function createHumanGateway(opts) {
    const now = opts.now ?? Date.now;
    const msPerSecond = opts.msPerSecond ?? 1000;
    const log = opts.log ?? (() => { });
    const inflight = new Map();
    // Effective decideBy per approval branch, once a coordinator has tightened it (spec §7.10).
    // Kept even before prepare arrives, so a tighten that overtakes its prepare still applies.
    // `until` is the signed decideBy: past it the entry can never matter, so tighten prunes it.
    const cutoffs = new Map();
    const receipt = (phase, r, outcome, detail) => signObject({ type: "hatp.receipt", txnId: r.txnId, branchId: r.branchId, planDigest: r.planDigest, phase, outcome, detail, issuedAt: new Date(now()).toISOString(), issuer: opts.id }, opts.signer);
    const sleep = (ms, signal) => new Promise((resolve) => {
        const t = setTimeout(() => resolve("timeout"), ms);
        signal.addEventListener("abort", () => clearTimeout(t), { once: true });
    });
    const bumpLoad = (id, delta) => {
        const c = opts.directory.get(id);
        if (c)
            opts.directory.setLive(id, { open: Math.max(0, (c.capacity?.open ?? 0) + delta) });
    };
    // Separation of duties: the person the agent acts for never approves their own request.
    function resolveGroup(req) {
        const groupId = req.branchId.replace(/^approval:/, "");
        const group = req.plan.approvals?.find((g) => g.groupId === groupId);
        if (!group)
            throw new HatpError("TXN_UNKNOWN", `no approval group ${groupId}`);
        const exclude = req.plan.onBehalfOf ? [req.plan.onBehalfOf] : [];
        const candidates = opts.directory.resolve({ address: group.address, requirement: group.requirement, exclude, deadline: group.decideBy, now: now() }).candidates.map((c) => c.id);
        if (candidates.length < group.quorum.required)
            throw new HatpError("QUORUM_UNREACHABLE", `need ${group.quorum.required}, found ${candidates.length}`);
        return { group, candidates };
    }
    return {
        id: opts.id,
        inspect() {
            return { inflight: [...inflight.keys()], cutoffs: [...cutoffs.keys()] };
        },
        async estimate(req) {
            if (planDigest(req.plan) !== req.planDigest)
                throw new HatpError("PLAN_MISMATCH", "plan digest does not match plan");
            const { group, candidates } = resolveGroup(req);
            const worst = (escalationWorstCase(opts.directory, candidates, group.quorum.required) * msPerSecond) / 1000;
            const worstCaseSeconds = Math.max(0, Math.min(worst, (Date.parse(group.decideBy) - now()) / 1000));
            return { worstCaseSeconds, receipt: receipt("estimate", req, "estimated", { worstCaseSeconds }) };
        },
        async prepare(req) {
            const no = (code, message) => ({ vote: "no", reason: { code, message }, receipt: receipt("prepare", req, "no", { code }) });
            if (planDigest(req.plan) !== req.planDigest)
                return no("PLAN_MISMATCH", "plan digest does not match plan");
            let group;
            let candidates;
            try {
                ({ group, candidates } = resolveGroup(req));
            }
            catch (e) {
                return no(e instanceof HatpError ? e.code : "QUORUM_UNREACHABLE", e.message);
            }
            const groupId = group.groupId;
            const required = group.quorum.required;
            const key = `${req.txnId}/${req.branchId}`;
            const signedDecideBy = Date.parse(group.decideBy);
            const decideBy = () => Math.min(signedDecideBy, cutoffs.get(key)?.at ?? Infinity);
            const txnCtl = new AbortController();
            let deadline;
            let expired = false;
            const reschedule = () => {
                clearTimeout(deadline);
                deadline = setTimeout(() => {
                    expired = true;
                    txnCtl.abort();
                }, Math.max(0, decideBy() - now()));
            };
            inflight.set(key, { ctl: txnCtl, reschedule });
            const roleAddress = group.address.split("?")[0];
            const summary = summarize(req.plan, group);
            const pickNext = escalationOrder(opts.directory, candidates);
            // One "slot" per required approver. A slot escalates to the next eligible human when the current one misses their SLA.
            const runSlot = async (slot) => {
                const routedVia = [roleAddress];
                const reasons = [];
                let human = pickNext();
                while (human && !txnCtl.signal.aborted) {
                    const card = opts.directory.get(human);
                    routedVia.push(human);
                    const ask = {
                        askId: `${req.txnId}:${groupId}:${slot}:${routedVia.length}`,
                        txnId: req.txnId, groupId, planDigest: req.planDigest, requirement: group.requirement,
                        summary: { ...summary, decideBy: new Date(decideBy()).toISOString() }, agentProvidedText: req.plan.purpose, routedVia: [...routedVia],
                    };
                    const askCtl = new AbortController();
                    const onTxnAbort = () => askCtl.abort();
                    txnCtl.signal.addEventListener("abort", onTxnAbort, { once: true });
                    const slaMs = (card.sla?.decideSeconds ?? 900) * msPerSecond;
                    log(`ask → ${human} (SLA ${card.sla?.decideSeconds ?? 900}s)`);
                    bumpLoad(human, +1);
                    const result = await Promise.race([opts.channel.deliver(ask, card, askCtl.signal), sleep(slaMs, askCtl.signal)]).catch(() => "timeout");
                    bumpLoad(human, -1);
                    askCtl.abort();
                    txnCtl.signal.removeEventListener("abort", onTxnAbort);
                    if (result === "timeout") {
                        if (txnCtl.signal.aborted)
                            return null;
                        reasons.push(`${human} did not decide within SLA`);
                        log(`⏱  ${human} missed SLA, escalating`);
                        human = pickNext(human);
                        continue;
                    }
                    const decidedAt = new Date(now()).toISOString();
                    return signObject({
                        type: "hatp.approval", txnId: req.txnId, groupId, planDigest: req.planDigest,
                        decision: result.decision, approver: human, routedVia,
                        routingReason: reasons.length ? reasons.join("; ") : undefined,
                        authentication: { method: result.method, at: decidedAt, assurance: result.assurance ?? "gateway-attested" },
                        nonce: nonce(), decidedAt, issuer: opts.id,
                    }, opts.signer);
                }
                return null;
            };
            const approvals = [];
            let rejected = 0;
            const majority = group.rejectPolicy === "majority";
            reschedule();
            await Promise.all(Array.from({ length: required }, (_, i) => runSlot(i).then((a) => {
                if (!a)
                    return;
                approvals.push(a);
                if (a.decision === "reject") {
                    rejected++;
                    if (!majority || rejected > required / 2)
                        txnCtl.abort(); // stop asking others
                }
            })));
            clearTimeout(deadline);
            inflight.delete(key);
            cutoffs.delete(key);
            const approved = approvals.filter((a) => a.decision === "approve").length;
            if (approved >= required && rejected === 0) {
                return { vote: "yes", approvals, receipt: receipt("prepare", req, "yes", { approvers: approvals.map((a) => a.approver) }) };
            }
            const code = rejected > 0 ? "REJECTED" : expired ? "DEADLINE_EXCEEDED" : "QUORUM_UNREACHABLE";
            return { ...no(code, `${approved}/${required} approvals, ${rejected} rejections`), approvals };
        },
        async tighten(req) {
            if (planDigest(req.plan) !== req.planDigest)
                throw new HatpError("PLAN_MISMATCH", "plan digest does not match plan");
            const group = req.plan.approvals?.find((g) => `approval:${g.groupId}` === req.branchId);
            if (!group)
                throw new HatpError("TXN_UNKNOWN", `no approval group for ${req.branchId}`);
            // A coordinator may only shorten what the humans' plan digest already bounds, never extend it.
            if (Date.parse(req.decideBy) > Date.parse(group.decideBy))
                throw new HatpError("INVALID_STATE", "tighten may not extend the signed decideBy");
            for (const [k, c] of cutoffs)
                if (c.until < now())
                    cutoffs.delete(k);
            const key = `${req.txnId}/${req.branchId}`;
            const cutoff = Math.min(Date.parse(req.decideBy), cutoffs.get(key)?.at ?? Infinity);
            cutoffs.set(key, { at: cutoff, until: Date.parse(group.decideBy) });
            inflight.get(key)?.reschedule();
            const decideBy = new Date(cutoff).toISOString();
            log(`deadline for ${req.branchId} tightened to ${decideBy}`);
            return { decideBy, receipt: receipt("tighten", req, "tightened", { decideBy }) };
        },
        async commit(req) {
            opts.channel.notify?.({ txnId: req.txnId, groupId: req.branchId.replace(/^approval:/, ""), outcome: "committed" });
            return { receipt: receipt("commit", req, "notified") };
        },
        async abort(req) {
            inflight.get(`${req.txnId}/${req.branchId}`)?.ctl.abort(); // withdraw any open asks
            opts.channel.notify?.({ txnId: req.txnId, groupId: req.branchId.replace(/^approval:/, ""), outcome: "aborted" });
            return { receipt: receipt("abort", req, "withdrawn") };
        },
    };
}
