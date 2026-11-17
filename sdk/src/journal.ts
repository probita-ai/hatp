// The Journal's Recorder (spec/hatp-journal.md J§5–J§6): journals an agent's direct tool calls with their undo
// information, keeps every entry and event in one hash chain, signs the Run Record, and reminds the principal
// before undo windows close. Reversal (J§8) and the autonomy policy (J§7) build on this.
import { hashObject, newTxnId, signObject, verifyObject } from "./crypto.ts";
import type { KeyRing, Signer } from "./crypto.ts";
import { setLongTimeout } from "./timers.ts";
import type { LongTimer } from "./timers.ts";
import { actionDigest } from "./actions.ts";
import type { ActionApproval, AskApproveRequest, AskApproveResult } from "./actions.ts";
import type { AskContext } from "./human-gateway.ts";
import { HatpError } from "./types.ts";
import type { Approval, ApprovalGroup, BranchState, Decision, Jwk, Money, Participant, Receipt, Signature, TxnEvent, TxnState } from "./types.ts";

export interface UndoDeclaration {
  kind: "compensate" | "none";
  windowSeconds?: number;
  sideEffects?: string[];
  cost?: Money;
  reason?: string;
  via?: "api" | "ui";
}

/** What J§4 forbids in a declaration, or undefined. A Recorder treats an operation with a problem as `unknown`. */
export function undoProblem(d: unknown): string | undefined {
  if (!d || typeof d !== "object") return "not an object";
  const u = d as UndoDeclaration;
  if (u.kind !== "compensate" && u.kind !== "none") return `kind ${String(u.kind)} is not compensate or none`;
  if (u.via !== undefined && u.via !== "api" && u.via !== "ui") return `via ${String(u.via)} is not api or ui`;
  if (u.kind === "compensate" && !(typeof u.windowSeconds === "number" && u.windowSeconds > 0)) return "compensate needs a positive windowSeconds";
  if (u.kind === "none" && !u.reason) return "none needs a reason";
  if (u.via === "ui" && !u.reason) return "via ui needs a reason naming the app feature that reverses it";
  return undefined;
}

/** Journal context the Recorder adds to `tools/call` as `_meta["hatp/journal"]` (J§5.1). */
export interface JournalMeta {
  runId: string;
  entryId: string;
  seq: number;
  recorder: string;
}

export interface Effect {
  summary: string;
  resource?: string;
  version?: string;
  /** via ui only: fingerprint of the record right before the call (J§4.1). */
  before?: string;
  uses?: string[];
}

/** A participant's receipt for a journaled call (J§5.2): `callDigest` in place of `planDigest`. */
export interface JournalReceipt {
  type: "hatp.receipt";
  txnId: string;
  branchId: string;
  callDigest: string;
  phase: "execute" | "check";
  outcome: string;
  detail?: Record<string, unknown>;
  issuedAt: string;
  issuer: string;
  signature?: Signature;
}

export interface EntryUndo {
  kind: "compensate" | "none" | "unknown";
  undoBy?: string;
  via?: "api" | "ui";
}

/** What a journal participant returns in the result's `_meta["hatp/journal"]` (J§5.2). */
export interface JournalResult {
  entryId: string;
  undo: { kind: "compensate" | "none"; undoBy?: string };
  compensationToken?: string;
  effect?: Effect;
  receipt?: JournalReceipt;
}

/** `hatp/journal/check` (J§10.3): whether a reversal would succeed now. Changes nothing. */
export interface JournalCheckRequest {
  runId: string;
  entryId: string;
  compensationToken: string;
  ifVersion?: string;
}
export interface JournalCheckResult {
  undoable: boolean;
  undoBy?: string;
  conflict?: { currentVersion: string; summary: string } | null;
  sideEffects?: string[];
  cost?: Money | null;
  remedy?: string | null;
  receipt: JournalReceipt;
}

/** `hatp/txn/compensate` for a journal entry (J§10.4): `txnId` is the runId, `branchId` the entryId. */
export interface JournalCompensateRequest {
  txnId: string;
  branchId: string;
  /** The Reversal Plan's digest, so the receipt binds the reversal the human approved. */
  planDigest: string;
  compensationToken: string;
  ifVersion?: string;
  force?: true;
}

/** A tool server as the Recorder sees it. An MCP binding stands behind this (#59). */
export interface JournalServer {
  id: string;
  /** Per-operation undo declarations from the server's capability (J§4). Absent: no `journal` role. */
  undo?: Record<string, UndoDeclaration>;
  /** Per operation that moves money: a JSON Pointer to the amount in its arguments (J§4). The spending caps count it. */
  amountFrom?: Record<string, string>;
  /** `approvals`, when the call needed one (J§7), go in `_meta["ai.probita/human-gateway"].approvals`. */
  call(req: { tool: string; arguments: Record<string, unknown>; journal: JournalMeta; approvals?: ActionApproval[] }): Promise<{ result: unknown; journal?: JournalResult }>;
  /** Optional (J§8.3). Without it, an entry is assumed undoable until `undoBy`, and conflicts surface at compensation. */
  check?(req: JournalCheckRequest): Promise<JournalCheckResult>;
  /** Reverses one entry. Throws `HatpError` (`UNDO_CONFLICT`, `UNDO_WINDOW_CLOSED`, …) when it can't, changing nothing. */
  compensate?(req: JournalCompensateRequest): Promise<{ receipt: Receipt }>;
}

export interface ReversalBranch {
  branchId: string;
  participant: string;
  tier: "compensate";
  operation: { undo: string; ifVersion?: string; force?: true };
  /** What the reversal will do, from the participant (`check`) or derived from the entry's own summary. */
  effect: string;
  sideEffects?: string[];
  cost?: Money;
  via?: "api" | "ui";
}

/** A Plan that takes back journaled calls (J§8.4). Prepared only at Human Gateways. */
export interface ReversalPlan {
  hatp: "0.3";
  txnId: string;
  reversalOf: string;
  initiator: string;
  onBehalfOf?: string;
  requestedBy: string;
  purpose?: string;
  deadline: string;
  branches: ReversalBranch[];
  notReversible?: { entryId: string; reason: string; summary?: string }[];
  unresolved?: { entryId: string; problems: string[]; summary?: string }[];
  readSince?: { runId: string; entryId: string; agent?: string; source: "declared" | "inferred"; summary?: string }[];
  approvals: ApprovalGroup[];
}

export type ReversalOutcome = "reversed" | "failed" | "skipped" | "unknown";

