// The Journal's Recorder (spec/hatp-journal.md J§5–J§6): journals an agent's direct tool calls with their undo
// information, keeps every entry and event in one hash chain, signs the Run Record, and reminds the principal
// before undo windows close. Reversal (J§8) and the autonomy policy (J§7) build on this. Calls that never answer
// are recorded in doubt (J§5.4), and a durable log lets a restarted Recorder resume (J§6.4).
import { appendFileSync, readFileSync } from "node:fs";
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
  /** `done` (default), `not-run` (held by the policy, or refused by the participant), or `in-doubt` (no answer, J§5.4). */
  outcome?: "done" | "not-run" | "in-doubt";
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
  | { type: "remedy"; txnId: string; remedies: string; at: string; prevHash: string }
  | ResolvedEvent;

/**
 * How an in-doubt entry turned out, once a retry got the participant's result (J§5.4). The entry itself is never
 * edited: this event carries what the participant returned, and readers apply it to the entry.
 */
export interface ResolvedEvent {
  type: "resolved";
  entryId: string;
  /** Only an answer with a result resolves an entry: a refusal after a call that got no answer proves nothing. */
  outcome: "done";
  undo: EntryUndo;
  compensationToken?: string;
  effect?: Effect;
  receipt?: JournalReceipt;
  intake?: { unresolved: true; problems: string[] };
  at: string;
  prevHash: string;
}

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
  /** Calls that got no answer (J§5.4): they may or may not have taken effect. */
  inDoubt: ReviewItem[];
}

/** A reminder that an undo window will close soon, while the run is unreviewed (J§6.3). */
export interface Reminder {
  runId: string;
  /** `principal` at `remindBeforeSeconds`; `approver` too at `escalateBeforeSeconds`. */
  to: "principal" | "approver";
  onBehalfOf?: string;
  entries: ReviewItem[];
}

/** A call the Recorder is about to forward, logged first so a restarted Recorder knows it may have run (J§6.4). */
export interface CallIntent {
  runId: string;
  entryId: string;
  seq: number;
  participant: string;
  tool: string;
  /** Kept in the log even when entries omit them: a retry has to send the same call. */
  arguments: Record<string, unknown>;
  callDigest: string;
  approvals?: ActionApproval[];
  /** What the spending caps counted for this call (J§7). */
  amount?: Money;
  at: string;
}

/** An approved (or declined) reversal, logged before its first compensation so a restart can finish it (J§8.5). */
export interface ReversalProgress {
  reversalId: string;
  plan: ReversalPlan;
  planDigest: string;
  approved: boolean;
  approvals: Approval[];
  receipts: Receipt[];
  decision: Decision;
  /** The Reversal Record's events so far, up to the decision. */
  events: TxnEvent[];
}

/** One line of the Recorder's log (J§6.4). */
export type RecorderLogItem =
  | { kind: "run"; header: RunHeader }
  | { kind: "intent"; intent: CallIntent }
  | { kind: "item"; runId: string; item: JournalEntry | RunEvent }
  | { kind: "closed"; runId: string; at: string }
  | { kind: "reversal"; runId: string; progress: ReversalProgress };

/**
 * Durable Recorder log. Each item MUST be stored before the Recorder acts on it: an intent before the call is
 * forwarded, an entry or event before anyone is told about it, a reversal's decision before any compensation.
 */
export interface RecorderLog {
  append(item: RecorderLogItem): void;
}

/** Appends one JSON line per item with a synchronous write, so a crash cannot lose a logged intent. */
export class RecorderFileLog implements RecorderLog {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
  append(item: RecorderLogItem) {
    appendFileSync(this.path, JSON.stringify(item) + "\n");
  }
}

/** Reads a RecorderFileLog back for `recover`. A torn last line, from a crash mid-write, is skipped. */
export function readRecorderLog(path: string): RecorderLogItem[] {
  const out: RecorderLogItem[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as RecorderLogItem);
    } catch {
      // only the last line can be torn
    }
  }
  return out;
}

/** What `recover` restored and finished. */
export interface RecorderRecovery {
  runs: string[];
  /** Runs whose log could not be trusted, with why. They are not restored; the others are. */
  refused: { runId: string; problem: string }[];
  /** Entries recorded for calls that were in flight when the Recorder stopped: done, not-run or in-doubt. */
  recorded: JournalEntry[];
  /** Reversals that were approved or declined before the stop, now finished. */
  reversals: ReverseResult[];
}

