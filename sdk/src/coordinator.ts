// Coordinator: runs the HATP transaction state machine (spec §5–§7) and emits a
// signed, hash-chained Transaction Record (spec §8.5).
import { appendFileSync } from "node:fs";
import { hashObject, planDigest, signObject } from "./crypto.ts";
import type { KeyRing, Signer } from "./crypto.ts";
import { parseHumanAddress } from "./directory.ts";
import { HatpError } from "./types.ts";
import type { Approval, BranchState, Decision, HeldBranch, Participant, Plan, Quote, Receipt, RecoveryOption, TransactionRecord, TxnEvent, TxnState, Vote } from "./types.ts";

/** Durable decision log. The decision MUST be appended before any phase-2 message (spec §6.1). */
export interface TxnLog {
  append(txnId: string, event: TxnEvent): void;
}

export class MemoryLog implements TxnLog {
  entries: { txnId: string; event: TxnEvent }[] = [];
  append(txnId: string, event: TxnEvent) {
    this.entries.push({ txnId, event });
  }
}

/** Appends one JSON line per event with a synchronous write, so a crash cannot lose a logged decision. */
export class FileLog implements TxnLog {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
  append(txnId: string, event: TxnEvent) {
    appendFileSync(this.path, JSON.stringify({ txnId, ...event }) + "\n");
  }
}

export interface CoordinatorOptions {
  id: string;
  signer: Signer;
  /** Looks up a participant by the URI used in plans. A JSON-RPC/MCP client can stand behind this. */
  participants: (id: string) => Participant | undefined;
  /** Human Gateway participant id per organisation (spec §6.3). */
  gateways?: Record<string, string>;
  /** When given, every receipt and approval must verify against it. */
  keyring?: KeyRing;
  log?: TxnLog;
  leaseSeconds?: number;
  safetyMarginSeconds?: number;
  phase2EstimateSeconds?: number;
  /** First wait before retrying a final step whose outcome is unknown; doubles up to 30 s. Default 1000. */
  inDoubtRetryMs?: number;
  /** Longest to stay in doubt when no hold reports a horizon. Default 3600. */
  inDoubtMaxSeconds?: number;
  /**
   * How long a human needs to resolve a final step in doubt, for plans that don't set
   * `escalation.leadSeconds`. Written into the plan before it is signed. Default 0 (spec §5.3).
   */
  escalationLeadSeconds?: number;
  /** After escalating an in-doubt final step, how often to keep asking it for the outcome. Default 60 000; 0 stops at escalation. */
  latePollMs?: number;
  /** Stop asking for a late outcome after this long. Default 86 400. */
  lateGiveUpSeconds?: number;
  /** An updated record, once a late outcome arrives or polling gives up, with the ways out a human may choose (spec §6.5). */
  onLateOutcome?: (record: TransactionRecord, recovery: RecoveryOption[]) => void;
  now?: () => number;
  onEvent?: (e: TxnEvent) => void;
}

export function validatePlan(plan: Plan, now = Date.now()): void {
  const fail = (m: string) => {
    throw new HatpError("PLAN_INVALID", m);
  };
  if (plan.hatp !== "0.1") fail("unsupported version");
  if (!plan.txnId) fail("txnId required");
  if (!plan.branches?.length) fail("at least one branch required");
  if (Date.parse(plan.deadline) <= now) fail("deadline already passed");
  const ids = new Set<string>();
  for (const b of plan.branches) {
    if (ids.has(b.branchId)) fail(`duplicate branchId ${b.branchId}`);
    ids.add(b.branchId);
  }
  if (plan.branches.filter((b) => b.tier === "final").length > 1) fail("at most one final-tier branch: declare the others compensate if they can be undone, or split the plan (spec §5.3)");
  if (plan.prepareOrder && !["parallel", "approval-first", "holds-first"].includes(plan.prepareOrder)) fail(`unknown prepareOrder ${plan.prepareOrder}`);
  if (plan.escalation && !(plan.escalation.leadSeconds >= 0)) fail("escalation.leadSeconds must be >= 0");
  // Both are filled in from the holds the coordinator places; an initiator can't vouch for them.
  if (plan.holds || plan.escalation?.escalateBy) fail("holds and escalation.escalateBy are written by the coordinator in holds-first mode");
  for (const g of plan.approvals ?? []) {
    if (g.quorum.required < 1) fail(`group ${g.groupId}: quorum must be >= 1`);
    if (Date.parse(g.decideBy) > Date.parse(plan.deadline)) fail(`group ${g.groupId}: decideBy after plan deadline`);
  }
}

