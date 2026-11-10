// Human Gateway: humans as transaction participants (spec §6.3, §8.4).
// Resolves human:// addresses, delivers asks over pluggable channels, escalates on SLA
// expiry, enforces quorum, and returns approvals signed over the plan digest.
import { amountProblem, exact, withTolerance } from "./amounts.ts";
import { nonce, planDigest, signObject } from "./crypto.ts";
import type { Signer } from "./crypto.ts";
import { actionAmount, actionChallenge, actionDigest } from "./actions.ts";
import type { Action, ActionApproval, ActionRequirement, AskApproveRequest, AskApproveResult } from "./actions.ts";
import { parseHumanAddress } from "./directory.ts";
import type { Directory } from "./directory.ts";
import { answerChallenge, answerDigest, answerProblem, questionDigest, questionProblem } from "./questions.ts";
import type { Answer, AnswerValue, AskQuestionRequest, AskQuestionResult, Question } from "./questions.ts";
import { approvalChallenge, passkeysOf, verifyAssertion } from "./webauthn.ts";
import { HatpError } from "./types.ts";
import type { Approval, ApprovalGroup, Assurance, CommitResult, Estimate, HatpCode, HumanCard, Money, Participant, PhaseRequest, Plan, PrepareRequest, Receipt, Routing, StatusRequest, TightenRequest, Vote, WebAuthnAssertion } from "./types.ts";

/** Decision-relevant content, always rendered from the structured plan (spec §10.3). */
export interface AskSummary {
  onBehalfOf?: string;
  initiator: string;
  deadline: string;
  decideBy: string;
  lines: { participant: string; tool: string; arguments: Record<string, unknown>; amount?: Money; settles?: string[]; tier: string }[];
  totals: Money[];
  /** The most this approval allows: `totals` plus tolerance on anything not yet held. Equal to `totals` when nothing can move (spec §10.3). */
  maxTotals: Money[];
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
  /** The approval's nonce, fixed before the human decides so a passkey can sign over it. */
  nonce: string;
  /** WebAuthn challenge (base64url) for each decision: `approvalChallenge` over this ask (spec §8.4). */
  challenges: { approve: string; reject: string };
  /** Minimum assurance the group needs; `human-signed` means approve only counts with a passkey assertion. */
  assurance: Assurance;
}

export interface HumanDecision {
  decision: "approve" | "reject";
  /** How the human was authenticated at decision time, e.g. "webauthn", "slack-sso". */
  method: string;
  /**
   * A passkey assertion over `ask.challenges[decision]`. The gateway verifies it against the human's card
   * and only then records the approval as `human-signed`.
   */
  webauthn?: WebAuthnAssertion;
  /** Set by the gateway when it adapts a `HumanAnswer` to a decision; channels don't set it. */
  answer?: AnswerValue;
  /** @deprecated Ignored: the gateway derives assurance from `webauthn`. */
  assurance?: Assurance;
}

/** An ask to approve one MCP tool call, outside any transaction (Human Gateway SEP §5). */
export interface ActionAsk {
  askId: string;
  /** Channels render the ask from this: server, tool, arguments, and payment when present (SEP §5.2, step 3). */
  action: Action;
  actionDigest: string;
  /** The gated server the approval is for: `action.server`. */
  audience: string;
  requirement: ActionRequirement;
  /** The amount authority was checked against, read from the action itself (`amountFrom`). */
  amount?: Money;
  decideBy: string;
  /** Free text written by the agent. Channels MUST show it separately, labelled as agent-provided. */
  agentProvidedText?: string;
  routedVia: string[];
  nonce: string;
  /** When an approval given in this ask stops being valid. Fixed now, because the passkey signs it (SEP §7.1). */
  expiresAt: string;
  /** WebAuthn challenge (base64url) for each decision: `actionChallenge` over this ask. */
  challenges: { approve: string; reject: string };
  assurance: Assurance;
}

/** A question to one human (spec/hatp-asks.md). The whole question is requester-written: channels label it so. */
export interface QuestionAsk {
  askId: string;
  question: Question;
  questionDigest: string;
  decideBy: string;
  agentProvidedText?: string;
  routedVia: string[];
  /** Goes into `answerChallenge`, which the channel computes once the human has answered. */
  nonce: string;
  audience?: string;
  assurance: Assurance;
}

/** What a human did with a question. A decline hands it to the next eligible human. */
export interface HumanAnswer {
  status: "answered" | "declined";
  answer?: AnswerValue;
  method: string;
  /** A passkey assertion over `answerChallenge` for this ask, this human and this answer. */
  webauthn?: WebAuthnAssertion;
}