/** What `resolve` found when it asked again about an in-doubt entry (J§5.4). */
export type ResolveOutcome =
  | { state: "in-doubt"; entry: JournalEntry; reason: string }
  | { state: "done"; entry: JournalEntry; event: ResolvedEvent };

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
  /**
   * Calls that get no answer (J§5.4). They are retried only on servers with the journal role, which perform a
   * repeated entry at most once; any other server's call is recorded in doubt at once, since a retry could repeat it.
   */
  inDoubt?: {
    /** Default 2. */
    retries?: number;
    /** Milliseconds before the first retry, doubling each time. Default 200. */
    retryMs?: number;
    /** How long one attempt may take before it counts as no answer. Default 120 000. */
    timeoutMs?: number;
  };
  /** Durable log, so a restarted Recorder can `recover` its runs (J§6.4). `RecorderFileLog` writes one. */
  log?: RecorderLog;
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
  /** How in-doubt entries turned out, by entryId (J§5.4). */
  resolved: Map<string, ResolvedEvent>;
  /** The calls behind in-doubt entries, so `resolve` can send exactly the same call again. */
  intents: Map<string, CallIntent>;
  /** Set when the log failed after a call left: memory and log may disagree, so the run takes nothing more. */
  broken?: string;
}

type Forwarded =
  | { kind: "answered"; result: unknown; journal?: JournalResult }
  | { kind: "refused"; error: HatpError }
  | { kind: "in-doubt"; error: Error; attempts: number; why: string };

/** An entry as it reads once its resolution, if any, is applied (J§5.4). */
export function resolvedEntry(e: JournalEntry, r: ResolvedEvent | undefined): JournalEntry {
  if (!r) return e;
  return { ...e, outcome: r.outcome, reason: undefined, undo: r.undo, compensationToken: r.compensationToken, effect: r.effect, receipt: r.receipt ?? e.receipt, intake: r.intake };
}

const message = (e: unknown) => (e as Error)?.message ?? String(e);
/** Whatever was thrown, as an Error the agent can be given (a server may throw anything, even undefined). */
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(`the server threw ${String(e)}`));

