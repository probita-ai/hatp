// Human Gateway: humans as transaction participants (spec §6.3, §8.4).
// Resolves human:// addresses, delivers asks over pluggable channels, escalates on SLA
// expiry, enforces quorum, and returns approvals signed over the plan digest.
import { nonce, planDigest, signObject } from "./crypto.ts";
import type { Signer } from "./crypto.ts";
import type { Directory } from "./directory.ts";
import { HatpError } from "./types.ts";
import type { Approval, ApprovalGroup, CommitResult, HumanCard, Money, Participant, PhaseRequest, Plan, PrepareRequest, Receipt, Vote } from "./types.ts";

/** Decision-relevant content, always rendered from the structured plan (spec §10.3). */
export interface AskSummary {
  onBehalfOf?: string;
  initiator: string;
  deadline: string;
  decideBy: string;
  lines: { participant: string; tool: string; arguments: Record<string, unknown>; amount?: Money; tier: string }[];
  totals: Money[];
}

export interface Ask {
  askId: string;
  txnId: string;
  groupId: string;
  planDigest: string;
  requirement: ApprovalGroup["requirement"];
  summary: AskSummary;
  /** Free text written by the agent. Channels MUST show it separately, labelled as agent-provided. */
  agentProvidedText?: string;
  routedVia: string[];
}

export interface HumanDecision {
  decision: "approve" | "reject";
  /** How the human was authenticated at decision time, e.g. "webauthn", "slack-sso". */
  method: string;
  assurance?: "human-signed" | "gateway-attested";
}

export interface HumanChannel {
  /** Deliver the ask and resolve when the human decides. Must stop waiting when `signal` aborts. */
  deliver(ask: Ask, human: HumanCard, signal: AbortSignal): Promise<HumanDecision>;
  /** Optional: tell humans how the transaction ended. */
  notify?(event: { txnId: string; groupId: string; outcome: "committed" | "aborted" }): void;
}