export interface HumanChannel {
  /** Deliver the ask and resolve when the human decides. Must stop waiting when `signal` aborts. */
  deliver(ask: Ask, human: HumanCard, signal: AbortSignal): Promise<HumanDecision>;
  /** Deliver an ask to approve a single tool call (SEP §5). Without it, the gateway answers `askApprove` with NOT_SUPPORTED. */
  deliverAction?(ask: ActionAsk, human: HumanCard, signal: AbortSignal): Promise<HumanDecision>;
  /** Deliver a question (choose, form, text). Without it, the gateway answers `askQuestion` with NOT_SUPPORTED. */
  deliverQuestion?(ask: QuestionAsk, human: HumanCard, signal: AbortSignal): Promise<HumanAnswer>;
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
  /**
   * Answer `prepare` with a `pending` vote when no decision arrives within `afterMs` (default 0), instead of
   * holding the request open while humans decide. The coordinator then polls `status` no sooner than
   * `pollAfterSeconds` (default 30). Without it, `prepare` returns only once the humans decide.
   */
  pending?: { afterMs?: number; pollAfterSeconds?: number };
  /**
   * For records read outside the organisation: a stable pseudonym for each human who was not asked.
   * Their exclusion `detail` is dropped too, since a limit identifies a person (spec §8.3).
   */
  pseudonym?: (id: string) => string;
  /**
   * How long an action approval stays valid after the latest moment its ask could be decided: the end of
   * that human's SLA, or `decideBy` if sooner. Real seconds, not SLA seconds. Default 600 (SEP §5.4).
   */
  actionApprovalTtlSeconds?: number;
}

/** Who sent an ask, as the gateway's transport authenticated them. That person never approves it (SEP §5.2, step 2). */
export interface AskContext {
  principal?: string;
  /** Aborting it withdraws every open ask: the requester cancelled the request or its task. */
  signal?: AbortSignal;
}

/** The plan's declared amounts, summed per currency. An amount is stated once, on the branch where the cost arises (spec §5.1). */
export function planTotals(plan: Plan): Money[] {
  const totals = new Map<string, number>();
  for (const b of plan.branches) {
    if (b.amount) totals.set(b.amount.currency, (totals.get(b.amount.currency) ?? 0) + b.amount.value);
  }
  return [...totals].map(([currency, value]) => ({ currency, value: exact(value) }));
}

/**
 * The amounts a group's authority is checked against, derived from the plan because the agent wrote
 * `requirement` (spec §6.3). Tolerance is included, since a hold may come in that far above plan.
 * A stated requirement may ask for more than the plan totals, never less.
 */
export function authorityAmounts(plan: Plan, group: ApprovalGroup): Money[] {
  // Checked here too: the gateway doesn't rely on the coordinator having validated the plan.
  const problem = amountProblem(plan);
  if (problem) throw new HatpError("PLAN_INVALID", problem);
  const stated = group.requirement.amount;
  const totals = planTotals(plan);
  if (stated) {
    const other = totals.find((t) => t.currency !== stated.currency);
    if (other) throw new HatpError("PLAN_INVALID", `group ${group.groupId}: requirement is in ${stated.currency}, the plan also spends ${other.currency}`);
    const total = totals[0]?.value ?? 0;
    if (stated.value < total) throw new HatpError("PLAN_INVALID", `group ${group.groupId}: requirement ${stated.value} ${stated.currency} is below the plan total ${total}`);
  }
  const amounts = totals.map((t) => ({ currency: t.currency, value: withTolerance(t.value, plan.tolerance?.amountPercent) }));
  if (!stated) return amounts;
  return [{ currency: stated.currency, value: Math.max(stated.value, amounts[0]?.value ?? 0) }];
}

/**
 * What a group's routing must say it checked, recomputed from the plan alone, so a verifier gets
 * the same answer as the gateway. `failure` is the plan's own fault: no amount check ran.
 */
export function routingCheck(plan: Plan, group: ApprovalGroup): Pick<Routing, "address" | "requirement" | "planTotals" | "checked"> & { failure?: { code: HatpCode; message: string } } {
  const base = { address: group.address.split("?")[0], requirement: group.requirement, planTotals: amountProblem(plan) ? [] : planTotals(plan) };
  try {
    const amounts = authorityAmounts(plan, group);
    return { ...base, checked: amounts.length ? amounts : "absent" };
  } catch (e) {
    if (!(e instanceof HatpError)) throw e;
    return { ...base, checked: "absent", failure: { code: e.code, message: e.message } };
  }
}

