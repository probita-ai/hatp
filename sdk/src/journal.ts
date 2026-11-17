// The Journal's Recorder (spec/hatp-journal.md J§5–J§6): journals an agent's direct tool calls with their undo
// information, keeps every entry and event in one hash chain, signs the Run Record, and reminds the principal
// before undo windows close. Reversal (J§8) and the autonomy policy (J§7) build on this.
import { hashObject, newTxnId, signObject, verifyObject } from "./crypto.ts";
import type { KeyRing, Signer } from "./crypto.ts";
import { setLongTimeout } from "./timers.ts";
import type { LongTimer } from "./timers.ts";
import { HatpError } from "./types.ts";
import type { Jwk, Money, Signature } from "./types.ts";

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

/** A tool server as the Recorder sees it. An MCP binding stands behind this (#59). */
export interface JournalServer {
  id: string;
  /** Per-operation undo declarations from the server's capability (J§4). Absent: no `journal` role. */
  undo?: Record<string, UndoDeclaration>;
  call(req: { tool: string; arguments: Record<string, unknown>; journal: JournalMeta }): Promise<{ result: unknown; journal?: JournalResult }>;
}

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
  intake?: { unresolved: true; problems: string[] };
  recordedAt: string;
  prevHash: string;
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
}

export function createRecorder(opts: RecorderOptions) {
  const now = opts.now ?? Date.now;
  const iso = (t = now()) => new Date(t).toISOString();
  const runs = new Map<string, RunState>();

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

  async function record(run: RunState, c: { participant: string; tool: string; arguments: Record<string, unknown>; uses?: string[] }) {
    if (run.closedAt) throw new HatpError("INVALID_STATE", `run ${run.header.runId} is closed`);
    const server = opts.servers(c.participant);
    if (!server) throw new HatpError("PLAN_INVALID", `unknown participant ${c.participant}`);
    const { runId } = run.header;
    const seq = run.entries.length + 1;
    const entryId = `e${seq}`;
    const digest = callDigest({ runId, entryId, tool: c.tool, arguments: c.arguments });
    const problems: string[] = [];

    let result: unknown;
    let journal: JournalResult | undefined;
    let failure: unknown;
    try {
      ({ result, journal } = await server.call({ tool: c.tool, arguments: c.arguments, journal: { runId, entryId, seq, recorder: opts.id } }));
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
    if (!effect?.uses && !c.uses) for (const prev of run.entries) links.push({ entryId: prev.entryId, source: "default" });

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
      dependsOn: links, undo, compensationToken: undo.kind === "compensate" ? trusted?.compensationToken : undefined, effect, receipt,
      intake: problems.length ? { unresolved: true as const, problems } : undefined,
      recordedAt: iso(), prevHash: run.last,
    } satisfies JournalEntry);
    run.entries.push(entry);
    remind(run, entry);
    if (failure) throw failure;
    return { result, entry };
  }

  function signed(run: RunState): RunRecord {
    return signObject<RunRecord>({ type: "hatp.journal.run", hatp: "0.3", ...run.header, closedAt: run.closedAt, entries: run.entries, events: run.events, issuedAt: iso() }, opts.signer);
  }

  return {
    id: opts.id,

    /** Opens a run for one agent and principal. The Recorder, not the agent, chooses the runId. */
    startRun(h: { agent: string; onBehalfOf?: string; purpose?: string; policyDigest?: string }): string {
      const runId = `run_${newTxnId().slice(4)}`;
      const header: RunHeader = { runId, agent: h.agent, onBehalfOf: h.onBehalfOf, purpose: h.purpose, recorder: opts.id, policyDigest: h.policyDigest, startedAt: iso() };
      runs.set(runId, { header, entries: [], events: [], last: runHeaderDigest(header), queue: Promise.resolve(), timers: [] });
      return runId;
    },

    /**
     * Forwards one tool call with journal context and records it (J§5). `uses` names earlier entries the host
     * knows this call relied on (`host` links). The agent gets the tool's result, or its error.
     */
    call(runId: string, c: { participant: string; tool: string; arguments: Record<string, unknown>; uses?: string[] }): Promise<{ result: unknown; entry: JournalEntry }> {
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
      const out: RunReview = { runId, generatedAt: iso(t), reversible: [], closed: [], irreversible: [], unresolved: [] };
      const ack = [...run.events].reverse().find((e) => e.type === "reviewed");
      if (ack?.type === "reviewed") out.reviewed = { by: ack.by, at: ack.at };
      for (const e of run.entries) {
        const item = itemOf(e);
        if (e.intake) out.unresolved.push({ ...item, reason: e.intake.problems.join("; ") });
        else if (e.undo?.kind === "compensate" && e.undo.undoBy) {
          const left = Date.parse(e.undo.undoBy) - t;
          if (left > 0) out.reversible.push({ ...item, secondsLeft: Math.round(left / 1000) });
          else out.closed.push(item);
        } else out.irreversible.push({ ...item, reason: e.undo?.kind === "unknown" ? "the server does not journal this call" : "declared irreversible" });
      }
      out.reversible.sort((a, b) => Date.parse(a.undoBy!) - Date.parse(b.undoBy!));
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

  // 3. Each entry: its call digest, its receipt, its links.
  const seen = new Set<string>();
  for (const e of record.entries) {
    if (e.arguments && callDigest({ runId: e.runId, entryId: e.entryId, tool: e.tool, arguments: e.arguments }) !== e.callDigest) problems.push(`entry ${e.entryId}: arguments don't match callDigest`);
    const r = e.receipt;
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