export interface HumanGatewayOptions {
  id: string;
  signer: Signer;
  directory: Directory;
  channel: HumanChannel;
  /** Milliseconds per SLA second. Default 1000; tests and demos shrink it. */
  msPerSecond?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export function summarize(plan: Plan, group: ApprovalGroup): AskSummary {
  const totals = new Map<string, number>();
  for (const b of plan.branches) {
    if (b.amount) totals.set(b.amount.currency, (totals.get(b.amount.currency) ?? 0) + b.amount.value);
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

export function createHumanGateway(opts: HumanGatewayOptions): Participant {
  const now = opts.now ?? Date.now;
  const msPerSecond = opts.msPerSecond ?? 1000;
  const log = opts.log ?? (() => {});
  const inflight = new Map<string, AbortController>();

  const receipt = (phase: Receipt["phase"], r: { txnId: string; branchId: string; planDigest: string }, outcome: string, detail?: Record<string, unknown>) =>
    signObject<Receipt>({ type: "hatp.receipt", txnId: r.txnId, branchId: r.branchId, planDigest: r.planDigest, phase, outcome, detail, issuedAt: new Date(now()).toISOString(), issuer: opts.id }, opts.signer);

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<"timeout">((resolve) => {
      const t = setTimeout(() => resolve("timeout"), ms);
      signal.addEventListener("abort", () => clearTimeout(t), { once: true });
    });

  const bumpLoad = (id: string, delta: number) => {
    const c = opts.directory.get(id);
    if (c) opts.directory.setLive(id, { open: Math.max(0, (c.capacity?.open ?? 0) + delta) });
  };

  return {
    id: opts.id,

    async prepare(req: PrepareRequest): Promise<Vote> {
      const no = (code: string, message: string): Vote => ({ vote: "no", reason: { code, message }, receipt: receipt("prepare", req, "no", { code }) });
      if (planDigest(req.plan) !== req.planDigest) return no("PLAN_MISMATCH", "plan digest does not match plan");
      const groupId = req.branchId.replace(/^approval:/, "");
      const group = req.plan.approvals?.find((g) => g.groupId === groupId);
      if (!group) return no("TXN_UNKNOWN", `no approval group ${groupId}`);

      // Separation of duties: the person the agent acts for never approves their own request.
      const exclude = req.plan.onBehalfOf ? [req.plan.onBehalfOf] : [];
      let candidates: string[];
      try {
        candidates = opts.directory.resolve({ address: group.address, requirement: group.requirement, exclude, deadline: group.decideBy, now: now() }).candidates.map((c) => c.id);
      } catch (e) {
        return no(e instanceof HatpError ? e.code : "QUORUM_UNREACHABLE", (e as Error).message);
      }
      const required = group.quorum.required;
      if (candidates.length < required) return no("QUORUM_UNREACHABLE", `need ${required}, found ${candidates.length}`);

      const txnCtl = new AbortController();
      inflight.set(`${req.txnId}/${req.branchId}`, txnCtl);
      const used = new Set<string>();
      const roleAddress = group.address.split("?")[0];
      const summary = summarize(req.plan, group);

      const pickNext = (after?: string): string | undefined => {
        const delegates = after ? opts.directory.get(after)?.delegates ?? [] : [];
        const pick = [...delegates.filter((d) => candidates.includes(d)), ...candidates].find((id) => !used.has(id));
        if (pick) used.add(pick);
        return pick;
      };

      // One "slot" per required approver. A slot escalates to the next eligible human when the current one misses their SLA.
      const runSlot = async (slot: number): Promise<Approval | null> => {
        const routedVia = [roleAddress];
        const reasons: string[] = [];
        let human = pickNext();
        while (human && !txnCtl.signal.aborted) {
          const card = opts.directory.get(human)!;
          routedVia.push(human);
          const ask: Ask = {
            askId: `${req.txnId}:${groupId}:${slot}:${routedVia.length}`,
            txnId: req.txnId, groupId, planDigest: req.planDigest, requirement: group.requirement,
            summary, agentProvidedText: req.plan.purpose, routedVia: [...routedVia],
          };
          const askCtl = new AbortController();
          const onTxnAbort = () => askCtl.abort();
          txnCtl.signal.addEventListener("abort", onTxnAbort, { once: true });
          const slaMs = (card.sla?.decideSeconds ?? 900) * msPerSecond;
          log(`ask → ${human} (SLA ${card.sla?.decideSeconds ?? 900}s)`);
          bumpLoad(human, +1);
          const result = await Promise.race([opts.channel.deliver(ask, card, askCtl.signal), sleep(slaMs, askCtl.signal)]).catch(() => "timeout" as const);
          bumpLoad(human, -1);
          askCtl.abort();
          txnCtl.signal.removeEventListener("abort", onTxnAbort);

          if (result === "timeout") {
            if (txnCtl.signal.aborted) return null;
            reasons.push(`${human} did not decide within SLA`);
            log(`⏱  ${human} missed SLA, escalating`);
            human = pickNext(human);
            continue;
          }
          const decidedAt = new Date(now()).toISOString();
          return signObject<Approval>(
            {
              type: "hatp.approval", txnId: req.txnId, groupId, planDigest: req.planDigest,
              decision: result.decision, approver: human, routedVia,
              routingReason: reasons.length ? reasons.join("; ") : undefined,
              authentication: { method: result.method, at: decidedAt, assurance: result.assurance ?? "gateway-attested" },
              nonce: nonce(), decidedAt, issuer: opts.id,
            },
            opts.signer,
          );
        }
        return null;
      };

      const deadlineMs = Date.parse(group.decideBy) - now();
      const approvals: Approval[] = [];
      let rejected = 0;
      const majority = group.rejectPolicy === "majority";
      const deadline = setTimeout(() => txnCtl.abort(), Math.max(0, deadlineMs));

      await Promise.all(
        Array.from({ length: required }, (_, i) =>
          runSlot(i).then((a) => {
            if (!a) return;
            approvals.push(a);
            if (a.decision === "reject") {
              rejected++;
              if (!majority || rejected > required / 2) txnCtl.abort(); // stop asking others
            }
          }),
        ),
      );
      clearTimeout(deadline);
      inflight.delete(`${req.txnId}/${req.branchId}`);

      const approved = approvals.filter((a) => a.decision === "approve").length;
      if (approved >= required && rejected === 0) {
        return { vote: "yes", approvals, receipt: receipt("prepare", req, "yes", { approvers: approvals.map((a) => a.approver) }) };
      }
      const code = rejected > 0 ? "REJECTED" : now() >= Date.parse(group.decideBy) ? "DEADLINE_EXCEEDED" : "QUORUM_UNREACHABLE";
      return { ...no(code, `${approved}/${required} approvals, ${rejected} rejections`), approvals };
    },

    async commit(req: PhaseRequest): Promise<CommitResult> {
      opts.channel.notify?.({ txnId: req.txnId, groupId: req.branchId.replace(/^approval:/, ""), outcome: "committed" });
      return { receipt: receipt("commit", req, "notified") };
    },

    async abort(req: PhaseRequest): Promise<{ receipt: Receipt }> {
      inflight.get(`${req.txnId}/${req.branchId}`)?.abort(); // withdraw any open asks
      opts.channel.notify?.({ txnId: req.txnId, groupId: req.branchId.replace(/^approval:/, ""), outcome: "aborted" });
      return { receipt: receipt("abort", req, "withdrawn") };
    },
  };
}