/** A reversal's signed record, in the Transaction Record format (J§8.5); `verifyRecord` checks it. */
export interface ReversalRecord {
  type: "hatp.record";
  plan: ReversalPlan;
  planDigest: string;
  state: TxnState;
  branches: Record<string, BranchState>;
  approvals: Approval[];
  /** The gateway's prepare receipt, participants' check receipts, and their compensate receipts. */
  receipts: Receipt[];
  decision?: Decision;
  events: TxnEvent[];
  issuer: string;
  signature?: Signature;
}

export interface ReverseRequest {
  /** `{ from: seq }`: this entry and every later one. `{ entries }`: these, plus what depends on them. */
  scope: { from: number } | { entries: string[] };
  requestedBy: string;
  /** Free text from whoever asked. Shown to approvers labelled as such. */
  reason?: string;
  /**
   * Entries the requester chose to reverse even though a check reported a conflict with newer work, or the
   * entry is unversioned. Each becomes a `force` branch, and the ask says what will be overwritten (J§8.6).
   */
  force?: string[];
}

export type ReverseResult =
  | { state: "NOTHING_TO_REVERSE"; notReversible: NonNullable<ReversalPlan["notReversible"]>; unresolved: NonNullable<ReversalPlan["unresolved"]> }
  | { state: TxnState; reversalId: string; plan: ReversalPlan; planDigest: string; outcomes: Record<string, ReversalOutcome>; record: ReversalRecord };

export type DependencySource = "declared" | "host" | "confirmed" | "inferred" | "default";
export interface DependencyLink {
  entryId: string;
  source: DependencySource;
  confirmedBy?: string;
  confirmedAt?: string;
}

export interface JournalEntry {
  type: "hatp.journal.entry";
  runId: string;
  entryId: string;
  seq: number;
  agent: string;
  onBehalfOf?: string;
  participant: string;
  tool: string;
  callDigest: string;
  arguments?: Record<string, unknown>;
  outcome?: "done" | "not-run";
  reason?: string;
  dependsOn: DependencyLink[];
  undo?: EntryUndo;
  compensationToken?: string;
  effect?: Effect;
  receipt?: JournalReceipt;
  /** The Approvals a call ran under (J§7), when the policy asked for one. */
  approvals?: ActionApproval[];
  intake?: { unresolved: true; problems: string[] };
  recordedAt: string;
  prevHash: string;
}

export type AutonomyDecision = "allow" | "ask" | "block";

/** The organisation's autonomy policy (J§7). Fixed when the Recorder is built: the agent can't change it. */
export interface AutonomyPolicy {
  compensate?: AutonomyDecision;
  /** For `compensate` operations undone through an app's user interface (J§4.1). Default `ask`. */
  compensateViaUi?: AutonomyDecision;
  unknown?: AutonomyDecision;
  none?: AutonomyDecision;
  /** The shortest undo window that earns autonomy. Shorter `compensate` windows are handled as `ask` where they'd be `allow`. */
  minWindowSeconds?: number;
  /** Caps on money moved, per currency, never converted. */
  spend?: {
    perRun?: Money | Money[];
    /** All runs for the same `onBehalfOf` over a rolling period. */
    perPeriod?: (Money & { periodSeconds: number }) | (Money & { periodSeconds: number })[];
  };
  /** `<participant>#<operation>` → decision. Takes precedence over the class settings. */
  overrides?: Record<string, AutonomyDecision>;
  /** Who approves under `ask`. REQUIRED when any setting is `ask`. The run's principal is excluded. */
  approver?: string;
  /** Default `approve.agent-call`. */
  askAction?: string;
  /** Default 3600. */
  askDecideSeconds?: number;
}

/** Why the policy decided what it did, for the entry and for tests. */
export interface AutonomyVerdict {
  decision: AutonomyDecision;
  /** The undo class the decision came from, or `override`. */
  basis: "compensate" | "compensateViaUi" | "unknown" | "none" | "override";
  /** Set when the decision was raised to `ask`: the window, a cap, or an amount that can't be read. */
  raisedBy?: string;
  amount?: Money;
}

export type RunEvent =
  | { type: "reviewed"; by: string; at: string; prevHash: string }
  | { type: "reversal"; reversalId: string; recordDigest: string; outcomes: Record<string, "reversed" | "failed" | "skipped" | "unknown">; at: string; prevHash: string }
  | { type: "remedy"; txnId: string; remedies: string; at: string; prevHash: string };

export interface RunHeader {
  runId: string;
  agent: string;
  onBehalfOf?: string;
  purpose?: string;
  recorder: string;
  policyDigest?: string;
  startedAt: string;
}

export interface RunRecord extends RunHeader {
  type: "hatp.journal.run";
  hatp: "0.3";
  closedAt?: string;
  entries: JournalEntry[];
  events: RunEvent[];
  /** Money moved by this run's forwarded calls, per currency (J§7). */
  spend?: { perRun: Money[] };
  issuedAt: string;
  signature?: Signature;
}

/** `"sha256:" + base64url(SHA-256(JCS({ runId, entryId, tool, arguments })))` (J§5.2). */
export function callDigest(c: { runId: string; entryId: string; tool: string; arguments: Record<string, unknown> }): string {
  return hashObject({ runId: c.runId, entryId: c.entryId, tool: c.tool, arguments: c.arguments });
}

/** The digest the first item in a run's chain points back to: the header alone (J§6.2). */
export function runHeaderDigest(h: RunHeader): string {
  const { runId, agent, onBehalfOf, purpose, recorder, policyDigest, startedAt } = h;
  return hashObject({ type: "hatp.journal.run", hatp: "0.3", runId, agent, onBehalfOf, purpose, recorder, policyDigest, startedAt });
}

/** For a journal participant: the signed `execute` receipt it returns with a call's result (J§5.2). */
export function executeReceipt(signer: Signer, c: { runId: string; entryId: string; callDigest: string; outcome?: string; issuedAt?: string }): JournalReceipt {
  return signObject<JournalReceipt>({ type: "hatp.receipt", txnId: c.runId, branchId: c.entryId, callDigest: c.callDigest, phase: "execute", outcome: c.outcome ?? "done", issuedAt: c.issuedAt ?? new Date().toISOString(), issuer: signer.id }, signer);
}

/** Whether a key may sign for an issuer: key ids are namespaced `<issuer>#…`, as in the MCP binding (§9). */
const keyOwnedBy = (kid: string | undefined, issuer: string) => !!kid && kid.startsWith(`${issuer}#`);

