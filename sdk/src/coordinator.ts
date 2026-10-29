// Coordinator: runs the HATP transaction state machine (spec §5–§7) and emits a
// signed, hash-chained Transaction Record (spec §8.5).
import { appendFileSync } from "node:fs";
import { hashObject, planDigest, signObject } from "./crypto.ts";
import type { KeyRing, Signer } from "./crypto.ts";
import { parseHumanAddress } from "./directory.ts";
import { HatpError } from "./types.ts";
import type { Approval, BranchState, Decision, Participant, Plan, Quote, Receipt, TransactionRecord, TxnEvent, TxnState, Vote } from "./types.ts";

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
  if (plan.branches.filter((b) => b.tier === "final").length > 1) fail("at most one final-tier branch (spec §5.3)");
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

  async function run(input: Plan): Promise<TransactionRecord> {
    const plan: Plan = structuredClone(input);
    validatePlan(plan, now());
    const txnId = plan.txnId;

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
    const draftDigest = planDigest(plan);
    const phase0 = (branchId: string) => ({ txnId, branchId, planDigest: draftDigest, plan: input, leaseSeconds });
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
    if (choosing) {
      // Run holds in parallel with the humans only if the slowest escalation chain fits inside the shortest hold.
      let worstCaseSeconds = 0;
      for (const g of plan.approvals!) {
        const gw = participant(gatewayFor(g.address));
        const est = gw.estimate ? (await gw.estimate(phase0(`approval:${g.groupId}`))).worstCaseSeconds : (Date.parse(g.decideBy) - now()) / 1000;
        worstCaseSeconds = Math.max(worstCaseSeconds, est);
      }
      // Without a quoted cap, assume the hold lasts no longer than the lease we ask for.
      const holdBudgetSeconds = Math.min(...holds.map((b) => quotes[b.branchId]?.maxHoldSeconds ?? leaseSeconds)) - marginMs / 1000;
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

    const digest = planDigest(plan);
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
      const cutoff = horizon - marginMs;
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
        if (vote.holdHorizon) {
          horizons[b.branchId] = Date.parse(vote.holdHorizon);
          tightenHumans(b.branchId, horizons[b.branchId]);
        }
      }
      branchState[b.branchId] = "PREPARED";
      emit("voted", { branchId: b.branchId, vote: "yes", leaseExpiresAt: vote.leaseExpiresAt });
    };

    const deadlineTimer = setTimeout(() => {
      if (!abortReason && state === "PREPARING") markNo("*", "DEADLINE_EXCEEDED", "transaction deadline passed during prepare");
    }, Math.max(0, Date.parse(plan.deadline) - now()));

    if (plan.prepareOrder === "approval-first") {
      await Promise.all(humanBranches.map(prepareOne));
      await Promise.all(resourceBranches.map(prepareOne));
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
    const resolveInDoubt = async (b: { branchId: string; participant: string }, message: string): Promise<"committed" | "escalated" | { failed: string }> => {
      state = "IN_DOUBT";
      branchState[b.branchId] = "IN_DOUBT";
      emit("in-doubt", { branchId: b.branchId, message });
      const holds = byTier("hold");
      const limit = Math.min(now() + (opts.inDoubtMaxSeconds ?? 3600) * 1000, ...holds.map((h) => horizons[h.branchId] ?? Infinity)) - marginMs;
      let delay = opts.inDoubtRetryMs ?? 1000;
      for (let attempt = 1; ; attempt++) {
        if (now() + delay > limit) {
          emit("escalated", { branchId: b.branchId, reason: "outcome still unknown before the holds run out; holds left in place" });
          return "escalated";
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 30_000);
        for (const h of holds) {
          if (leases[h.branchId] === undefined || leases[h.branchId] - now() >= marginMs) continue;
          try {
            const r = await participant(h.participant).renew!({ txnId, branchId: h.branchId, planDigest: digest, leaseSeconds });
            keep(r.receipt);
            leases[h.branchId] = Date.parse(r.leaseExpiresAt);
            emit("renewed", { branchId: h.branchId, leaseExpiresAt: r.leaseExpiresAt });
          } catch (e) {
            emit("escalated", { branchId: b.branchId, reason: `hold ${h.branchId} lost while in doubt: ${(e as Error).message}` });
            return "escalated";
          }
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
            return finish();
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

  return { id: opts.id, run };
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
  for (const r of record.receipts) {
    if (!keyring.verify(r)) problems.push(`receipt ${r.branchId}/${r.phase} from ${r.issuer} has a bad signature`);
    if (r.phase !== "quote" && r.planDigest !== record.planDigest) problems.push(`receipt ${r.branchId}/${r.phase} is for another plan`);
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