export function summarize(plan: Plan, group: ApprovalGroup): AskSummary {
  // holds-first: the real held amounts are in the signed plan, so those are what the human sees.
  const held = (b: Plan["branches"][number]) => plan.holds?.branches[b.branchId]?.amount;
  const sum = (amountOf: (b: Plan["branches"][number]) => Money | undefined) => {
    const totals = new Map<string, number>();
    for (const b of plan.branches) {
      const m = amountOf(b);
      if (m) totals.set(m.currency, (totals.get(m.currency) ?? 0) + m.value);
    }
    return [...totals].map(([currency, value]) => ({ currency, value: exact(value) }));
  };
  const shown = (b: Plan["branches"][number]) => held(b) ?? b.amount;
  const most = (b: Plan["branches"][number]) => held(b) ?? (b.amount && { ...b.amount, value: withTolerance(b.amount.value, plan.tolerance?.amountPercent) });
  return {
    onBehalfOf: plan.onBehalfOf,
    initiator: plan.initiator,
    deadline: plan.deadline,
    decideBy: group.decideBy,
    lines: plan.branches.map((b) => ({ participant: b.participant, tool: b.operation.tool, arguments: b.operation.arguments, amount: shown(b), settles: b.settles, tier: b.tier })),
    totals: sum(shown),
    maxTotals: sum(most),
  };
}

/**
 * Escalation order: the delegates of the human who just missed their SLA come first, then the
 * remaining candidates in rank order. Each human is asked at most once per approval group.
 */
function escalationOrder(directory: Directory, candidates: string[]) {
  const used = new Set<string>();
  return (after?: string): string | undefined => {
    const delegates = after ? directory.get(after)?.delegates ?? [] : [];
    const pick = [...delegates.filter((d) => candidates.includes(d)), ...candidates].find((id) => !used.has(id));
    if (pick) used.add(pick);
    return pick;
  };
}

/**
 * Worst-case SLA seconds before an approval group stops waiting, assuming every human asked
 * times out: each of the `required` slots walks the escalation chain in parallel (spec §6.3).
 */
export function escalationWorstCase(directory: Directory, candidates: string[], required: number): number {
  const next = escalationOrder(directory, candidates);
  const sla = (id: string) => directory.get(id)?.sla?.decideSeconds ?? 900;
  const slots = Array.from({ length: required }, () => {
    const human = next();
    return { human, end: human ? sla(human) : 0 };
  });
  for (;;) {
    const active = slots.filter((s) => s.human);
    if (!active.length) break;
    const s = active.reduce((a, b) => (b.end < a.end ? b : a)); // the next ask to time out escalates first
    s.human = next(s.human);
    if (s.human) s.end += sla(s.human);
  }
  return Math.max(0, ...slots.map((s) => s.end));
}

export type HumanGateway = Participant & {
  /** Asks eligible humans to approve one tool call and returns their signed Approvals (SEP §5). */
  askApprove(req: AskApproveRequest, ctx?: AskContext): Promise<AskApproveResult>;
  /** Asks eligible humans a question and returns their signed Answers (spec/hatp-asks.md). */
  askQuestion(req: AskQuestionRequest, ctx?: AskContext): Promise<AskQuestionResult>;
  /** Exposed for demos and tests: approval branches still being asked, and tightened deadlines held. */
  inspect(): { inflight: string[]; cutoffs: string[] };
};