export interface ReviewItem {
  entryId: string;
  tool: string;
  participant: string;
  summary?: string;
  undoBy?: string;
  /** For a reversible entry: seconds until its window closes, when the review was generated. */
  secondsLeft?: number;
  reason?: string;
}

/** A run's review (J§6.3): reversible entries by `undoBy`, earliest first, then closed and irreversible ones. */
export interface RunReview {
  runId: string;
  generatedAt: string;
  reviewed?: { by: string; at: string };
  reversible: ReviewItem[];
  closed: ReviewItem[];
  irreversible: ReviewItem[];
  unresolved: ReviewItem[];
  /** Calls the policy held and that never ran (J§7): what the agent tried. */
  notRun: ReviewItem[];
}

/** A reminder that an undo window will close soon, while the run is unreviewed (J§6.3). */
export interface Reminder {
  runId: string;
  /** `principal` at `remindBeforeSeconds`; `approver` too at `escalateBeforeSeconds`. */
  to: "principal" | "approver";
  onBehalfOf?: string;
  entries: ReviewItem[];
}

export interface RecorderOptions {
  id: string;
  signer: Signer;
  /** Looks up a tool server by the participant URI the agent calls. */
  servers: (id: string) => JournalServer | undefined;
  /** Participants' keys, to check their receipts when entries are recorded (J§6.1, intake check 3). */
  keyring?: KeyRing;
  /** Review timing (J§6.3). Without it, no reminders are sent. */
  review?: { remindBeforeSeconds: number; escalateBeforeSeconds?: number };
  onReminder?: (r: Reminder) => void;
  /** Keep call arguments in entries. Default true; `false` keeps only `callDigest` (J§6.1). */
  keepArguments?: boolean;
  /** Reversibility-gated autonomy (J§7). Without it, every call is forwarded. */
  autonomy?: {
    policy: AutonomyPolicy;
    /** The Human Gateway that approves single calls under `ask` (SEP §5). */
    gateway?: { askApprove(req: AskApproveRequest, ctx?: AskContext): Promise<AskApproveResult> };
  };
  /** Reversals (J§8). Without it, `reverse` answers NOT_SUPPORTED. */
  reversal?: {
    /** The Human Gateway that approves Reversal Plans. */
    gateway?: Participant;
    /** Who approves reversals, as a human:// address. */
    approver: string;
    /** Default `{ action: "approve.undo" }`. */
    requirement?: { action: string };
    /** How long approvers have. Default 3600. */
    decideSeconds?: number;
    /** Let the principal's own request stand as the approval when J§8.4 doesn't require one. Default false. */
    selfApprove?: boolean;
    /** Retries for a compensation that gets no answer, before its outcome is reported unknown. Default 2. */
    retries?: number;
    /** Milliseconds before the first retry, doubling each time. Default 200. */
    retryMs?: number;
  };
  now?: () => number;
}

interface RunState {
  header: RunHeader;
  closedAt?: string;
  entries: JournalEntry[];
  events: RunEvent[];
  last: string;
  /** Calls in one run are recorded one after another, so `seq` and the chain follow the order of the calls. */
  queue: Promise<unknown>;
  reviewedAt?: number;
  timers: LongTimer[];
  /** Entries a reversal has already taken back: they can't be reversed twice. */
  reversed: Set<string>;
  /** Money this run's forwarded calls moved, per currency. */
  spent: Map<string, number>;
}