function withinTolerance(planned: number, actual: number, pct: number): boolean {
  return Math.abs(actual - planned) <= (planned * pct) / 100 + 1e-9;
}

export function createCoordinator(opts: CoordinatorOptions) {
  const now = opts.now ?? Date.now;
  const leaseSeconds = opts.leaseSeconds ?? 1200;
  const marginMs = ((opts.safetyMarginSeconds ?? 30) + (opts.phase2EstimateSeconds ?? 10)) * 1000;

  const following = new Set<Promise<void>>(); // late-outcome polling outlives run()
  const iso = (ms: number) => new Date(ms).toISOString();

  async function run(input: Plan): Promise<TransactionRecord> {
    let plan: Plan = structuredClone(input);
    validatePlan(plan, now());
    const txnId = plan.txnId;
    if (!plan.escalation && opts.escalationLeadSeconds) plan.escalation = { leadSeconds: opts.escalationLeadSeconds };
    // If the final step ends up in doubt, a human needs leadSeconds to resolve it before the first hold
    // ends, on top of phase 2's margin. Every deadline derived from a hold's end reserves that time.
    const hasFinal = plan.branches.some((b) => b.tier === "final");
    const reserveMs = marginMs + (hasFinal ? (plan.escalation?.leadSeconds ?? 0) * 1000 : 0);

    // ---- event log (hash chain) ----
    const events: TxnEvent[] = [];
    let prev = "sha256:genesis";
    const emit = (type: string, data: Record<string, unknown> = {}) => {
      const e: TxnEvent = { seq: events.length, at: new Date(now()).toISOString(), type, data, prevHash: prev };
      prev = hashObject(e);
      events.push(e);
      opts.log?.append(txnId, e);
      opts.onEvent?.(e);
    };

    const participant = (id: string): Participant => {
      const p = opts.participants(id);
      if (!p) throw new HatpError("PLAN_INVALID", `unknown participant ${id}`);
      return p;
    };
    const gatewayFor = (address: string): string => {
      const org = parseHumanAddress(address).org;
      const gw = opts.gateways?.[org];
      if (!gw) throw new HatpError("PLAN_INVALID", `no human gateway for ${org}`);
      return gw;
    };

    // ---- phase 0: quotes, and the prepare order when the plan leaves it open (spec §5.4) ----
    const holds = plan.branches.filter((b) => b.tier === "hold");
    const draft = structuredClone(plan);
    const draftDigest = planDigest(draft);
    const phase0 = (branchId: string) => ({ txnId, branchId, planDigest: draftDigest, plan: draft, leaseSeconds });
    const quotes: Record<string, Quote> = {};
    const choosing = !plan.prepareOrder && holds.length > 0 && (plan.approvals ?? []).length > 0;
    if (plan.prepareOrder === "approval-first" || choosing) {
      for (const b of holds) {
        const p = participant(b.participant);
        if (!p.quote) continue;
        try {
          quotes[b.branchId] = await p.quote(phase0(b.branchId));
        } catch (e) {
          if (e instanceof HatpError && e.code === "NOT_SUPPORTED") continue; // keep the planned amount
          throw e;
        }
      }
    }
    // Worst-case decision time per approval group, from its gateway's escalation chain (spec §7.9).
    const worstCases: Record<string, number> = {};
    if (choosing || plan.prepareOrder === "holds-first") {
      for (const g of plan.approvals ?? []) {
        const gw = participant(gatewayFor(g.address));
        if (gw.estimate) worstCases[g.groupId] = (await gw.estimate(phase0(`approval:${g.groupId}`))).worstCaseSeconds;
        else if (choosing) worstCases[g.groupId] = (Date.parse(g.decideBy) - now()) / 1000;
      }
    }
    if (choosing) {
      // Run holds in parallel with the humans only if the slowest escalation chain fits inside the shortest hold.
      const worstCaseSeconds = Math.max(0, ...Object.values(worstCases));
      // Without a quoted cap, assume the hold lasts no longer than the lease we ask for.
      const holdBudgetSeconds = Math.min(...holds.map((b) => quotes[b.branchId]?.maxHoldSeconds ?? leaseSeconds)) - reserveMs / 1000;
      plan.prepareOrder = worstCaseSeconds <= holdBudgetSeconds ? "parallel" : "approval-first";
      emit("prepare-order", { prepareOrder: plan.prepareOrder, worstCaseSeconds, holdBudgetSeconds });
    }
    if (plan.prepareOrder === "approval-first") {
      // Quotes fix amounts before the digest humans sign.
      for (const [branchId, q] of Object.entries(quotes)) {
        if (q.amount) plan.branches.find((b) => b.branchId === branchId)!.amount = q.amount;
        emit("quoted", { branchId, amount: q.amount });
      }
    }

    let digest = planDigest(plan); // holds-first replaces it once the holds are in the plan
    const humanBranches = (plan.approvals ?? []).map((g) => ({ branchId: `approval:${g.groupId}`, participant: gatewayFor(g.address), group: g }));
    const resourceBranches = plan.branches.map((b) => ({ branchId: b.branchId, participant: b.participant }));
    const allBranches = [...resourceBranches, ...humanBranches];
    for (const b of resourceBranches) participant(b.participant); // fail fast on unknown participants

    const branchState: Record<string, BranchState> = Object.fromEntries(allBranches.map((b) => [b.branchId, "ENLISTED" as BranchState]));
    const receipts: Receipt[] = [];
    const approvals: Approval[] = [];
    const leases: Record<string, number> = {};
    const horizons: Record<string, number> = {};
    const sentCutoffs: Record<string, number> = {};
    const cutoffTimers: ReturnType<typeof setTimeout>[] = [];
    let state: TxnState = "PREPARING";
    let decision: Decision | undefined;
    let abortReason: { branchId: string; code: string; message: string } | undefined;

    const keep = (r?: Receipt) => {
      if (!r) return;
      if (opts.keyring && !opts.keyring.verify(r)) throw new HatpError("INVALID_STATE", `receipt from ${r.issuer} failed verification`);
      receipts.push(r);
    };

    const decide = (d: "commit" | "abort", reason?: Record<string, unknown>): Decision => {
      decision = signObject<Decision>({ type: "hatp.decision", txnId, planDigest: digest, decision: d, decidedAt: new Date(now()).toISOString(), issuer: opts.id }, opts.signer);
      emit("decision", { decision: d, ...reason }); // durable before phase 2
      return decision;
    };

    emit("begin", { planDigest: digest, branches: allBranches.map((b) => b.branchId) });

    // ---- phase 1: prepare ----
    const humanIds = new Set(humanBranches.map((b) => b.branchId));
    const withdrawHumans = () => {
      // Cancel open human asks as soon as the outcome is known to be abort.
      const d = decision?.decision === "abort" ? decision : decide("abort", abortReason);
      for (const h of humanBranches) {
        if (branchState[h.branchId] === "ENLISTED") participant(h.participant).abort({ txnId, branchId: h.branchId, planDigest: digest, decisionRecord: d }).catch(() => {});
      }
    };
    const markNo = (branchId: string, code: string, message: string) => {
      if (branchId in branchState) {
        branchState[branchId] = "VOTED_NO";
        emit("voted", { branchId, vote: "no", code, message });
      }
      if (!abortReason) {
        abortReason = { branchId, code, message };
        withdrawHumans();
      }
    };

    // Humans still deciding must finish while this hold can still be committed (spec §5.4).
    // Without a horizon the hold has no known end; renewal (§7.5) covers it instead.
    const tightenHumans = (holdBranchId: string, horizon: number) => {
      const cutoff = horizon - reserveMs;
      for (const h of humanBranches) {
        if (branchState[h.branchId] !== "ENLISTED") continue;
        if (cutoff >= Math.min(Date.parse(h.group.decideBy), sentCutoffs[h.branchId] ?? Infinity)) continue;
        sentCutoffs[h.branchId] = cutoff;
        const decideBy = new Date(cutoff).toISOString();
        emit("deadline-tightened", { branchId: h.branchId, decideBy, hold: holdBranchId });
        const gw = participant(h.participant);
        if (gw.tighten) {
          gw.tighten({ txnId, branchId: h.branchId, planDigest: digest, plan, decideBy })
            .then((r) => keep(r.receipt))
            .catch((e) => emit("tighten-failed", { branchId: h.branchId, message: (e as Error).message }));
        } else {
          // The gateway can't enforce it, so the coordinator does.
          cutoffTimers.push(setTimeout(() => {
            if (branchState[h.branchId] === "ENLISTED" && sentCutoffs[h.branchId] === cutoff) markNo(h.branchId, "DEADLINE_EXCEEDED", `${holdBranchId} hold ends before a decision`);
          }, Math.max(0, cutoff - now())));
        }
      }
    };

    // Keep holds alive while phase 1 waits, mostly on humans (spec §5.4). A hold the participant
    // lost is placed again once: the approval binds the plan digest, not a holdRef.
    const renewTimers: Record<string, ReturnType<typeof setTimeout>> = {};
    const background = new Set<Promise<void>>();
    const holdVotes: Record<string, Vote> = {};
    const reprepared = new Set<string>();
    const scheduleRenew = (b: { branchId: string; participant: string }) => {
      clearTimeout(renewTimers[b.branchId]);
      const exp = leases[b.branchId];
      const p = participant(b.participant);
      if (exp === undefined || !p.renew) return;
      const left = exp - now();
      renewTimers[b.branchId] = setTimeout(() => {
        if (state !== "PREPARING" || abortReason) return;
        const work = (async () => {
          try {
            const r = await p.renew!({ txnId, branchId: b.branchId, planDigest: digest, leaseSeconds });
            keep(r.receipt);
            emit("renewed", { branchId: b.branchId, leaseExpiresAt: r.leaseExpiresAt });
            const next = Date.parse(r.leaseExpiresAt);
            if (next <= exp) return; // reached the horizon; deadline tightening covers the rest
            leases[b.branchId] = next;
            scheduleRenew(b);
          } catch (e) {
            const code = e instanceof HatpError ? e.code : "ERROR";
            if (code !== "HOLD_EXPIRED" || reprepared.has(b.branchId)) return markNo(b.branchId, code, (e as Error).message);
            reprepared.add(b.branchId);
            emit("hold-lost", { branchId: b.branchId, message: (e as Error).message });
            delete leases[b.branchId];
            branchState[b.branchId] = "ENLISTED";
            await prepareOne(b);
          }
        })();
        background.add(work);
        work.finally(() => background.delete(work));
      }, Math.max(0, left - Math.min(marginMs, left / 2)));
    };

    const prepareOne = async (b: { branchId: string; participant: string }) => {
      if (abortReason) return;
      let vote: Vote;
      try {
        vote = await participant(b.participant).prepare({ txnId, branchId: b.branchId, planDigest: digest, plan, leaseSeconds });
      } catch (e) {
        return markNo(b.branchId, e instanceof HatpError ? e.code : "ERROR", (e as Error).message);
      }
      keep(vote.receipt);
      for (const a of vote.approvals ?? []) {
        if (a.planDigest !== digest) return markNo(b.branchId, "PLAN_MISMATCH", `approval by ${a.approver} is for another plan`);
        if (opts.keyring && !opts.keyring.verify(a)) return markNo(b.branchId, "INVALID_STATE", `approval by ${a.approver} failed verification`);
        approvals.push(a);
        emit("approval", { groupId: a.groupId, approver: a.approver, decision: a.decision, routedVia: a.routedVia });
      }
      if (vote.vote !== "yes") return markNo(b.branchId, vote.reason?.code ?? "NO", vote.reason?.message ?? "");

      if (humanIds.has(b.branchId)) {
        const group = humanBranches.find((h) => h.branchId === b.branchId)!.group;
        const ok = vote.approvals?.filter((a) => a.decision === "approve").length ?? 0;
        if (ok < group.quorum.required) return markNo(b.branchId, "QUORUM_UNREACHABLE", `${ok}/${group.quorum.required} approvals`);
      } else {
        const branch = plan.branches.find((x) => x.branchId === b.branchId)!;
        if (branch.amount && vote.amount && (vote.amount.currency !== branch.amount.currency || !withinTolerance(branch.amount.value, vote.amount.value, plan.tolerance?.amountPercent ?? 0))) {
          branchState[b.branchId] = "PREPARED"; // a hold exists and must be released
          return markNo(b.branchId, "AMOUNT_CHANGED", `planned ${branch.amount.value}, held ${vote.amount.value}`);
        }
        if (vote.leaseExpiresAt) {
          leases[b.branchId] = Date.parse(vote.leaseExpiresAt);
          scheduleRenew(b);
        }
        holdVotes[b.branchId] = vote;
        if (vote.holdHorizon) {
          horizons[b.branchId] = Date.parse(vote.holdHorizon);
          if (horizons[b.branchId] - reserveMs <= now() && reserveMs > marginMs) {
            branchState[b.branchId] = "PREPARED"; // a hold exists and must be released
            return markNo(b.branchId, "DEADLINE_EXCEEDED", `${b.branchId} hold ends before a final step in doubt could be escalated ${plan.escalation!.leadSeconds}s ahead`);
          }
          if (plan.prepareOrder !== "holds-first") tightenHumans(b.branchId, horizons[b.branchId]); // holds-first fits decideBy before signing
        }
      }
      branchState[b.branchId] = "PREPARED";
      emit("voted", { branchId: b.branchId, vote: "yes", leaseExpiresAt: vote.leaseExpiresAt });
    };

    const deadlineTimer = setTimeout(() => {
      if (!abortReason && state === "PREPARING") markNo("*", "DEADLINE_EXCEEDED", "transaction deadline passed during prepare");
    }, Math.max(0, Date.parse(plan.deadline) - now()));

    // holds-first: every hold's end is known before anyone is asked, so it goes into the plan the
    // humans sign, and each approval deadline is fitted inside it rather than tightened later (spec §5.4).
    const signHolds = () => {
      const held: Record<string, HeldBranch> = {};
      for (const b of plan.branches.filter((x) => x.tier === "hold")) {
        const v = holdVotes[b.branchId];
        held[b.branchId] = { holdRef: v.holdRef, amount: v.amount, expiresAt: v.holdHorizon ?? v.leaseExpiresAt };
      }
      const next = structuredClone(plan);
      next.holds = { basePlanDigest: digest, branches: held };
      const end = Math.min(...Object.values(held).map((h) => (h.expiresAt ? Date.parse(h.expiresAt) : Infinity)));
      if (end < Infinity) {
        for (const g of next.approvals ?? []) if (Date.parse(g.decideBy) > end - reserveMs) g.decideBy = iso(end - reserveMs);
        if (hasFinal) next.escalation = { leadSeconds: next.escalation?.leadSeconds ?? 0, escalateBy: iso(end - reserveMs) };
      }
      plan = next;
      digest = planDigest(plan);
      for (const h of humanBranches) h.group = plan.approvals!.find((g) => `approval:${g.groupId}` === h.branchId)!;
      emit("holds-signed", { planDigest: digest, basePlanDigest: plan.holds!.basePlanDigest, expiresAt: end < Infinity ? iso(end) : undefined });
      // Too short for the escalation chain, or already past: abort before asking anyone.
      for (const h of humanBranches) {
        const left = (Date.parse(h.group.decideBy) - now()) / 1000;
        const worst = worstCases[h.group.groupId] ?? 0;
        if (left <= 0 || worst > left) return markNo(h.branchId, "DEADLINE_EXCEEDED", `holds leave ${Math.max(0, Math.round(left))}s to decide, the escalation chain may need ${Math.round(worst)}s`);
      }
    };

    if (plan.prepareOrder === "approval-first") {
      await Promise.all(humanBranches.map(prepareOne));
      await Promise.all(resourceBranches.map(prepareOne));
    } else if (plan.prepareOrder === "holds-first") {
      const isHold = (b: { branchId: string }) => plan.branches.some((x) => x.branchId === b.branchId && x.tier === "hold");
      await Promise.all(resourceBranches.filter(isHold).map(prepareOne));
      if (!abortReason) signHolds();
      if (!abortReason) await Promise.all([...resourceBranches.filter((b) => !isHold(b)), ...humanBranches].map(prepareOne));
    } else {
      await Promise.all(allBranches.map(prepareOne));
    }
    while (background.size) await Promise.all(background); // a renewal or re-prepare still running
    clearTimeout(deadlineTimer);
    cutoffTimers.forEach(clearTimeout);
    Object.values(renewTimers).forEach(clearTimeout);

    // ---- lease check before phase 2 (spec §5.3) ----
    if (!abortReason) {
      for (const [branchId, exp] of Object.entries(leases)) {
        if (exp - now() >= marginMs) continue;
        const b = resourceBranches.find((x) => x.branchId === branchId)!;
        try {
          const r = await participant(b.participant).renew!({ txnId, branchId, planDigest: digest, leaseSeconds });
          keep(r.receipt);
          leases[branchId] = Date.parse(r.leaseExpiresAt);
          emit("renewed", { branchId, leaseExpiresAt: r.leaseExpiresAt });
        } catch (e) {
          markNo(branchId, "HOLD_EXPIRED", (e as Error).message);
          break;
        }
      }
    }
    // The humans signed each hold's end: no commit may start that could run past it.
    for (const [branchId, h] of Object.entries(plan.holds?.branches ?? {})) {
      if (abortReason) break;
      if (h.expiresAt && Date.parse(h.expiresAt) - now() < marginMs) markNo(branchId, "HOLD_EXPIRED", `${branchId} ends at ${h.expiresAt}, as signed`);
    }

    // ---- abort path ----
    const abortAll = async (d: Decision) => {
      await Promise.all(
        allBranches
          .filter((b) => branchState[b.branchId] === "PREPARED" || branchState[b.branchId] === "ENLISTED" || branchState[b.branchId] === "VOTED_NO")
          .map(async (b) => {
            try {
              const r = await participant(b.participant).abort({ txnId, branchId: b.branchId, planDigest: digest, decisionRecord: d });
              keep(r.receipt);
              if (branchState[b.branchId] !== "VOTED_NO") branchState[b.branchId] = "ABORTED";
            } catch (e) {
              emit("abort-failed", { branchId: b.branchId, message: (e as Error).message });
            }
          }),
      );
    };

    if (abortReason) {
      state = "ABORTING";
      const d = decision?.decision === "abort" ? decision : decide("abort", abortReason);
      await abortAll(d);
      state = "ABORTED";
      emit("end", { state });
      return finish();
    }

    // ---- phase 2: commit in tier order (spec §5.3) ----
    state = "COMMITTING";
    const commitDecision = decide("commit");
    const byTier = (t: string) => plan.branches.filter((b) => b.tier === t);
    const done: { branchId: string; participant: string; token: string }[] = [];

    const rollback = async (failed: string, message: string) => {
      state = "COMPENSATING";
      emit("rollback", { failed, message });
      let clean = true;
      for (const c of [...done].reverse()) {
        try {
          const r = await participant(c.participant).compensate!({ txnId, branchId: c.branchId, planDigest: digest, compensationToken: c.token });
          keep(r.receipt);
          branchState[c.branchId] = "COMPENSATED";
          emit("compensated", { branchId: c.branchId });
        } catch (e) {
          clean = false;
          emit("compensation-failed", { branchId: c.branchId, message: (e as Error).message });
        }
      }
      const d = decide("abort", { superseding: "commit", failed });
      await abortAll(d);
      state = clean ? "ABORTED" : "NEEDS_ATTENTION";
    };

    const commitOne = async (branchId: string, participantId: string) => {
      const r = await participant(participantId).commit({ txnId, branchId, planDigest: digest, decisionRecord: commitDecision });
      keep(r.receipt);
      branchState[branchId] = "COMMITTED";
      emit("committed", { branchId });
      return r;
    };

    // A final step whose outcome is unknown (a timeout, a lost connection) is in doubt: it may have
    // taken effect. Capturing or voiding the holds would each be a guess, so keep them alive and retry
    // the idempotent commit until the participant answers (spec §5.3). Escalate before a hold ends.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const lapsed = new Set<string>();
    // Renews every live hold whose lease is about to end (with `all`, every live hold, to find out where
    // each stands); reports the first one that is gone.
    const renewDue = async (all = false): Promise<{ branchId: string; message: string } | undefined> => {
      let lost: { branchId: string; message: string } | undefined;
      for (const h of byTier("hold")) {
        const p = participant(h.participant);
        if (lapsed.has(h.branchId) || leases[h.branchId] === undefined) continue;
        if (!p.renew) {
          if (leases[h.branchId] <= now()) lapsed.add(h.branchId);
          continue;
        }
        if (!all && leases[h.branchId] - now() >= marginMs) continue;
        try {
          const r = await p.renew({ txnId, branchId: h.branchId, planDigest: digest, leaseSeconds });
          keep(r.receipt);
          leases[h.branchId] = Date.parse(r.leaseExpiresAt);
          emit("renewed", { branchId: h.branchId, leaseExpiresAt: r.leaseExpiresAt });
        } catch (e) {
          lapsed.add(h.branchId);
          lost ??= { branchId: h.branchId, message: (e as Error).message };
        }
      }
      return lost;
    };

    // After escalating, keep asking the final step at a slow rate. A late answer is recorded with
    // where each hold stands, and the ways out are offered, never taken: capturing a lapsed hold
    // again or undoing the final step are new actions that need fresh consent (spec §6.5).
    const followLate = (b: { branchId: string; participant: string }) => {
      const pollMs = opts.latePollMs ?? 60_000;
      if (!pollMs) return;
      const giveUp = now() + (opts.lateGiveUpSeconds ?? 86_400) * 1000;
      const nap = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());
      const work = (async () => {
        let outcome: "committed" | "failed" | "unknown" = "unknown";
        let message: string | undefined;
        while (now() + pollMs <= giveUp) {
          await nap(pollMs);
          await renewDue();
          try {
            await commitOne(b.branchId, b.participant);
            outcome = "committed";
            break;
          } catch (e) {
            if (!(e instanceof HatpError)) continue;
            branchState[b.branchId] = "FAILED";
            outcome = "failed";
            message = e.message;
            break;
          }
        }
        await renewDue(true); // a renewal is also how a lapsed hold shows up
        const holds = Object.fromEntries(byTier("hold").map((h) => [h.branchId, lapsed.has(h.branchId) ? "lapsed" : "live"]));
        emit("late-outcome", { branchId: b.branchId, outcome, message, holds });
        opts.onLateOutcome?.(finish(), recoveryFor(b, outcome));
      })();
      following.add(work);
      work.finally(() => following.delete(work));
    };

    const recoveryFor = (b: { branchId: string; participant: string }, outcome: "committed" | "failed" | "unknown"): RecoveryOption[] => {
      const holds = byTier("hold").map((h) => h.branchId);
      const live = holds.filter((h) => !lapsed.has(h));
      const gone = holds.filter((h) => lapsed.has(h));
      if (outcome === "unknown") return [];
      if (outcome === "failed") return [{ kind: "roll-back", branches: [...done.map((d) => d.branchId), ...live] }];
      const options: RecoveryOption[] = [];
      if (live.length) options.push({ kind: "capture-holds", branches: live });
      if (gone.length) {
        // Placing a lapsed card authorization again is merchant initiated: without consent given up
        // front for off-session charges, up to this amount, the payer has to be brought back.
        const consent = plan.recovery?.offSessionReauth;
        const amounts = gone.map((h) => plan.branches.find((x) => x.branchId === h)!.amount);
        const total = amounts.reduce((s, a) => s + (a?.value ?? 0), 0);
        const covered = !!consent?.consented && (!consent.maxAmount || (amounts.every((a) => !a || a.currency === consent.maxAmount!.currency) && total <= consent.maxAmount.value));
        options.push({ kind: "linked-transaction", recoveryOf: txnId, branches: gone, payerPresent: !covered });
      }
      if (participant(b.participant).compensate) options.push({ kind: "undo-final", branchId: b.branchId });
      return options;
    };

    const resolveInDoubt = async (b: { branchId: string; participant: string }, message: string): Promise<"committed" | "escalated" | { failed: string }> => {
      state = "IN_DOUBT";
      branchState[b.branchId] = "IN_DOUBT";
      emit("in-doubt", { branchId: b.branchId, message });
      const holds = byTier("hold");
      // Escalate while a human still has leadSeconds to capture or void the holds (spec §5.3).
      const limit = Math.min(
        now() + (opts.inDoubtMaxSeconds ?? 3600) * 1000 - marginMs,
        ...holds.map((h) => (horizons[h.branchId] ?? Infinity) - reserveMs),
        plan.escalation?.escalateBy ? Date.parse(plan.escalation.escalateBy) : Infinity,
      );
      let delay = opts.inDoubtRetryMs ?? 1000;
      for (let attempt = 1; ; attempt++) {
        if (now() + delay > limit) {
          emit("escalated", { branchId: b.branchId, reason: "outcome still unknown before the holds run out; holds left in place", leadSeconds: plan.escalation?.leadSeconds ?? 0 });
          return "escalated";
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
        const lostHold = await renewDue();
        if (lostHold) {
          emit("escalated", { branchId: b.branchId, reason: `hold ${lostHold.branchId} lost while in doubt: ${lostHold.message}` });
          return "escalated";
        }
        try {
          await commitOne(b.branchId, b.participant); // same txnId/branchId: a repeat returns the first result
          emit("resolved", { branchId: b.branchId, outcome: "committed", attempt });
          return "committed";
        } catch (e) {
          if (e instanceof HatpError) {
            emit("resolved", { branchId: b.branchId, outcome: "failed", attempt });
            return { failed: e.message };
          }
          emit("in-doubt-retry", { branchId: b.branchId, attempt, message: (e as Error).message });
        }
      }
    };

    for (const b of [...byTier("compensate"), ...byTier("final")]) {
      try {
        const r = await commitOne(b.branchId, b.participant);
        if (b.tier === "compensate") done.push({ branchId: b.branchId, participant: b.participant, token: r.compensationToken ?? "" });
      } catch (e) {
        let message = (e as Error).message;
        // Only an answer from the participant (an HATP error) proves the effect did not happen.
        if (b.tier === "final" && !(e instanceof HatpError)) {
          const outcome = await resolveInDoubt(b, message);
          if (outcome === "committed") {
            state = "COMMITTING";
            continue;
          }
          if (outcome === "escalated") {
            state = "NEEDS_ATTENTION";
            emit("end", { state });
            const record = finish();
            followLate(b);
            return record;
          }
          message = outcome.failed;
        }
        branchState[b.branchId] = "FAILED";
        await rollback(b.branchId, message);
        emit("end", { state });
        return finish();
      }
    }

    const holdResults = await Promise.allSettled(byTier("hold").map((b) => commitOne(b.branchId, b.participant)));
    holdResults.forEach((r, i) => {
      if (r.status === "rejected") {
        const b = byTier("hold")[i];
        branchState[b.branchId] = "FAILED";
        emit("commit-failed", { branchId: b.branchId, message: String(r.reason?.message ?? r.reason) });
      }
    });
    for (const h of humanBranches) {
      await participant(h.participant).commit({ txnId, branchId: h.branchId, planDigest: digest, decisionRecord: commitDecision }).then((r) => keep(r.receipt), () => {});
      branchState[h.branchId] = "COMMITTED"; // approval was consumed by this commit
    }
    state = holdResults.some((r) => r.status === "rejected") ? "NEEDS_ATTENTION" : "COMMITTED";
    emit("end", { state });
    return finish();

    function finish(): TransactionRecord {
      return signObject<TransactionRecord>(
        { type: "hatp.record", plan, planDigest: digest, state, branches: branchState, approvals, receipts, decision, events, issuer: opts.id },
        opts.signer,
      );
    }
  }

  return {
    id: opts.id,
    run,
    /** Resolves once no transaction is still polling for a late outcome. */
    async idle() {
      while (following.size) await Promise.all(following);
    },
  };
}