export function createHumanGateway(opts: HumanGatewayOptions): HumanGateway {
  const now = opts.now ?? Date.now;
  const msPerSecond = opts.msPerSecond ?? 1000;
  const log = opts.log ?? (() => {});
  const inflight = new Map<string, { ctl: AbortController; reschedule(): void }>();
  // Effective decideBy per approval branch, once a coordinator has tightened it (spec §7.10).
  // Kept even before prepare arrives, so a tighten that overtakes its prepare still applies.
  // `until` is the signed decideBy: past it the entry can never matter, so tighten prunes it.
  const cutoffs = new Map<string, { at: number; until: number }>();

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

  // Separation of duties: the person the agent acts for never approves their own request.
  function resolveGroup(req: PrepareRequest): { group: ApprovalGroup; candidates: string[]; routing: Routing; failure?: { code: HatpCode; message: string } } {
    const groupId = req.branchId.replace(/^approval:/, "");
    const group = req.plan.approvals?.find((g) => g.groupId === groupId);
    if (!group) throw new HatpError("TXN_UNKNOWN", `no approval group ${groupId}`);
    const { failure, ...check } = routingCheck(req.plan, group);
    if (failure) return { group, candidates: [], routing: { ...check, humans: [] }, failure };
    const exclude = req.plan.onBehalfOf ? [req.plan.onBehalfOf] : [];
    const result = opts.directory.evaluate({ address: group.address, requirement: group.requirement, amounts: check.checked === "absent" ? [] : check.checked, exclude, deadline: group.decideBy, assurance: group.assurance, now: now() });
    const candidates = result.candidates.map((c) => c.id);
    const humans = result.evaluated.map((h): Routing["humans"][number] => (h.excluded ? { id: h.id, result: "excluded", ...h.excluded } : { id: h.id, result: "eligible" }));
    const short = candidates.length < group.quorum.required ? { code: "QUORUM_UNREACHABLE" as const, message: `need ${group.quorum.required}, found ${candidates.length}` } : undefined;
    return { group, candidates, routing: { ...check, humans }, failure: result.shortfall ?? short };
  }

  /** The routing as signed: who was asked is known by now, and humans not asked may be pseudonymous. */
  const signedRouting = (routing: Routing, asked: Set<string>): Routing => ({
    ...routing,
    humans: routing.humans.map((h) => {
      if (asked.has(h.id)) return { id: h.id, result: "asked" };
      if (!opts.pseudonym) return h;
      const { detail: _detail, ...coarse } = h;
      return { ...coarse, id: opts.pseudonym(h.id) };
    }),
  });

  // Deferred votes (spec §7.1, §7.7): a decision still open after `pending.afterMs` is answered with a
  // signed `pending` vote; the asks keep running and `status` hands over the final vote.
  const deferred = new Map<string, { vote?: Vote; settled: Promise<Vote>; until: number }>();
  // After the outcome, a deferred vote is kept until its group's signed deadline, so a repeated prepare
  // gets the same answer instead of a second round of asks; then it is forgotten.
  const forget = (key: string) => {
    const entry = deferred.get(key);
    if (!entry) return;
    setTimeout(() => deferred.delete(key), Math.max(0, entry.until - now())).unref?.();
  };
  const pendingVote = (req: PrepareRequest | StatusRequest): Vote => {
    const pollAfterSeconds = opts.pending?.pollAfterSeconds ?? 30;
    return { vote: "pending", pollAfterSeconds, receipt: receipt("prepare", req, "pending", { pollAfterSeconds }) };
  };

  /**
   * Asks humans until `required` of them decide (spec §6.3): one slot per required approver, each escalating
   * to a delegate or the next candidate when someone misses their SLA, or when a decision fails verification.
   * Shared by transaction votes and single-action asks, which differ only in the ask a channel shows and
   * the approval they sign.
   */
  async function askUntilDecided<A>(o: {
    candidates: string[];
    required: number;
    rejectPolicy?: "any" | "majority";
    /** `escalate`: a rejection (a declined question) hands the slot to the next human instead of ending it. */
    onReject?: "stop" | "escalate";
    /** Filled with the humans who declined, when `onReject` is `escalate`. */
    declined?: string[];
    ctl: AbortController;
    asked: Set<string>;
    root: string;
    assurance?: Assurance;
    /** One ask to one human: the challenge a passkey signs for a decision, delivery, and the signed result. */
    open(human: string, card: HumanCard, o: { slot: number; routedVia: string[]; nonce: string; slaMs: number }): {
      challenge(result: HumanDecision): string;
      /** Why a decision can't be accepted as given (an answer that doesn't fit its question), or undefined. */
      accept?(result: HumanDecision): string | undefined;
      deliver(signal: AbortSignal): Promise<HumanDecision>;
      sign(result: HumanDecision, reasons: string[], assurance: Assurance): A;
    };
  }): Promise<{ approvals: A[]; rejected: number }> {
    const pickNext = escalationOrder(opts.directory, o.candidates);
    const runSlot = async (slot: number): Promise<{ value: A; rejected: boolean } | null> => {
      const routedVia = [o.root];
      const reasons: string[] = [];
      let human = pickNext();
      while (human && !o.ctl.signal.aborted) {
        const card = opts.directory.get(human)!;
        routedVia.push(human);
        o.asked.add(human);
        const h = human;
        const slaMs = (card.sla?.decideSeconds ?? 900) * msPerSecond;
        const session = o.open(h, card, { slot, routedVia: [...routedVia], nonce: nonce(), slaMs });
        const askCtl = new AbortController();
        const onAbort = () => askCtl.abort();
        o.ctl.signal.addEventListener("abort", onAbort, { once: true });
        log(`ask → ${h} (SLA ${card.sla?.decideSeconds ?? 900}s)`);
        bumpLoad(h, +1);
        const result = await Promise.race([session.deliver(askCtl.signal), sleep(slaMs, askCtl.signal)]).catch(() => "timeout" as const);
        bumpLoad(h, -1);
        askCtl.abort();
        o.ctl.signal.removeEventListener("abort", onAbort);

        if (result === "timeout") {
          if (o.ctl.signal.aborted) return null;
          reasons.push(`${h} did not decide within SLA`);
          log(`⏱  ${h} missed SLA, escalating`);
          human = pickNext(h);
          continue;
        }
        if (result.decision === "reject" && o.onReject === "escalate") {
          reasons.push(`${h} declined`);
          o.declined?.push(h);
          log(`↷  ${h} declined, escalating`);
          human = pickNext(h);
          continue;
        }
        // Human-signed only when the passkey assertion verifies against a key on the human's own card.
        let assurance: Assurance = "gateway-attested";
        let refused = session.accept?.(result);
        if (refused) {
          // a malformed decision says nothing about the human: ask the next one
        } else if (result.webauthn) {
          const key = passkeysOf(card).find((k) => k.kid === result.webauthn!.kid);
          refused = key ? verifyAssertion(result.webauthn, key, session.challenge(result)) : `${result.webauthn.kid} is not on ${h}'s card`;
          assurance = "human-signed";
        } else if (o.assurance === "human-signed" && result.decision === "approve") {
          refused = "approved without a passkey";
        }
        if (refused) {
          reasons.push(`${h}'s decision was not accepted: ${refused}`);
          log(`✗  ${h}: ${refused}, escalating`);
          human = pickNext(h);
          continue;
        }
        return { value: session.sign(result, reasons, assurance), rejected: result.decision === "reject" };
      }
      return null;
    };

    const approvals: A[] = [];
    let rejected = 0;
    const majority = o.rejectPolicy === "majority";
    await Promise.all(
      Array.from({ length: o.required }, (_, i) =>
        runSlot(i).then((r) => {
          if (!r) return;
          approvals.push(r.value);
          if (r.rejected) {
            rejected++;
            if (!majority || rejected > o.required / 2) o.ctl.abort(); // stop asking others
          }
        }),
      ),
    );
    return { approvals, rejected };
  }

  async function decideVote(req: PrepareRequest): Promise<Vote> {
    const no = (code: string, message: string, routing?: Routing): Vote => ({ vote: "no", reason: { code, message }, receipt: receipt("prepare", req, "no", { code, routing }) });
    if (planDigest(req.plan) !== req.planDigest) return no("PLAN_MISMATCH", "plan digest does not match plan");
    let group: ApprovalGroup;
    let candidates: string[];
    let routing: Routing;
    let failure: { code: HatpCode; message: string } | undefined;
    try {
      ({ group, candidates, routing, failure } = resolveGroup(req));
    } catch (e) {
      return no(e instanceof HatpError ? e.code : "QUORUM_UNREACHABLE", (e as Error).message);
    }
    const asked = new Set<string>();
    if (failure) return no(failure.code, failure.message, signedRouting(routing, asked));
    const groupId = group.groupId;
    const required = group.quorum.required;

    const key = `${req.txnId}/${req.branchId}`;
    const signedDecideBy = Date.parse(group.decideBy);
    const decideBy = () => Math.min(signedDecideBy, cutoffs.get(key)?.at ?? Infinity);
    const txnCtl = new AbortController();
    let deadline: ReturnType<typeof setTimeout> | undefined;
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

    reschedule();
    const { approvals, rejected } = await askUntilDecided<Approval>({
      candidates, required, rejectPolicy: group.rejectPolicy, ctl: txnCtl, asked, root: roleAddress, assurance: group.assurance,
      open: (human, card, { slot, routedVia, nonce: askNonce }) => {
        const challenge = (decision: "approve" | "reject") => approvalChallenge({ txnId: req.txnId, groupId, planDigest: req.planDigest, decision, approver: human, nonce: askNonce });
        const ask: Ask = {
          askId: `${req.txnId}:${groupId}:${slot}:${routedVia.length}`,
          txnId: req.txnId, groupId, planDigest: req.planDigest, requirement: group.requirement,
          summary: { ...summary, decideBy: new Date(decideBy()).toISOString() }, agentProvidedText: req.plan.purpose, routedVia,
          nonce: askNonce, challenges: { approve: challenge("approve"), reject: challenge("reject") }, assurance: group.assurance ?? "gateway-attested",
        };
        return {
          challenge: (r) => challenge(r.decision),
          deliver: (signal) => opts.channel.deliver(ask, card, signal),
          sign: (result, reasons, assurance) => {
            const decidedAt = new Date(now()).toISOString();
            return signObject<Approval>(
              {
                type: "hatp.approval", txnId: req.txnId, groupId, planDigest: req.planDigest,
                decision: result.decision, approver: human, routedVia,
                routingReason: reasons.length ? reasons.join("; ") : undefined,
                authentication: { method: result.webauthn ? "webauthn" : result.method, at: decidedAt, assurance, webauthn: result.webauthn },
                nonce: askNonce, decidedAt, issuer: opts.id,
              },
              opts.signer,
            );
          },
        };
      },
    });
    clearTimeout(deadline);
    inflight.delete(key);
    cutoffs.delete(key);

    const approved = approvals.filter((a) => a.decision === "approve").length;
    if (approved >= required && rejected === 0) {
      return { vote: "yes", approvals, receipt: receipt("prepare", req, "yes", { approvers: approvals.map((a) => a.approver), routing: signedRouting(routing, asked) }) };
    }
    const code = rejected > 0 ? "REJECTED" : expired ? "DEADLINE_EXCEEDED" : "QUORUM_UNREACHABLE";
    return { ...no(code, `${approved}/${required} approvals, ${rejected} rejections`, signedRouting(routing, asked)), approvals };
  }

  // Single-action asks (SEP §5): the same routing, escalation and passkey checks as a transaction vote,
  // but the approval binds one tools/call through its action digest, is addressed to the gated server,
  // and expires. There is no pending vote here: the caller waits, or uses Tasks once the binding has them.
  /** Runs `fn` until it settles or `deadlineMs` passes; `signal` withdraws every open ask (a cancelled request or task). */
  async function untilDeadline<T>(deadlineMs: number, signal: AbortSignal | undefined, fn: (ctl: AbortController) => Promise<T>): Promise<{ value: T; expired: boolean }> {
    const ctl = new AbortController();
    let expired = false;
    const timer = setTimeout(() => { expired = true; ctl.abort(); }, Math.max(0, deadlineMs - now()));
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const value = await fn(ctl);
      if (signal?.aborted) throw new HatpError("INVALID_STATE", "the ask was withdrawn by the requester");
      return { value, expired };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // Questions (spec/hatp-asks.md): the same routing as approvals, but a human may decline, which hands the
  // question to the next eligible human, and the answer is checked against the question before it is signed.
  async function askQuestion(req: AskQuestionRequest, ctx: AskContext = {}): Promise<AskQuestionResult> {
    const q = req?.question;
    const problem = questionProblem(q);
    if (problem) throw new HatpError("PLAN_INVALID", problem);
    if (typeof req.address !== "string") throw new HatpError("PLAN_INVALID", "address required");
    const decideByMs = Date.parse(req.decideBy);
    if (!Number.isFinite(decideByMs)) throw new HatpError("PLAN_INVALID", "decideBy must be a timestamp");
    if (questionDigest(q) !== req.questionDigest) throw new HatpError("ACTION_MISMATCH", "questionDigest does not match question");
    if (!opts.channel.deliverQuestion) throw new HatpError("NOT_SUPPORTED", "this gateway's channel cannot deliver questions");
    if (decideByMs <= now()) throw new HatpError("DEADLINE_EXCEEDED", "decideBy has passed");

    const required = parseHumanAddress(req.address).quorum?.required ?? 1;
    const exclude = ctx.principal ? [ctx.principal] : [];
    const result = opts.directory.evaluate({ address: req.address, requirement: req.requirement && { action: req.requirement.action }, exclude, deadline: req.decideBy, assurance: req.assurance, now: now() });
    if (result.shortfall) throw new HatpError(result.shortfall.code, result.shortfall.message);

    const deliverQuestion = opts.channel.deliverQuestion.bind(opts.channel);
    const declined: string[] = [];
    const { value: decided, expired } = await untilDeadline(decideByMs, ctx.signal, (ctl) =>
      askUntilDecided<Answer>({
        candidates: result.candidates.map((c) => c.id), required, onReject: "escalate", declined, ctl, asked: new Set(), root: req.address.split("?")[0], assurance: req.assurance,
        open: (human, card, { slot, routedVia, nonce: askNonce }) => {
          const ask: QuestionAsk = {
            askId: `${req.questionDigest}:${slot}:${routedVia.length}`, question: q, questionDigest: req.questionDigest, decideBy: req.decideBy,
            agentProvidedText: req.purpose, routedVia, nonce: askNonce, audience: req.audience, assurance: req.assurance ?? "gateway-attested",
          };
          return {
            challenge: (r) => answerChallenge({ questionDigest: req.questionDigest, answer: r.answer!, responder: human, nonce: askNonce, audience: req.audience }),
            accept: (r) => answerProblem(q, r.answer),
            deliver: async (signal) => {
              const h = await deliverQuestion(ask, card, signal);
              return { decision: h.status === "answered" ? "approve" : "reject", answer: h.answer, method: h.method, webauthn: h.webauthn };
            },
            sign: (r, reasons, assurance) => {
              const decidedAt = new Date(now()).toISOString();
              return signObject<Answer>(
                {
                  type: "hatp.answer", questionDigest: req.questionDigest, answer: r.answer!, answerDigest: answerDigest(r.answer!), responder: human, routedVia,
                  routingReason: reasons.length ? reasons.join("; ") : undefined,
                  authentication: { method: r.webauthn ? "webauthn" : r.method, at: decidedAt, assurance, webauthn: r.webauthn },
                  audience: req.audience, nonce: askNonce, decidedAt, issuer: opts.id,
                },
                opts.signer,
              );
            },
          };
        },
      }),
    );
    const { approvals: answers } = decided;
    if (answers.length >= required) return { status: "answered", answers, declinedBy: declined };
    if (expired) throw new HatpError("DEADLINE_EXCEEDED", `${answers.length}/${required} answers by decideBy`);
    if (declined.length) return { status: "declined", answers, declinedBy: declined };
    throw new HatpError("QUORUM_UNREACHABLE", `every eligible human was asked; ${answers.length}/${required} answered`);
  }

  async function askApprove(req: AskApproveRequest, ctx: AskContext = {}): Promise<AskApproveResult> {
    const a = req?.action;
    if (!a || a.type !== "mcp.tools/call" || typeof a.server !== "string" || typeof a.tool !== "string" || !a.arguments || typeof a.arguments !== "object" || Array.isArray(a.arguments)) {
      throw new HatpError("PLAN_INVALID", "action must be an mcp.tools/call with server, tool and arguments");
    }
    if (typeof req.address !== "string" || typeof req.requirement?.action !== "string") throw new HatpError("PLAN_INVALID", "address and requirement.action required");
    const decideByMs = Date.parse(req.decideBy);
    if (!Number.isFinite(decideByMs)) throw new HatpError("PLAN_INVALID", "decideBy must be a timestamp");
    if (actionDigest(a) !== req.actionDigest) throw new HatpError("ACTION_MISMATCH", "actionDigest does not match action");
    if (!opts.channel.deliverAction) throw new HatpError("NOT_SUPPORTED", "this gateway's channel cannot deliver action asks");
    if (decideByMs <= now()) throw new HatpError("DEADLINE_EXCEEDED", "decideBy has passed");

    // Authority is checked against the amount in the action, never one the agent states lower (SEP §6).
    const amount = actionAmount(a, req.requirement);
    const required = parseHumanAddress(req.address).quorum?.required ?? 1;
    const exclude = ctx.principal ? [ctx.principal] : [];
    const result = opts.directory.evaluate({ address: req.address, requirement: { action: req.requirement.action, amount }, amounts: amount ? [amount] : [], exclude, deadline: req.decideBy, assurance: req.assurance, now: now() });
    if (result.shortfall) throw new HatpError(result.shortfall.code, result.shortfall.message);

    const ttlMs = (opts.actionApprovalTtlSeconds ?? 600) * 1000;
    const deliverAction = opts.channel.deliverAction.bind(opts.channel);
    const { value: decided, expired } = await untilDeadline(decideByMs, ctx.signal, (ctl) =>
      askUntilDecided<ActionApproval>({
        candidates: result.candidates.map((c) => c.id), required, ctl, asked: new Set(), root: req.address.split("?")[0], assurance: req.assurance,
        open: (human, card, { slot, routedVia, nonce: askNonce, slaMs }) => {
          // The latest this human can decide is the end of their SLA, or decideBy; the approval lasts ttl beyond that.
          const expiresAt = new Date(Math.min(now() + slaMs, decideByMs) + ttlMs).toISOString();
          const challenge = (decision: "approve" | "reject") => actionChallenge({ actionDigest: req.actionDigest, decision, approver: human, audience: a.server, nonce: askNonce, expiresAt });
          const ask: ActionAsk = {
            askId: `${req.actionDigest}:${slot}:${routedVia.length}`, action: a, actionDigest: req.actionDigest, audience: a.server,
            requirement: req.requirement, amount, decideBy: req.decideBy, agentProvidedText: req.purpose, routedVia,
            nonce: askNonce, expiresAt, challenges: { approve: challenge("approve"), reject: challenge("reject") }, assurance: req.assurance ?? "gateway-attested",
          };
          return {
            challenge: (r) => challenge(r.decision),
            deliver: (signal) => deliverAction(ask, card, signal),
            sign: (r, reasons, assurance) => {
              const decidedAt = new Date(now()).toISOString();
              return signObject<ActionApproval>(
                {
                  type: "hatp.approval", actionDigest: req.actionDigest, decision: r.decision, approver: human, routedVia,
                  routingReason: reasons.length ? reasons.join("; ") : undefined,
                  authentication: { method: r.webauthn ? "webauthn" : r.method, at: decidedAt, assurance, webauthn: r.webauthn },
                  audience: a.server, nonce: askNonce, decidedAt, expiresAt, issuer: opts.id,
                },
                opts.signer,
              );
            },
          };
        },
      }),
    );
    const { approvals, rejected } = decided;
    // A rejection returns only the signed rejections: an approval from another member of a failed
    // quorum must not be usable on its own against a tool that asks for fewer approvers.
    if (rejected > 0) return { decision: "reject", approvals: approvals.filter((x) => x.decision === "reject") };
    if (approvals.length >= required) return { decision: "approve", approvals };
    if (expired) throw new HatpError("DEADLINE_EXCEEDED", `${approvals.length}/${required} approvals by decideBy`);
    throw new HatpError("QUORUM_UNREACHABLE", `every eligible human was asked; ${approvals.length}/${required} approved`);
  }

  return {
    id: opts.id,
    askApprove,
    askQuestion,

    inspect() {
      return { inflight: [...inflight.keys()], cutoffs: [...cutoffs.keys()] };
    },

    async prepare(req: PrepareRequest): Promise<Vote> {
      const key = `${req.txnId}/${req.branchId}`;
      const known = deferred.get(key);
      if (known) return known.vote ?? pendingVote(req); // a repeated prepare asks nobody twice
      if (!opts.pending) return decideVote(req);
      const group = req.plan.approvals?.find((g) => `approval:${g.groupId}` === req.branchId);
      const entry: { vote?: Vote; settled: Promise<Vote>; until: number } = { settled: decideVote(req), until: group ? Date.parse(group.decideBy) : now() };
      entry.settled.then((v) => { entry.vote = v; }, () => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const early = await Promise.race([entry.settled, new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), opts.pending!.afterMs ?? 0); })]);
      clearTimeout(timer);
      if (early) return early;
      deferred.set(key, entry);
      log(`no decision yet for ${key}: voting pending`);
      return pendingVote(req);
    },

    async status(req: StatusRequest): Promise<Vote> {
      const entry = deferred.get(`${req.txnId}/${req.branchId}`);
      if (!entry) throw new HatpError("TXN_UNKNOWN", `no pending vote for ${req.txnId}/${req.branchId}`);
      return entry.vote ?? pendingVote(req);
    },

    async estimate(req: PrepareRequest): Promise<Estimate> {
      if (planDigest(req.plan) !== req.planDigest) throw new HatpError("PLAN_MISMATCH", "plan digest does not match plan");
      const { group, candidates, failure } = resolveGroup(req);
      if (failure) throw new HatpError(failure.code, failure.message);
      const worst = (escalationWorstCase(opts.directory, candidates, group.quorum.required) * msPerSecond) / 1000;
      const worstCaseSeconds = Math.max(0, Math.min(worst, (Date.parse(group.decideBy) - now()) / 1000));
      return { worstCaseSeconds, receipt: receipt("estimate", req, "estimated", { worstCaseSeconds }) };
    },

    async tighten(req: TightenRequest): Promise<{ decideBy: string; receipt: Receipt }> {
      if (planDigest(req.plan) !== req.planDigest) throw new HatpError("PLAN_MISMATCH", "plan digest does not match plan");
      const group = req.plan.approvals?.find((g) => `approval:${g.groupId}` === req.branchId);
      if (!group) throw new HatpError("TXN_UNKNOWN", `no approval group for ${req.branchId}`);
      // A coordinator may only shorten what the humans' plan digest already bounds, never extend it.
      if (Date.parse(req.decideBy) > Date.parse(group.decideBy)) throw new HatpError("INVALID_STATE", "tighten may not extend the signed decideBy");
      for (const [k, c] of cutoffs) if (c.until < now()) cutoffs.delete(k);
      const key = `${req.txnId}/${req.branchId}`;
      const cutoff = Math.min(Date.parse(req.decideBy), cutoffs.get(key)?.at ?? Infinity);
      cutoffs.set(key, { at: cutoff, until: Date.parse(group.decideBy) });
      inflight.get(key)?.reschedule();
      const decideBy = new Date(cutoff).toISOString();
      log(`deadline for ${req.branchId} tightened to ${decideBy}`);
      return { decideBy, receipt: receipt("tighten", req, "tightened", { decideBy }) };
    },

    async commit(req: PhaseRequest): Promise<CommitResult> {
      forget(`${req.txnId}/${req.branchId}`);
      opts.channel.notify?.({ txnId: req.txnId, groupId: req.branchId.replace(/^approval:/, ""), outcome: "committed" });
      return { receipt: receipt("commit", req, "notified") };
    },

    async abort(req: PhaseRequest): Promise<{ receipt: Receipt }> {
      forget(`${req.txnId}/${req.branchId}`);
      inflight.get(`${req.txnId}/${req.branchId}`)?.ctl.abort(); // withdraw any open asks
      opts.channel.notify?.({ txnId: req.txnId, groupId: req.branchId.replace(/^approval:/, ""), outcome: "aborted" });
      return { receipt: receipt("abort", req, "withdrawn") };
    },
  };
}