export function createRecorder(opts: RecorderOptions) {
  const now = opts.now ?? Date.now;
  const iso = (t = now()) => new Date(t).toISOString();
  const runs = new Map<string, RunState>();

  // Autonomy (J§7): fixed now, so nothing an agent sends can change it.
  const policy = opts.autonomy?.policy;
  const policyDigest = policy ? hashObject(policy) : undefined;
  const setting = (k: "compensate" | "compensateViaUi" | "unknown" | "none"): AutonomyDecision =>
    policy?.[k] ?? (k === "compensate" ? "allow" : "ask");
  if (policy) {
    const all = [setting("compensate"), setting("compensateViaUi"), setting("unknown"), setting("none"), ...Object.values(policy.overrides ?? {})];
    for (const d of all) if (d !== "allow" && d !== "ask" && d !== "block") throw new HatpError("PLAN_INVALID", `autonomy setting ${String(d)} is not allow, ask or block`);
    if (all.includes("ask") && (!policy.approver || !opts.autonomy?.gateway)) throw new HatpError("PLAN_INVALID", "an autonomy policy that can ask needs an approver and a gateway");
  }
  const list = <T,>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
  const perRunCaps = list(policy?.spend?.perRun);
  const perPeriodCaps = list(policy?.spend?.perPeriod);
  const ledger: { onBehalfOf?: string; at: number; currency: string; value: number }[] = []; // every forwarded money-moving call
  const unversioned = new Set<string>(); // operations that returned a compensate entry without effect.version

  const pointer = (args: Record<string, unknown>, at: string): Money | undefined => {
    const v = at.split("/").slice(1).reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), args);
    const m = v as Money | undefined;
    return m && typeof m.value === "number" && Number.isFinite(m.value) && m.value >= 0 && typeof m.currency === "string" ? { value: m.value, currency: m.currency } : undefined;
  };

  /** The policy's verdict on one call (J§7), before it is forwarded. */
  function classify(run: RunState, server: JournalServer, c: { participant: string; tool: string; arguments: Record<string, unknown> }): AutonomyVerdict {
    const key = `${c.participant}#${c.tool}`;
    const decl = server.undo?.[c.tool];
    let v: AutonomyVerdict;
    const override = policy?.overrides?.[key];
    if (override) v = { decision: override, basis: "override" };
    else if (!decl || undoProblem(decl) || unversioned.has(key)) v = { decision: setting("unknown"), basis: "unknown" };
    else if (decl.kind === "none") v = { decision: setting("none"), basis: "none" };
    else if (decl.via === "ui") v = { decision: setting("compensateViaUi"), basis: "compensateViaUi" };
    else {
      v = { decision: setting("compensate"), basis: "compensate" };
      if (v.decision === "allow" && policy?.minWindowSeconds !== undefined && (decl.windowSeconds ?? 0) < policy.minWindowSeconds) {
        v = { ...v, decision: "ask", raisedBy: `undo window ${decl.windowSeconds}s is shorter than ${policy.minWindowSeconds}s` };
      }
    }
    // Spending caps: a standing approval keeps a running total (SEP §6.1). Only ever raises allow to ask.
    const from = server.amountFrom?.[c.tool];
    if (!from) return v;
    const amount = pointer(c.arguments, from);
    v.amount = amount;
    if (v.decision !== "allow") return v;
    const raise = (why: string) => ({ ...v, decision: "ask" as const, raisedBy: why });
    if (!amount) return raise(`no amount at ${from}`);
    const caps = [...perRunCaps, ...perPeriodCaps];
    if (caps.length && !caps.some((cap) => cap.currency === amount.currency)) return raise(`no cap for ${amount.currency}`);
    for (const cap of perRunCaps.filter((x) => x.currency === amount.currency)) {
      const so = run.spent.get(amount.currency) ?? 0;
      if (so + amount.value > cap.value) return raise(`run total ${so + amount.value} ${amount.currency} would pass the cap of ${cap.value}`);
    }
    for (const cap of perPeriodCaps.filter((x) => x.currency === amount.currency)) {
      const since = now() - cap.periodSeconds * 1000;
      const so = ledger.filter((l) => l.onBehalfOf === run.header.onBehalfOf && l.currency === amount.currency && l.at > since).reduce((a, l) => a + l.value, 0);
      if (so + amount.value > cap.value) return raise(`${cap.periodSeconds}s total ${so + amount.value} ${amount.currency} would pass the cap of ${cap.value}`);
    }
    return v;
  }

  const runOf = (runId: string) => {
    const r = runs.get(runId);
    if (!r) throw new HatpError("RUN_UNKNOWN", `no run ${runId}`);
    return r;
  };

  const append = <T extends JournalEntry | RunEvent>(run: RunState, item: T): T => {
    run.last = hashObject(item);
    return item;
  };

  const itemOf = (e: JournalEntry): ReviewItem => ({ entryId: e.entryId, tool: e.tool, participant: e.participant, summary: e.effect?.summary, undoBy: e.undo?.undoBy });

  const remind = (run: RunState, e: JournalEntry) => {
    const review = opts.review;
    if (!review || !opts.onReminder || e.undo?.kind !== "compensate" || !e.undo.undoBy || e.intake) return;
    const end = Date.parse(e.undo.undoBy);
    const recordedAt = Date.parse(e.recordedAt);
    const fire = (to: Reminder["to"]) => () => {
      // An acknowledgement after this entry was recorded covers it.
      if (run.reviewedAt !== undefined && run.reviewedAt >= recordedAt) return;
      if (now() >= end) return;
      opts.onReminder!({ runId: run.header.runId, to, onBehalfOf: run.header.onBehalfOf, entries: [{ ...itemOf(e), secondsLeft: Math.round((end - now()) / 1000) }] });
    };
    run.timers.push(setLongTimeout(fire("principal"), end - review.remindBeforeSeconds * 1000 - now(), { unref: true }));
    if (review.escalateBeforeSeconds !== undefined) run.timers.push(setLongTimeout(fire("approver"), end - review.escalateBeforeSeconds * 1000 - now(), { unref: true }));
  };

  async function record(run: RunState, c: { participant: string; tool: string; arguments: Record<string, unknown>; uses?: string[]; purpose?: string }) {
    if (run.closedAt) throw new HatpError("INVALID_STATE", `run ${run.header.runId} is closed`);
    const server = opts.servers(c.participant);
    if (!server) throw new HatpError("PLAN_INVALID", `unknown participant ${c.participant}`);
    const { runId } = run.header;
    const seq = run.entries.length + 1;
    const entryId = `e${seq}`;
    const digest = callDigest({ runId, entryId, tool: c.tool, arguments: c.arguments });
    const problems: string[] = [];

    // Autonomy (J§7): allow, ask for this exact call, or block. A call that doesn't run is still journaled.
    let approvals: ActionApproval[] | undefined;
    let verdict: AutonomyVerdict | undefined;
    if (policy) {
      verdict = classify(run, server, c);
      const refuse = (reason: string, err: HatpError) => {
        const entry = append(run, {
          type: "hatp.journal.entry", runId, entryId, seq, agent: run.header.agent, onBehalfOf: run.header.onBehalfOf,
          participant: c.participant, tool: c.tool, callDigest: digest, arguments: opts.keepArguments === false ? undefined : c.arguments,
          outcome: "not-run", reason, dependsOn: [], recordedAt: iso(), prevHash: run.last,
        } satisfies JournalEntry);
        run.entries.push(entry);
        throw Object.assign(err, { entry });
      };
      if (verdict.decision === "block") refuse(`blocked by policy (${verdict.basis})`, new HatpError("UNDO_POLICY_BLOCKED", `${c.tool} on ${c.participant} is blocked by policy`));
      if (verdict.decision === "ask") {
        const action = { type: "mcp.tools/call" as const, server: c.participant, tool: c.tool, arguments: c.arguments };
        const from = server.amountFrom?.[c.tool];
        const why = verdict.raisedBy ? `${verdict.basis}; ${verdict.raisedBy}` : verdict.basis;
        try {
          const r = await opts.autonomy!.gateway!.askApprove(
            { address: policy.approver!, requirement: { action: policy.askAction ?? "approve.agent-call", ...(from ? { amountFrom: from } : {}) }, action, actionDigest: actionDigest(action), decideBy: iso(now() + (policy.askDecideSeconds ?? 3600) * 1000), purpose: c.purpose },
            { principal: run.header.onBehalfOf },
          );
          if (r.decision !== "approve") refuse(`rejected by ${r.approvals.map((a) => a.approver).join(", ") || "the approver"} (asked: ${why})`, new HatpError("APPROVAL_REQUIRED", `${c.tool} needs an approval and it was rejected`));
          approvals = r.approvals;
        } catch (e) {
          if ((e as { entry?: unknown }).entry) throw e;
          const code = e instanceof HatpError ? e.code : "INVALID_STATE";
          refuse(`not approved: ${code} (asked: ${why})`, e instanceof HatpError ? e : new HatpError("INVALID_STATE", String((e as Error)?.message ?? e)));
        }
      }
    }

    let result: unknown;
    let journal: JournalResult | undefined;
    let failure: unknown;
    if (verdict?.amount) {
      // Counted when forwarded, whatever happens next: the cap bounds what was moved (J§7).
      run.spent.set(verdict.amount.currency, (run.spent.get(verdict.amount.currency) ?? 0) + verdict.amount.value);
      ledger.push({ onBehalfOf: run.header.onBehalfOf, at: now(), currency: verdict.amount.currency, value: verdict.amount.value });
    }
    try {
      ({ result, journal } = await server.call({ tool: c.tool, arguments: c.arguments, journal: { runId, entryId, seq, recorder: opts.id }, approvals }));
    } catch (e) {
      failure = e;
      // Whether it took effect can't be known (#113): recorded as unknown, never as reversible.
      problems.push(`call failed: ${(e as Error)?.message ?? String(e)}; whether it took effect is unknown`);
    }

    // The participant's word counts only for an operation it declared, with a valid declaration (J§4).
    const declared = server.undo?.[c.tool];
    const declarationOk = declared !== undefined && !undoProblem(declared);
    if (journal && server.undo && !declared) problems.push(`${c.tool} has no undo declaration`);
    else if (journal && declared && !declarationOk) problems.push(`${c.tool}'s undo declaration is invalid: ${undoProblem(declared)}`);
    const trusted = !failure && journal && declarationOk ? journal : undefined;
    if (trusted && trusted.entryId !== entryId) problems.push(`result is for entry ${trusted.entryId}, not ${entryId}`);

    let undo: EntryUndo;
    let receipt: JournalReceipt | undefined = trusted?.receipt;
    if (trusted) {
      undo = { kind: trusted.undo.kind, undoBy: trusted.undo.undoBy, via: declared!.via };
      // A call can't be more reversible than its operation declares.
      if (declared!.kind === "none" && trusted.undo.kind !== "none") {
        problems.push(`${c.tool} is declared none but returned ${trusted.undo.kind}`);
        undo = { kind: "none" };
      }
    } else {
      undo = { kind: "unknown" };
    }
    if (!receipt) {
      // A server without the journal gets the Recorder's own receipt (J§5.3): it vouches that the call was made, nothing more.
      receipt = signObject<JournalReceipt>({ type: "hatp.receipt", txnId: runId, branchId: entryId, callDigest: digest, phase: "execute", outcome: failure ? "failed" : "done", issuedAt: iso(), issuer: opts.id }, opts.signer);
    }

    // dependsOn (J§6.1): declared from effect.uses, then host links, else every earlier entry.
    const effect = trusted?.effect;
    const links: DependencyLink[] = [];
    if (effect?.uses) {
      for (const prev of run.entries) if (prev.effect?.resource && effect.uses.includes(prev.effect.resource)) links.push({ entryId: prev.entryId, source: "declared" });
    }
    for (const id of c.uses ?? []) if (!links.some((l) => l.entryId === id)) links.push({ entryId: id, source: "host" });
    if (!effect?.uses && !c.uses) for (const prev of run.entries) if (prev.outcome !== "not-run") links.push({ entryId: prev.entryId, source: "default" });

    // Intake checks (J§6.1): resolved now, not at reversal time. A failing entry is recorded, never dropped.
    for (const l of links) {
      const target = run.entries.find((p) => p.entryId === l.entryId);
      if (!target) problems.push(`dependsOn ${l.entryId}: no such earlier entry`);
    }
    if (undo.kind === "compensate") {
      if (!trusted?.compensationToken) problems.push("compensate entry has no compensationToken");
      if (!undo.undoBy || !(Date.parse(undo.undoBy) > now())) problems.push("compensate entry has no undoBy in the future");
    }
    if (trusted?.receipt) {
      const r = trusted.receipt;
      if (r.issuer !== c.participant) problems.push(`receipt is issued by ${r.issuer}, not ${c.participant}`);
      else if (!keyOwnedBy(r.signature?.kid, r.issuer) || !opts.keyring?.verify(r)) problems.push("participant receipt does not verify");
      if (r.callDigest !== digest) problems.push("receipt callDigest does not match the call");
      if (r.phase !== "execute") problems.push(`receipt phase is ${r.phase}, not execute`);
    }

    const entry = append(run, {
      type: "hatp.journal.entry", runId, entryId, seq, agent: run.header.agent, onBehalfOf: run.header.onBehalfOf,
      participant: c.participant, tool: c.tool, callDigest: digest, arguments: opts.keepArguments === false ? undefined : c.arguments,
      dependsOn: links, undo, compensationToken: undo.kind === "compensate" ? trusted?.compensationToken : undefined, effect, receipt, approvals,
      intake: problems.length ? { unresolved: true as const, problems } : undefined,
      recordedAt: iso(), prevHash: run.last,
    } satisfies JournalEntry);
    run.entries.push(entry);
    if (undo.kind === "compensate" && !effect?.version) unversioned.add(`${c.participant}#${c.tool}`);
    remind(run, entry);
    if (failure) throw failure;
    return { result, entry };
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const isHuman = (id: string) => id.startsWith("human://");

  async function reverse(run: RunState, req: ReverseRequest): Promise<ReverseResult> {
    const policy = opts.reversal;
    if (!policy) throw new HatpError("NOT_SUPPORTED", "this Recorder was built without reversal");
    await run.queue; // calls still being recorded are part of the run
    const { runId } = run.header;
    const byId = new Map(run.entries.map((e) => [e.entryId, e]));
    const requested = "from" in req.scope ? run.entries.filter((e) => e.seq >= (req.scope as { from: number }).from).map((e) => e.entryId) : req.scope.entries;
    for (const id of requested) if (!byId.has(id)) throw new HatpError("PLAN_INVALID", `no entry ${id} in ${runId}`);
    if (!requested.length) throw new HatpError("PLAN_INVALID", "the scope names no entries");

    // 1–2. The reversal set: what was asked for, plus every later entry that depends on it, transitively (J§8.2).
    const set = new Set(requested);
    for (const e of run.entries) if (e.dependsOn.some((l) => set.has(l.entryId))) set.add(e.entryId);
    const inSet = run.entries.filter((e) => set.has(e.entryId));

    // 3. Reversible, irreversible, unresolved. Nothing that depends on an unresolved entry is compensated.
    const notReversible: NonNullable<ReversalPlan["notReversible"]> = [];
    const unresolved: NonNullable<ReversalPlan["unresolved"]> = [];
    const held = new Set<string>();
    const candidates: JournalEntry[] = [];
    for (const e of inSet) {
      if (e.outcome === "not-run") continue; // it never ran: there is nothing to take back
      const summary = e.effect?.summary ?? `${e.tool} on ${e.participant}`;
      const blockedBy = e.dependsOn.find((l) => held.has(l.entryId));
      if (e.intake) { unresolved.push({ entryId: e.entryId, problems: e.intake.problems, summary }); held.add(e.entryId); }
      else if (run.reversed.has(e.entryId)) notReversible.push({ entryId: e.entryId, reason: "already reversed", summary });
      else if (blockedBy) { notReversible.push({ entryId: e.entryId, reason: `depends on unresolved ${blockedBy.entryId}`, summary }); held.add(e.entryId); }
      else if (e.undo?.kind === "unknown") notReversible.push({ entryId: e.entryId, reason: "unknown: the server does not journal this call", summary });
      else if (e.undo?.kind !== "compensate") notReversible.push({ entryId: e.entryId, reason: opts.servers(e.participant)?.undo?.[e.tool]?.reason ?? "declared irreversible", summary });
      else if (!e.undo.undoBy || Date.parse(e.undo.undoBy) <= now()) notReversible.push({ entryId: e.entryId, reason: "window closed", summary });
      else candidates.push(e);
    }

    // 4. Check each candidate (J§8.3), without changing anything. Conflicts and unversioned entries need `force`.
    const forced = new Set(req.force ?? []);
    const receipts: Receipt[] = [];
    const branches: ReversalBranch[] = [];
    for (const e of [...candidates].reverse()) {
      const server = opts.servers(e.participant);
      const summary = e.effect!.summary;
      const version = e.effect?.version;
      let force = false;
      let sideEffects = opts.servers(e.participant)?.undo?.[e.tool]?.sideEffects;
      let cost = opts.servers(e.participant)?.undo?.[e.tool]?.cost;
      if (!server?.compensate) { notReversible.push({ entryId: e.entryId, reason: "the server can't compensate", summary }); continue; }
      if (server.check) {
        let c: JournalCheckResult;
        try {
          c = await server.check({ runId, entryId: e.entryId, compensationToken: e.compensationToken!, ifVersion: version });
        } catch (err) {
          notReversible.push({ entryId: e.entryId, reason: `check failed: ${(err as Error).message}`, summary });
          continue;
        }
        receipts.push(c.receipt as unknown as Receipt);
        if (c.sideEffects) sideEffects = c.sideEffects;
        if (c.cost) cost = c.cost;
        if (c.conflict) {
          if (!forced.has(e.entryId)) { notReversible.push({ entryId: e.entryId, reason: `conflict: ${c.conflict.summary}`, summary }); continue; }
          force = true;
        } else if (!c.undoable) { notReversible.push({ entryId: e.entryId, reason: c.remedy ? `not undoable; remedy: ${c.remedy}` : "not undoable", summary }); continue; }
      }
      if (!version) {
        if (!forced.has(e.entryId)) { notReversible.push({ entryId: e.entryId, reason: "unversioned: newer changes could not be detected", summary }); continue; }
        force = true;
      }
      branches.push({
        branchId: `undo-${e.entryId}`, participant: e.participant, tier: "compensate",
        operation: force ? { undo: e.entryId, force: true } : { undo: e.entryId, ifVersion: version },
        effect: `Undo: ${summary}`, sideEffects: sideEffects?.length ? sideEffects : undefined, cost: cost ?? undefined, via: e.undo?.via,
      });
    }
    const order = (id: string) => byId.get(id)!.seq;
    notReversible.sort((a, b) => order(a.entryId) - order(b.entryId));
    if (!branches.length) return { state: "NOTHING_TO_REVERSE", notReversible, unresolved };

    // 5. Readers since (J§8.2, step 4): calls in other runs that used a value this reversal changes. Nothing is undone there.
    const readSince: NonNullable<ReversalPlan["readSince"]> = [];
    for (const b of branches) {
      const target = byId.get(b.operation.undo)!;
      const resource = target.effect?.resource;
      if (!resource) continue;
      for (const other of runs.values()) {
        if (other === run) continue;
        for (const e of other.entries) {
          if (Date.parse(e.recordedAt) < Date.parse(target.recordedAt)) continue;
          const source = e.effect?.uses?.includes(resource) ? "declared" : JSON.stringify(e.arguments ?? {}).includes(JSON.stringify(resource)) ? "inferred" : undefined;
          if (source) readSince.push({ runId: other.header.runId, entryId: e.entryId, agent: e.agent, source, summary: e.effect?.summary });
        }
      }
    }

    // 6. The Reversal Plan (J§8.4). Whoever asks never approves: they are its onBehalfOf.
    const reversalId = `rev_${newTxnId().slice(4)}`;
    const decideBy = now() + (policy.decideSeconds ?? 3600) * 1000;
    const plan: ReversalPlan = {
      hatp: "0.3", txnId: reversalId, reversalOf: runId, initiator: opts.id,
      onBehalfOf: isHuman(req.requestedBy) ? req.requestedBy : undefined, requestedBy: req.requestedBy, purpose: req.reason,
      deadline: iso(decideBy + 15 * 60_000), branches,
      notReversible: notReversible.length ? notReversible : undefined, unresolved: unresolved.length ? unresolved : undefined, readSince: readSince.length ? readSince : undefined,
      approvals: [{ groupId: "undo", address: policy.approver, quorum: { required: 1 }, requirement: policy.requirement ?? { action: "approve.undo" }, decideBy: iso(decideBy) }],
    };
    const planDigest = hashObject(plan);

    // The Reversal Record: its own event chain, as a Transaction Record's (§8.5).
    const events: TxnEvent[] = [];
    let prev = "sha256:genesis";
    const emit = (type: string, data: Record<string, unknown> = {}) => {
      const e: TxnEvent = { seq: events.length, at: iso(), type, data, prevHash: prev };
      prev = hashObject(e);
      events.push(e);
    };
    emit("begin", { planDigest, plan, reversalOf: runId, requestedBy: req.requestedBy });
    const approvals: Approval[] = [];
    const branchState: Record<string, BranchState> = Object.fromEntries(branches.map((b) => [b.branchId, "ENLISTED" as BranchState]));
    const outcomes: Record<string, ReversalOutcome> = {};

    // 7. Approval, unless J§8.4 lets the principal's own request stand and the policy allows it.
    const required = branches.some((b) => b.sideEffects?.length || b.cost || b.operation.force || b.via === "ui") || notReversible.length > 0 || unresolved.length > 0 || req.requestedBy !== run.header.onBehalfOf;
    let approved: boolean;
    if (!required && policy.selfApprove) {
      emit("approved-by-request", { by: req.requestedBy });
      approved = true;
    } else {
      if (!policy.gateway) throw new HatpError("NOT_SUPPORTED", "this reversal needs an approval and the Recorder has no gateway");
      const prepare = { txnId: reversalId, branchId: "approval:undo", planDigest, plan: plan as never, leaseSeconds: Math.ceil((decideBy - now()) / 1000) };
      let vote = await policy.gateway.prepare(prepare);
      while (vote.vote === "pending" && policy.gateway.status) {
        await sleep((vote.pollAfterSeconds ?? 30) * 1000);
        if (now() > decideBy) break;
        vote = await policy.gateway.status({ txnId: reversalId, branchId: "approval:undo", planDigest });
      }
      if (vote.receipt) receipts.push(vote.receipt);
      approvals.push(...(vote.approvals ?? []));
      approved = vote.vote === "yes";
      emit("voted", { branchId: "approval:undo", vote: vote.vote, reason: vote.reason });
    }
    const decision = signObject<Decision>({ type: "hatp.decision", txnId: reversalId, planDigest, decision: approved ? "commit" : "abort", decidedAt: iso(), issuer: opts.id }, opts.signer);
    emit("decision", { decision: decision.decision });

    // 8. Compensate in plan order, latest entry first (J§8.5). A failed entry keeps what it depends on live.
    let state: TxnState = "ABORTED";
    if (approved) {
      const blocked = new Map<string, string>();
      const blockDeps = (id: string) => {
        const stack = [id];
        while (stack.length) {
          for (const l of byId.get(stack.pop()!)!.dependsOn) if (!blocked.has(l.entryId)) { blocked.set(l.entryId, id); stack.push(l.entryId); }
        }
      };
      for (const b of branches) {
        const entry = byId.get(b.operation.undo)!;
        if (blocked.has(entry.entryId)) {
          outcomes[entry.entryId] = "skipped";
          branchState[b.branchId] = "ABORTED";
          emit("skipped", { branchId: b.branchId, entryId: entry.entryId, blockedBy: blocked.get(entry.entryId) });
          continue;
        }
        const server = opts.servers(entry.participant)!;
        const call: JournalCompensateRequest = { txnId: runId, branchId: entry.entryId, planDigest, compensationToken: entry.compensationToken!, ...(b.operation.force ? { force: true as const } : { ifVersion: b.operation.ifVersion }) };
        let outcome: ReversalOutcome | undefined;
        for (let attempt = 0; outcome === undefined; attempt++) {
          try {
            const { receipt } = await server.compensate!(call);
            receipts.push(receipt);
            outcome = "reversed";
            emit("compensated", { branchId: b.branchId, entryId: entry.entryId, effect: receipt.detail?.effect });
          } catch (err) {
            if (err instanceof HatpError) {
              outcome = "failed";
              emit("compensation-failed", { branchId: b.branchId, entryId: entry.entryId, code: err.code, message: err.message });
            } else if (attempt >= (policy.retries ?? 2)) {
              // No answer: compensate is idempotent, but it may or may not have happened (J§8.5).
              outcome = "unknown";
              emit("compensation-unknown", { branchId: b.branchId, entryId: entry.entryId, message: (err as Error)?.message ?? String(err) });
            } else await sleep((policy.retryMs ?? 200) * 2 ** attempt);
          }
        }
        outcomes[entry.entryId] = outcome;
        branchState[b.branchId] = outcome === "reversed" ? "COMPENSATED" : outcome === "unknown" ? "IN_DOUBT" : "FAILED";
        if (outcome === "reversed") run.reversed.add(entry.entryId);
        else blockDeps(entry.entryId);
      }
      state = Object.values(outcomes).every((o) => o === "reversed") ? "COMMITTED" : "NEEDS_ATTENTION";
    }
    emit("end", { state, outcomes });
    const record = signObject<ReversalRecord>({ type: "hatp.record", plan, planDigest, state, branches: branchState, approvals, receipts, decision, events, issuer: opts.id }, opts.signer);

    // 9. The run's chain gets a reference to the record and each entry's outcome. Nothing in the run is edited.
    const event = append(run, { type: "reversal" as const, reversalId, recordDigest: hashObject(record), outcomes, at: iso(), prevHash: run.last });
    run.events.push(event);
    return { state, reversalId, plan, planDigest, outcomes, record };
  }

  function signed(run: RunState): RunRecord {
    return signObject<RunRecord>({ type: "hatp.journal.run", hatp: "0.3", ...run.header, closedAt: run.closedAt, entries: run.entries, events: run.events, spend: run.spent.size ? { perRun: [...run.spent].map(([currency, value]) => ({ value, currency })) } : undefined, issuedAt: iso() }, opts.signer);
  }

  return {
    id: opts.id,

    /** Opens a run for one agent and principal. The Recorder, not the agent, chooses the runId. */
    startRun(h: { agent: string; onBehalfOf?: string; purpose?: string; policyDigest?: string }): string {
      const runId = `run_${newTxnId().slice(4)}`;
      const header: RunHeader = { runId, agent: h.agent, onBehalfOf: h.onBehalfOf, purpose: h.purpose, recorder: opts.id, policyDigest: policyDigest ?? h.policyDigest, startedAt: iso() };
      runs.set(runId, { header, entries: [], events: [], last: runHeaderDigest(header), queue: Promise.resolve(), timers: [], reversed: new Set(), spent: new Map() });
      return runId;
    },

    /**
     * Forwards one tool call with journal context and records it (J§5). `uses` names earlier entries the host
     * knows this call relied on (`host` links). The agent gets the tool's result, or its error.
     */
    call(runId: string, c: { participant: string; tool: string; arguments: Record<string, unknown>; uses?: string[]; purpose?: string }): Promise<{ result: unknown; entry: JournalEntry }> {
      const run = runOf(runId);
      const next = run.queue.then(() => record(run, c));
      run.queue = next.catch(() => {});
      return next;
    },

    /** Records that the principal or an approver looked at the run (J§6.3). It approves nothing and closes no window. */
    acknowledge(runId: string, by: string): RunEvent {
      const run = runOf(runId);
      const at = now();
      run.reviewedAt = at;
      const event = append(run, { type: "reviewed" as const, by, at: iso(at), prevHash: run.last });
      run.events.push(event);
      return event;
    },

    /** Closes the run once its calls have been recorded, and returns the signed Run Record (J§6.2). */
    async closeRun(runId: string): Promise<RunRecord> {
      const run = runOf(runId);
      await run.queue;
      run.closedAt ??= iso();
      return signed(run);
    },

    /** The current signed Run Record (`hatp/journal/get`, J§10.1). */
    get(runId: string): RunRecord {
      return signed(runOf(runId));
    },

    /** The review as of now (J§6.3): what can still be reversed and until when, earliest window first. */
    review(runId: string): RunReview {
      const run = runOf(runId);
      const t = now();
      const out: RunReview = { runId, generatedAt: iso(t), reversible: [], closed: [], irreversible: [], unresolved: [], notRun: [] };
      const ack = [...run.events].reverse().find((e) => e.type === "reviewed");
      if (ack?.type === "reviewed") out.reviewed = { by: ack.by, at: ack.at };
      for (const e of run.entries) {
        const item = itemOf(e);
        if (e.outcome === "not-run") out.notRun.push({ ...item, reason: e.reason });
        else if (e.intake) out.unresolved.push({ ...item, reason: e.intake.problems.join("; ") });
        else if (run.reversed.has(e.entryId)) out.closed.push({ ...item, reason: "reversed" });
        else if (e.undo?.kind === "compensate" && e.undo.undoBy) {
          const left = Date.parse(e.undo.undoBy) - t;
          if (left > 0) out.reversible.push({ ...item, secondsLeft: Math.round(left / 1000) });
          else out.closed.push(item);
        } else out.irreversible.push({ ...item, reason: e.undo?.kind === "unknown" ? "the server does not journal this call" : "declared irreversible" });
      }
      out.reversible.sort((a, b) => Date.parse(a.undoBy!) - Date.parse(b.undoBy!));
      return out;
    },

    /**
     * Reverses part of a run (J§8): expands the request with dependent entries, checks each, builds a Reversal
     * Plan, has it approved through the Human Gateway, compensates latest first, and returns the signed
     * Reversal Record. `verifyRecord` checks that record offline.
     */
    reverse(runId: string, req: ReverseRequest): Promise<ReverseResult> {
      return reverse(runOf(runId), req);
    },

    /** Stops the reminder timers of every run, for a Recorder that is shutting down. */
    stop(): void {
      for (const r of runs.values()) r.timers.forEach((t) => t.clear());
    },
  };
}