/** Offline verification of a Transaction Record (spec §8.5). */
export function verifyRecord(record: TransactionRecord, keyring: KeyRing): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!keyring.verify(record)) problems.push("record signature invalid");
  if (planDigest(record.plan) !== record.planDigest) problems.push("plan digest mismatch");

  let prev = "sha256:genesis";
  for (const e of record.events) {
    if (e.prevHash !== prev) problems.push(`event ${e.seq} breaks the hash chain`);
    prev = hashObject(e);
  }
  // holds-first: holds were placed, and renewed while being placed, under the plan before the holds block went in.
  const held = record.plan.holds;
  const underBase = (r: Receipt) => !!held && r.planDigest === held.basePlanDigest && (r.phase === "prepare" || r.phase === "renew") && r.branchId in held.branches;
  for (const r of record.receipts) {
    if (!keyring.verify(r)) problems.push(`receipt ${r.branchId}/${r.phase} from ${r.issuer} has a bad signature`);
    if (r.phase !== "quote" && r.planDigest !== record.planDigest && !underBase(r)) problems.push(`receipt ${r.branchId}/${r.phase} is for another plan`);
  }
  for (const [branchId, h] of Object.entries(held?.branches ?? {})) {
    // The plan humans signed must describe the hold its participant signed for.
    const votes = record.receipts.filter((r) => r.branchId === branchId && r.phase === "prepare" && r.outcome === "yes" && r.planDigest === held!.basePlanDigest);
    if (!votes.some((r) => r.detail?.holdRef === h.holdRef)) problems.push(`hold ${branchId}: no prepare receipt for ${h.holdRef}`);
  }
  for (const a of record.approvals) {
    if (!keyring.verify(a)) problems.push(`approval by ${a.approver} has a bad signature`);
    if (a.planDigest !== record.planDigest) problems.push(`approval by ${a.approver} is for another plan`);
  }
  if (record.state === "COMMITTED") {
    for (const b of record.plan.branches) {
      if (!record.receipts.some((r) => r.branchId === b.branchId && r.phase === "prepare" && r.outcome === "yes")) problems.push(`committed without a yes vote from ${b.branchId}`);
    }
    for (const g of record.plan.approvals ?? []) {
      const ok = record.approvals.filter((a) => a.groupId === g.groupId && a.decision === "approve").length;
      if (ok < g.quorum.required) problems.push(`group ${g.groupId}: ${ok}/${g.quorum.required} approvals`);
    }
  }
  return { ok: problems.length === 0, problems };
}