export function createRecorder(opts: RecorderOptions) {
  const now = opts.now ?? Date.now;
  const iso = (t = now()) => new Date(t).toISOString();
  const runs = new Map<string, RunState>();
  const log = (item: RecorderLogItem) => opts.log?.append(structuredClone(item));

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

  const newRun = (header: RunHeader): RunState => ({ header, entries: [], events: [], last: runHeaderDigest(header), queue: Promise.resolve(), timers: [], reversed: new Set(), spent: new Map(), resolved: new Map(), intents: new Map() });

  /** Adds an entry or event to the run's chain, logging it first (J§6.4). */
  const append = <T extends JournalEntry | RunEvent>(run: RunState, item: T): T => {
    try {
      log({ kind: "item", runId: run.header.runId, item });
    } catch (e) {
      // What happened is now in neither the log nor the chain. Carrying on would reuse this seq for another call.
      run.broken = `the log failed while recording ${(item as JournalEntry).entryId ?? item.type}: ${message(e)}; restart the Recorder and recover from its log`;
      throw e;
    }
    run.last = hashObject(item);
    if (item.type === "hatp.journal.entry") run.entries.push(item as JournalEntry);
    else {
      const ev = item as RunEvent;
      run.events.push(ev);
      if (ev.type === "resolved") run.resolved.set(ev.entryId, ev);
      if (ev.type === "reversal") for (const [id, o] of Object.entries(ev.outcomes)) if (o === "reversed") run.reversed.add(id);
    }
    return item;
  };

  const view = (run: RunState, e: JournalEntry) => resolvedEntry(e, run.resolved.get(e.entryId));
  const viewed = (run: RunState) => run.entries.map((e) => view(run, e));

  const count = (run: RunState, i: CallIntent) => {
    if (!i.amount) return;
    // Counted when forwarded, whatever happens next: the cap bounds what was moved, or may have been (J§7).
    run.spent.set(i.amount.currency, (run.spent.get(i.amount.currency) ?? 0) + i.amount.value);
    ledger.push({ onBehalfOf: run.header.onBehalfOf, at: Date.parse(i.at), currency: i.amount.currency, value: i.amount.value });
  };

  const itemOf = (e: JournalEntry): ReviewItem => ({ entryId: e.entryId, tool: e.tool, participant: e.participant, summary: e.effect?.summary, undoBy: e.undo?.undoBy });

  /** `recordedAt` is when the Recorder learned of the effect: for a resolved entry, when it was resolved. */
  const remind = (run: RunState, e: JournalEntry, recordedAtIso = e.recordedAt) => {
    const review = opts.review;
    if (!review || !opts.onReminder || e.undo?.kind !== "compensate" || !e.undo.undoBy || e.intake) return;
    const end = Date.parse(e.undo.undoBy);
    const recordedAt = Date.parse(recordedAtIso);
    const fire = (to: Reminder["to"]) => () => {
      // An acknowledgement after this entry was recorded covers it.
      if (run.reviewedAt !== undefined && run.reviewedAt >= recordedAt) return;
      if (now() >= end) return;
      opts.onReminder!({ runId: run.header.runId, to, onBehalfOf: run.header.onBehalfOf, entries: [{ ...itemOf(e), secondsLeft: Math.round((end - now()) / 1000) }] });
    };
    run.timers.push(setLongTimeout(fire("principal"), end - review.remindBeforeSeconds * 1000 - now(), { unref: true }));
    if (review.escalateBeforeSeconds !== undefined) run.timers.push(setLongTimeout(fire("approver"), end - review.escalateBeforeSeconds * 1000 - now(), { unref: true }));
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Sends one call, retrying a call that gets no answer only where that is safe (J§5.4): a server with the journal
   * role performs a repeated (runId, entryId) at most once. An HATP error is an answer that the call didn't run,
   * but only as the first answer to it: after an attempt that got no answer, a refusal can't show that attempt
   * didn't run (a gate refusing an approval the first attempt used, say), so the call stays in doubt.
   * `unanswered` is set when the call already went out without an answer, before this Recorder was asked.
   */
  async function forward(server: JournalServer, i: CallIntent, unanswered = false): Promise<Forwarded> {
    const retries = server.undo ? (opts.inDoubt?.retries ?? 2) : 0;
    const timeoutMs = opts.inDoubt?.timeoutMs ?? 120_000;
    const req = { tool: i.tool, arguments: i.arguments, journal: { runId: i.runId, entryId: i.entryId, seq: i.seq, recorder: opts.id }, approvals: i.approvals };
    let lost: Error | undefined;
    for (let attempt = 0; ; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = server.call(req);
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
          timer.unref?.(); // the Recorder's process stays up for its own reasons; this timer alone shouldn't hold it
        });
        const { result, journal } = await Promise.race([answer, timeout]);
        return { kind: "answered", result, journal };
      } catch (e) {
        if (e instanceof HatpError) {
          if (!unanswered && attempt === 0) return { kind: "refused", error: e };
          return { kind: "in-doubt", error: e, attempts: attempt + 1, why: `${lost ? `no answer (${message(lost)}), then` : "it had gone out without an answer, then"} refused with ${e.message}, which can't show the earlier attempt didn't run` };
        }
        lost = asError(e);
        if (attempt >= retries) return { kind: "in-doubt", error: lost, attempts: attempt + 1, why: `no answer after ${attempt + 1} attempt${attempt === 0 ? "" : "s"}: ${message(lost)}` };
        await sleep((opts.inDoubt?.retryMs ?? 200) * 2 ** attempt);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** What a participant's answer means for an entry (J§5.2, J§5.3), and the intake checks it fails (J§6.1). */
  /**
   * `late`: the answer comes after the call went out unanswered (a resolution, or recovery). Its undo window may
   * have closed meanwhile, which makes it irreversible, not broken.
   */
  function interpret(server: JournalServer, i: CallIntent, journal: JournalResult | undefined, late = false) {
    const problems: string[] = [];
    // The participant's word counts only for an operation it declared, with a valid declaration (J§4).
    const declared = server.undo?.[i.tool];
    const declarationOk = declared !== undefined && !undoProblem(declared);
    if (journal && server.undo && !declared) problems.push(`${i.tool} has no undo declaration`);
    else if (journal && declared && !declarationOk) problems.push(`${i.tool}'s undo declaration is invalid: ${undoProblem(declared)}`);
    const trusted = journal && declarationOk ? journal : undefined;
    if (trusted && trusted.entryId !== i.entryId) problems.push(`result is for entry ${trusted.entryId}, not ${i.entryId}`);

    let undo: EntryUndo;
    let receipt: JournalReceipt | undefined = trusted?.receipt;
    if (trusted) {
      undo = { kind: trusted.undo.kind, undoBy: trusted.undo.undoBy, via: declared!.via };
      // A call can't be more reversible than its operation declares.
      if (declared!.kind === "none" && trusted.undo.kind !== "none") {
        problems.push(`${i.tool} is declared none but returned ${trusted.undo.kind}`);
        undo = { kind: "none" };
      }
    } else {
      undo = { kind: "unknown" };
    }
    if (!receipt) {
      // A server without the journal gets the Recorder's own receipt (J§5.3): it vouches that the call was made, nothing more.
      receipt = signObject<JournalReceipt>({ type: "hatp.receipt", txnId: i.runId, branchId: i.entryId, callDigest: i.callDigest, phase: "execute", outcome: "done", issuedAt: iso(), issuer: opts.id }, opts.signer);
    }
    if (undo.kind === "compensate") {
      if (!trusted?.compensationToken) problems.push("compensate entry has no compensationToken");
      if (!undo.undoBy || Number.isNaN(Date.parse(undo.undoBy))) problems.push("compensate entry has no undoBy");
      else if (!late && !(Date.parse(undo.undoBy) > now())) problems.push("compensate entry has no undoBy in the future");
    }
    if (trusted?.receipt) {
      const r = trusted.receipt;
      if (r.issuer !== i.participant) problems.push(`receipt is issued by ${r.issuer}, not ${i.participant}`);
      else if (!keyOwnedBy(r.signature?.kid, r.issuer) || !opts.keyring?.verify(r)) problems.push("participant receipt does not verify");
      if (r.callDigest !== i.callDigest) problems.push("receipt callDigest does not match the call");
      if (r.phase !== "execute") problems.push(`receipt phase is ${r.phase}, not execute`);
    }
    const effect = trusted?.effect;
    return { undo, receipt, effect, compensationToken: undo.kind === "compensate" ? trusted?.compensationToken : undefined, problems };
  }

  /** dependsOn (J§6.1): declared from effect.uses, then host links, else every earlier entry that ran or may have. */
  function linksFor(run: RunState, effect: Effect | undefined, uses: string[] | undefined): { links: DependencyLink[]; problems: string[] } {
    const links: DependencyLink[] = [];
    const earlier = viewed(run);
    if (effect?.uses) {
      for (const prev of earlier) if (prev.effect?.resource && effect.uses.includes(prev.effect.resource)) links.push({ entryId: prev.entryId, source: "declared" });
    }
    for (const id of uses ?? []) if (!links.some((l) => l.entryId === id)) links.push({ entryId: id, source: "host" });
    if (!effect?.uses && !uses) for (const prev of earlier) if (prev.outcome !== "not-run") links.push({ entryId: prev.entryId, source: "default" });
    const problems = links.filter((l) => !run.entries.some((p) => p.entryId === l.entryId)).map((l) => `dependsOn ${l.entryId}: no such earlier entry`);
    return { links, problems };
  }

  const base = (run: RunState, i: CallIntent) => ({
    type: "hatp.journal.entry" as const, runId: i.runId, entryId: i.entryId, seq: i.seq, agent: run.header.agent, onBehalfOf: run.header.onBehalfOf,
    participant: i.participant, tool: i.tool, callDigest: i.callDigest, arguments: opts.keepArguments === false ? undefined : i.arguments,
  });

  /** Records a forwarded call from what came back (J§5, J§5.4). Returns the error the agent should get, if any. */
  function settle(run: RunState, i: CallIntent, f: Forwarded, uses?: string[], late = false): { entry: JournalEntry; result?: unknown; error?: unknown } {
    if (f.kind === "refused") {
      // An HATP error is the participant's answer that it did not perform the call.
      const entry = append(run, { ...base(run, i), outcome: "not-run", reason: `refused by ${i.participant}: ${f.error.message}`, dependsOn: [], approvals: i.approvals, recordedAt: iso(), prevHash: run.last } satisfies JournalEntry);
      return { entry, error: f.error };
    }
    if (f.kind === "in-doubt") {
      const { links, problems } = linksFor(run, undefined, uses);
      const receipt = signObject<JournalReceipt>({ type: "hatp.receipt", txnId: i.runId, branchId: i.entryId, callDigest: i.callDigest, phase: "execute", outcome: "in-doubt", issuedAt: iso(), issuer: opts.id }, opts.signer);
      const entry = append(run, {
        ...base(run, i), outcome: "in-doubt", reason: `${f.why}; whether it took effect is unknown`,
        dependsOn: links, undo: { kind: "unknown" }, receipt, approvals: i.approvals,
        intake: problems.length ? { unresolved: true as const, problems } : undefined, recordedAt: iso(), prevHash: run.last,
      } satisfies JournalEntry);
      run.intents.set(i.entryId, i);
      return { entry, error: f.error };
    }
    const server = opts.servers(i.participant)!;
    const r = interpret(server, i, f.journal, late);
    const { links, problems } = linksFor(run, r.effect, uses);
    const all = [...problems, ...r.problems];
    const entry = append(run, {
      ...base(run, i), dependsOn: links, undo: r.undo, compensationToken: r.compensationToken, effect: r.effect, receipt: r.receipt, approvals: i.approvals,
      intake: all.length ? { unresolved: true as const, problems: all } : undefined,
      recordedAt: iso(), prevHash: run.last,
    } satisfies JournalEntry);
    if (r.undo.kind === "compensate" && !r.effect?.version) unversioned.add(`${i.participant}#${i.tool}`);
    remind(run, entry);
    return { entry, result: f.result };
  }

  const usable = (run: RunState) => {
    if (run.broken) throw new HatpError("INVALID_STATE", run.broken);
  };

  async function record(run: RunState, c: { participant: string; tool: string; arguments: Record<string, unknown>; uses?: string[]; purpose?: string }) {
    usable(run);
    if (run.closedAt) throw new HatpError("INVALID_STATE", `run ${run.header.runId} is closed`);
    const server = opts.servers(c.participant);
    if (!server) throw new HatpError("PLAN_INVALID", `unknown participant ${c.participant}`);
    const { runId } = run.header;
    const seq = run.entries.length + 1;
    const entryId = `e${seq}`;
    const digest = callDigest({ runId, entryId, tool: c.tool, arguments: c.arguments });

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
          refuse(`not approved: ${code} (asked: ${why})`, e instanceof HatpError ? e : new HatpError("INVALID_STATE", message(e)));
        }
      }
    }

    // The intent is logged before the call leaves (J§6.4): after a crash, the Recorder knows it may have run.
    const intent: CallIntent = { runId, entryId, seq, participant: c.participant, tool: c.tool, arguments: c.arguments, callDigest: digest, approvals, amount: verdict?.amount, at: iso() };
    log({ kind: "intent", intent });
    count(run, intent);
    const f = await forward(server, intent);
    const { entry, result, error } = settle(run, intent, f, c.uses);
    if (f.kind !== "answered") throw Object.assign(asError(error), { entry });
    return { result, entry };
  }

  /**
   * Asks again about an in-doubt entry (J§5.4). Only a server with the journal role is asked: a retry elsewhere
   * could repeat the effect. Only a result resolves it; a refusal or no answer leaves it in doubt.
   */
  async function resolve(run: RunState, entryId: string): Promise<ResolveOutcome> {
    usable(run);
    const e = run.entries.find((x) => x.entryId === entryId);
    if (!e) throw new HatpError("PLAN_INVALID", `no entry ${entryId} in ${run.header.runId}`);
    if (view(run, e).outcome !== "in-doubt") throw new HatpError("INVALID_STATE", `${entryId} is not in doubt`);
    const intent = run.intents.get(entryId);
    if (!intent) throw new HatpError("INVALID_STATE", `the call behind ${entryId} was not kept, so it can't be sent again`);
    const server = opts.servers(e.participant);
    if (!server) throw new HatpError("PLAN_INVALID", `unknown participant ${e.participant}`);
    if (!server.undo) throw new HatpError("NOT_SUPPORTED", `${e.participant} does not journal calls, so asking again could repeat the effect`);
    const f = await forward(server, intent, true);
    if (f.kind !== "answered") return { state: "in-doubt", entry: view(run, e), reason: f.kind === "in-doubt" ? f.why : message(f.error) };
    const r = interpret(server, intent, f.journal, true);
    const event = append(run, {
      type: "resolved", entryId, outcome: "done", undo: r.undo, compensationToken: r.compensationToken, effect: r.effect, receipt: r.receipt,
      intake: r.problems.length ? { unresolved: true as const, problems: r.problems } : undefined, at: iso(), prevHash: run.last,
    } satisfies ResolvedEvent);
    if (r.undo.kind === "compensate" && !r.effect?.version) unversioned.add(`${e.participant}#${e.tool}`);
    run.intents.delete(entryId);
    const entry = view(run, e);
    remind(run, entry, event.at);
    return { state: "done", entry, event };
  }

  const isHuman = (id: string) => id.startsWith("human://");

  /** Appends one event to a Reversal Record's own chain, as a Transaction Record's (§8.5). */
  const emitTo = (events: TxnEvent[]) => (type: string, data: Record<string, unknown> = {}) => {
    const e: TxnEvent = { seq: events.length, at: iso(), type, data, prevHash: events.length ? hashObject(events[events.length - 1]) : "sha256:genesis" };
    events.push(e);
  };

  async function reverse(run: RunState, req: ReverseRequest): Promise<ReverseResult> {
    const policy = opts.reversal;
    if (!policy) throw new HatpError("NOT_SUPPORTED", "this Recorder was built without reversal");
    await run.queue; // calls still being recorded are part of the run
    usable(run);
    const { runId } = run.header;
    const entries = viewed(run);
    const byId = new Map(entries.map((e) => [e.entryId, e]));
    const requested = "from" in req.scope ? entries.filter((e) => e.seq >= (req.scope as { from: number }).from).map((e) => e.entryId) : req.scope.entries;
    for (const id of requested) if (!byId.has(id)) throw new HatpError("PLAN_INVALID", `no entry ${id} in ${runId}`);
    if (!requested.length) throw new HatpError("PLAN_INVALID", "the scope names no entries");

    // 1–2. The reversal set: what was asked for, plus every later entry that depends on it, transitively (J§8.2).
    const set = new Set(requested);
    for (const e of entries) if (e.dependsOn.some((l) => set.has(l.entryId))) set.add(e.entryId);
    const inSet = entries.filter((e) => set.has(e.entryId));

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
      else if (e.outcome === "in-doubt") notReversible.push({ entryId: e.entryId, reason: "in doubt: the call got no answer, so whether it took effect is unknown", summary });
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
          notReversible.push({ entryId: e.entryId, reason: `check failed: ${message(err)}`, summary });
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
        for (const e of viewed(other)) {
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

    const events: TxnEvent[] = [];
    const emit = emitTo(events);
    emit("begin", { planDigest, plan, reversalOf: runId, requestedBy: req.requestedBy });
    const approvals: Approval[] = [];

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
    const progress: ReversalProgress = { reversalId, plan, planDigest, approved, approvals, receipts, decision, events };
    // Durable before the first compensation (J§8.5): a restarted Recorder finishes what was approved.
    log({ kind: "reversal", runId, progress });
    return finishReversal(run, progress);
  }

  /** 8–9. Compensates in plan order, latest entry first (J§8.5), signs the Reversal Record, and chains a reference to it. */
  async function finishReversal(run: RunState, p: ReversalProgress): Promise<ReverseResult> {
    const policy = opts.reversal!;
    const { runId } = run.header;
    const byId = new Map(viewed(run).map((e) => [e.entryId, e]));
    const { plan, planDigest, reversalId } = p;
    const emit = emitTo(p.events);
    const branchState: Record<string, BranchState> = Object.fromEntries(plan.branches.map((b) => [b.branchId, "ENLISTED" as BranchState]));
    const outcomes: Record<string, ReversalOutcome> = {};
    let state: TxnState = "ABORTED";
    if (p.approved) {
      // A failed entry keeps what it depends on live.
      const blocked = new Map<string, string>();
      const blockDeps = (id: string) => {
        const stack = [id];
        while (stack.length) {
          for (const l of byId.get(stack.pop()!)!.dependsOn) if (!blocked.has(l.entryId)) { blocked.set(l.entryId, id); stack.push(l.entryId); }
        }
      };
      for (const b of plan.branches) {
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
            p.receipts.push(receipt);
            outcome = "reversed";
            emit("compensated", { branchId: b.branchId, entryId: entry.entryId, effect: receipt.detail?.effect });
          } catch (err) {
            if (err instanceof HatpError) {
              outcome = "failed";
              emit("compensation-failed", { branchId: b.branchId, entryId: entry.entryId, code: err.code, message: err.message });
            } else if (attempt >= (policy.retries ?? 2)) {
              // No answer: compensate is idempotent, but it may or may not have happened (J§8.5).
              outcome = "unknown";
              emit("compensation-unknown", { branchId: b.branchId, entryId: entry.entryId, message: message(err) });
            } else await sleep((policy.retryMs ?? 200) * 2 ** attempt);
          }
        }
        outcomes[entry.entryId] = outcome;
        branchState[b.branchId] = outcome === "reversed" ? "COMPENSATED" : outcome === "unknown" ? "IN_DOUBT" : "FAILED";
        if (outcome !== "reversed") blockDeps(entry.entryId);
      }
      state = Object.values(outcomes).every((o) => o === "reversed") ? "COMMITTED" : "NEEDS_ATTENTION";
    }
    emit("end", { state, outcomes });
    const record = signObject<ReversalRecord>({ type: "hatp.record", plan, planDigest, state, branches: branchState, approvals: p.approvals, receipts: p.receipts, decision: p.decision, events: p.events, issuer: opts.id }, opts.signer);

    // The run's chain gets a reference to the record and each entry's outcome. Nothing in the run is edited.
    append(run, { type: "reversal" as const, reversalId, recordDigest: hashObject(record), outcomes, at: iso(), prevHash: run.last });
    return { state, reversalId, plan, planDigest, outcomes, record };
  }

  function signed(run: RunState): RunRecord {
    return signObject<RunRecord>({ type: "hatp.journal.run", hatp: "0.3", ...run.header, closedAt: run.closedAt, entries: run.entries, events: run.events, spend: run.spent.size ? { perRun: [...run.spent].map(([currency, value]) => ({ value, currency })) } : undefined, issuedAt: iso() }, opts.signer);
  }

  /**
   * One run from its log lines (J§6.4), checked as it is rebuilt: its header is this Recorder's, its chain is
   * unbroken, its seq gap-free, each entry that ran matches the intent logged before it, and at most one call
   * (the next one) was in flight. Throws on the first problem.
   */
  function rebuild(runId: string, lines: RecorderLogItem[]) {
    const head = lines.find((l) => l.kind === "run");
    if (head?.kind !== "run") throw new Error("the log has items for this run but no run header");
    if (head.header.recorder !== opts.id) throw new Error(`the run was recorded by ${head.header.recorder}, not ${opts.id}`);
    if (runs.has(runId)) throw new Error("the run is already open here");
    const run = newRun(head.header);
    const intents = new Map<string, CallIntent>();
    const progress = new Map<string, ReversalProgress>();
    for (const l of lines) {
      if (l.kind === "intent") {
        if (intents.has(l.intent.entryId)) throw new Error(`two intents for ${l.intent.entryId}`);
        intents.set(l.intent.entryId, l.intent);
        count(run, l.intent);
      } else if (l.kind === "closed") run.closedAt = l.at;
      else if (l.kind === "reversal") progress.set(l.progress.reversalId, l.progress);
      else if (l.kind === "item") {
        const it = l.item;
        if (it.prevHash !== run.last) throw new Error(`the hash chain breaks at ${(it as JournalEntry).entryId ?? it.type}`);
        run.last = hashObject(it);
        if (it.type === "hatp.journal.entry") {
          if (it.seq !== run.entries.length + 1 || it.entryId !== `e${it.seq}` || it.runId !== runId) throw new Error(`entry ${it.entryId} is out of seq`);
          const i = intents.get(it.entryId);
          // A call that went out was logged as an intent first; its entry must be for exactly that call.
          if (i && (i.callDigest !== it.callDigest || i.participant !== it.participant || i.tool !== it.tool || callDigest({ runId, entryId: it.entryId, tool: it.tool, arguments: i.arguments }) !== it.callDigest)) {
            throw new Error(`entry ${it.entryId} doesn't match the call logged for it`);
          }
          if (!i && it.outcome !== "not-run") throw new Error(`entry ${it.entryId} ran, but no call was logged for it`);
          run.entries.push(it);
        } else {
          run.events.push(it);
          if (it.type === "resolved") run.resolved.set(it.entryId, it);
          if (it.type === "reviewed") run.reviewedAt = Date.parse(it.at);
          if (it.type === "reversal") for (const [id, o] of Object.entries(it.outcomes)) if (o === "reversed") run.reversed.add(id);
        }
      }
    }
    const pending = [...intents.values()].filter((i) => !run.entries.some((e) => e.entryId === i.entryId));
    if (pending.length > 1 || (pending[0] && pending[0].seq !== run.entries.length + 1)) throw new Error("its logged calls don't follow its entries");
    if (pending[0] && run.closedAt) throw new Error("it was closed with a call still in flight");
    return { run, intents, progress };
  }

  /** Runs work after everything already queued on the run, so `seq` and the chain keep their order. */
  const enqueue = <T,>(run: RunState, work: () => Promise<T>): Promise<T> => {
    const next = run.queue.then(work);
    run.queue = next.catch(() => {});
    return next;
  };

  return {
    id: opts.id,

    /** Opens a run for one agent and principal. The Recorder, not the agent, chooses the runId. */
    startRun(h: { agent: string; onBehalfOf?: string; purpose?: string; policyDigest?: string }): string {
      const runId = `run_${newTxnId().slice(4)}`;
      const header: RunHeader = { runId, agent: h.agent, onBehalfOf: h.onBehalfOf, purpose: h.purpose, recorder: opts.id, policyDigest: policyDigest ?? h.policyDigest, startedAt: iso() };
      log({ kind: "run", header });
      runs.set(runId, newRun(header));
      return runId;
    },

    /**
     * Forwards one tool call with journal context and records it (J§5). `uses` names earlier entries the host
     * knows this call relied on (`host` links). The agent gets the tool's result, or its error. A call that gets
     * no answer is recorded in doubt (J§5.4), and the error carries that entry.
     */
    call(runId: string, c: { participant: string; tool: string; arguments: Record<string, unknown>; uses?: string[]; purpose?: string }): Promise<{ result: unknown; entry: JournalEntry }> {
      const run = runOf(runId);
      return enqueue(run, () => record(run, c));
    },

    /**
     * Asks a journal server again about an in-doubt entry (J§5.4). An answer is appended as a `resolved` event;
     * no answer leaves the entry in doubt.
     */
    resolve(runId: string, entryId: string): Promise<ResolveOutcome> {
      const run = runOf(runId);
      return enqueue(run, () => resolve(run, entryId));
    },

    /** Records that the principal or an approver looked at the run (J§6.3). It approves nothing and closes no window. */
    acknowledge(runId: string, by: string): RunEvent {
      const run = runOf(runId);
      usable(run);
      const at = now();
      run.reviewedAt = at;
      return append(run, { type: "reviewed" as const, by, at: iso(at), prevHash: run.last });
    },

    /** Closes the run once its calls have been recorded, and returns the signed Run Record (J§6.2). */
    async closeRun(runId: string): Promise<RunRecord> {
      const run = runOf(runId);
      await run.queue;
      usable(run);
      if (!run.closedAt) {
        run.closedAt = iso();
        log({ kind: "closed", runId, at: run.closedAt });
      }
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
      const out: RunReview = { runId, generatedAt: iso(t), reversible: [], closed: [], irreversible: [], unresolved: [], notRun: [], inDoubt: [] };
      const ack = [...run.events].reverse().find((e) => e.type === "reviewed");
      if (ack?.type === "reviewed") out.reviewed = { by: ack.by, at: ack.at };
      for (const e of viewed(run)) {
        const item = itemOf(e);
        if (e.outcome === "not-run") out.notRun.push({ ...item, reason: e.reason });
        else if (e.intake) out.unresolved.push({ ...item, reason: e.intake.problems.join("; ") });
        else if (e.outcome === "in-doubt") out.inDoubt.push({ ...item, reason: e.reason });
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

    /**
     * Restores runs from a previous process's log (J§6.4) and finishes what it left: a call that was in flight is
     * sent again to a journal server and recorded from its answer, or recorded in doubt; a reversal whose decision
     * was logged is driven to its end. The log's chain is checked item by item, and a break refuses the run.
     */
    async recover(items: RecorderLogItem[]): Promise<RecorderRecovery> {
      const out: RecorderRecovery = { runs: [], refused: [], recorded: [], reversals: [] };
      const groups = new Map<string, RecorderLogItem[]>();
      for (const it of items) {
        const id = it.kind === "run" ? it.header.runId : it.kind === "intent" ? it.intent.runId : it.runId;
        groups.set(id, [...(groups.get(id) ?? []), it]);
      }
      const work: Promise<void>[] = [];
      for (const [runId, lines] of groups) {
        // Each run is rebuilt on its own and refused on its own: one bad run doesn't cost the others.
        let rebuilt: { run: RunState; intents: Map<string, CallIntent>; progress: Map<string, ReversalProgress> };
        try {
          rebuilt = rebuild(runId, lines);
        } catch (e) {
          out.refused.push({ runId, problem: message(e) });
          continue;
        }
        const { run, intents, progress } = rebuilt;
        runs.set(runId, run);
        out.runs.push(runId);
        for (const e of run.entries) {
          const v = view(run, e);
          if (v.outcome === "in-doubt" && intents.has(e.entryId)) run.intents.set(e.entryId, intents.get(e.entryId)!);
          if (v.undo?.kind === "compensate" && !v.effect?.version) unversioned.add(`${v.participant}#${v.tool}`);
          remind(run, v, run.resolved.get(e.entryId)?.at ?? e.recordedAt);
        }
        const pending = [...intents.values()].find((i) => !run.entries.some((e) => e.entryId === i.entryId));
        const done = new Set(run.events.flatMap((e) => (e.type === "reversal" ? [e.reversalId] : [])));
        work.push(enqueue(run, async () => {
          if (pending) {
            const server = opts.servers(pending.participant);
            // It went out before the stop, without an answer. Only a journal server may be asked again; for any
            // other, the call may or may not have run.
            const f: Forwarded = server?.undo
              ? await forward(server, pending, true)
              : { kind: "in-doubt", error: new Error("lost"), attempts: 1, why: server ? "the Recorder stopped before recording the call, and asking again could repeat it" : `the Recorder stopped before recording the call, and ${pending.participant} is no longer configured` };
            out.recorded.push(settle(run, pending, f, undefined, true).entry);
          }
          for (const p of progress.values()) {
            if (done.has(p.reversalId)) continue;
            emitTo(p.events)("recovered", { by: opts.id });
            out.reversals.push(await finishReversal(run, p));
          }
        }));
      }
      await Promise.all(work);
      return out;
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
  const position = new Map(walked.map((x, i) => [x, i]));

  // A participant's receipt: issued by the participant, signed with its own key, for exactly this call.
  const participantReceipt = (e: JournalEntry, r: JournalReceipt, where: string) => {
    if (r.callDigest !== e.callDigest || r.txnId !== e.runId || r.branchId !== e.entryId) problems.push(`${where}: receipt is for another call`);
    if (r.issuer !== e.participant) problems.push(`${where}: receipt issued by ${r.issuer}, not ${e.participant}`);
    else if (!o.keyring) problems.push(`${where}: no keyring to check ${e.participant}'s receipt`);
    else if (!keyOwnedBy(r.signature?.kid, r.issuer) || !o.keyring.verify(r)) problems.push(`${where}: participant receipt does not verify`);
  };

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
    if (e.outcome === "in-doubt") {
      // No answer came: the Recorder can vouch only that it sent the call (J§5.4).
      if (!e.reason) problems.push(`entry ${e.entryId}: in doubt without a reason`);
      if (e.undo?.kind !== "unknown" || e.compensationToken || e.effect) problems.push(`entry ${e.entryId}: in doubt, but carries undo information`);
      if (r?.issuer !== record.recorder || r.outcome !== "in-doubt") problems.push(`entry ${e.entryId}: in doubt needs the Recorder's in-doubt receipt`);
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

  // 4. Resolutions (J§5.4): one per in-doubt entry, after it in the chain, carrying the participant's own answer.
  const resolvedOnce = new Set<string>();
  for (const ev of record.events) {
    if (ev.type !== "resolved") continue;
    const where = `resolution of ${ev.entryId}`;
    const e = record.entries.find((x) => x.entryId === ev.entryId);
    if (!e || e.outcome !== "in-doubt") { problems.push(`${where}: no in-doubt entry ${ev.entryId}`); continue; }
    if (resolvedOnce.has(ev.entryId)) problems.push(`${where}: resolved more than once`);
    resolvedOnce.add(ev.entryId);
    if ((position.get(ev) ?? -1) < (position.get(e) ?? Infinity)) problems.push(`${where}: chained before the entry it resolves`);
    if (ev.outcome !== "done") problems.push(`${where}: outcome ${String(ev.outcome)}; only a result resolves an entry`);
    if (!ev.receipt) problems.push(`${where}: no receipt`);
    else if (ev.receipt.issuer === record.recorder) {
      if (ev.undo?.kind !== "unknown") problems.push(`${where}: undo ${ev.undo?.kind} needs the participant's receipt`);
      if (!recorderKey || !verifyObject(ev.receipt, recorderKey) || ev.receipt.callDigest !== e.callDigest) problems.push(`${where}: the Recorder's receipt does not verify`);
    } else participantReceipt(e, ev.receipt, where);
  }
  return { ok: problems.length === 0, problems };
}