export type Recorder = ReturnType<typeof createRecorder>;

/**
 * Offline check of a Run Record (J§6.2): the Recorder's signature, gap-free `seq`, one unbroken hash chain over
 * entries and events, call digests, participant receipts, and dependency links. `keyring` holds participants'
 * keys; without a key, an entry's receipt can't be checked and is reported.
 */
export function verifyRunRecord(record: RunRecord, o: { recorderKeys: Jwk[]; keyring?: KeyRing }): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (record.type !== "hatp.journal.run" || record.hatp !== "0.3") problems.push("not a 0.3 Run Record");
  const recorderKey = o.recorderKeys.find((k) => k.kid === record.signature?.kid);
  if (!recorderKey || !keyOwnedBy(recorderKey.kid, record.recorder) || !verifyObject(record, recorderKey)) problems.push("the Recorder's signature does not verify");

  // 1. Gap-free seq, entries in order and in this run.
  record.entries.forEach((e, i) => {
    if (e.seq !== i + 1) problems.push(`entry ${e.entryId}: seq ${e.seq}, expected ${i + 1}`);
    if (e.runId !== record.runId) problems.push(`entry ${e.entryId} belongs to run ${e.runId}`);
  });

  // 2. One chain from the header through every entry and event, each pointing at the item recorded before it.
  const items: (JournalEntry | RunEvent)[] = [...record.entries, ...record.events];
  const byPrev = new Map<string, (JournalEntry | RunEvent)[]>();
  for (const it of items) byPrev.set(it.prevHash, [...(byPrev.get(it.prevHash) ?? []), it]);
  let at = runHeaderDigest(record);
  const walked: (JournalEntry | RunEvent)[] = [];
  for (;;) {
    const next = byPrev.get(at) ?? [];
    if (next.length > 1) { problems.push("the hash chain forks"); break; }
    if (!next.length) break;
    walked.push(next[0]);
    at = hashObject(next[0]);
  }
  if (walked.length !== items.length) problems.push(`the hash chain covers ${walked.length} of ${items.length} items: something was removed, changed or reordered`);
  const chainedEntries = walked.filter((x): x is JournalEntry => (x as JournalEntry).type === "hatp.journal.entry");
  if (chainedEntries.some((e, i) => e.seq !== i + 1)) problems.push("entries are chained out of seq order");

  // 3. Each entry: its call digest, its receipt, its links.
  const seen = new Set<string>();
  for (const e of record.entries) {
    if (e.arguments && callDigest({ runId: e.runId, entryId: e.entryId, tool: e.tool, arguments: e.arguments }) !== e.callDigest) problems.push(`entry ${e.entryId}: arguments don't match callDigest`);
    const r = e.receipt;
    if (e.outcome === "not-run") {
      // Held by the policy: it never reached a participant, so it may carry nothing that claims it ran.
      if (r || e.undo || e.compensationToken || e.effect) problems.push(`entry ${e.entryId}: not-run, but carries a receipt or undo information`);
      if (!e.reason) problems.push(`entry ${e.entryId}: not-run without a reason`);
      seen.add(e.entryId);
      continue;
    }
    if (!r) problems.push(`entry ${e.entryId}: no receipt`);
    else {
      if (r.callDigest !== e.callDigest || r.txnId !== e.runId || r.branchId !== e.entryId) problems.push(`entry ${e.entryId}: receipt is for another call`);
      if (r.issuer === record.recorder) {
        if (!recorderKey || !verifyObject(r, recorderKey)) problems.push(`entry ${e.entryId}: the Recorder's receipt does not verify`);
        // The Recorder can vouch that a call was made, never for how it can be undone.
        if (e.undo?.kind !== "unknown") problems.push(`entry ${e.entryId}: undo ${e.undo?.kind} needs the participant's receipt`);
      } else if (r.issuer !== e.participant) problems.push(`entry ${e.entryId}: receipt issued by ${r.issuer}, not ${e.participant}`);
      else if (!o.keyring) problems.push(`entry ${e.entryId}: no keyring to check ${e.participant}'s receipt`);
      else if (!keyOwnedBy(r.signature?.kid, r.issuer) || !o.keyring.verify(r)) problems.push(`entry ${e.entryId}: participant receipt does not verify`);
    }
    if (!e.intake) for (const l of e.dependsOn) if (!seen.has(l.entryId)) problems.push(`entry ${e.entryId}: depends on ${l.entryId}, which is not an earlier entry`);
    seen.add(e.entryId);
  }
  return { ok: problems.length === 0, problems };
}
