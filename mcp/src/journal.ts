// The Journal over MCP (spec/hatp-journal.md, #59): journal participants that report each direct call's effect and
// undo it on request, a Recorder-side JournalServer for any MCP server, and hatp/journal/get for Run Records.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { callDigest, executeReceipt, HatpError, HUMAN_GATEWAY_EXTENSION, signObject } from "hatp-protocol";
import type { Effect, JournalCheckResult, JournalReceipt, JournalResult, JournalServer, Jwk, KeyRing, Money, Receipt, RunRecord, Signer, UndoDeclaration } from "hatp-protocol";
import { undoProblem } from "hatp-protocol";
import { z } from "zod";
import type { HatpCapability } from "./index.ts";
import { advertisedOf, advertiseExtension, bare, handlers, hatpCodeOf, journalRepeats, lowLevel, request, toMcpError } from "./wire.ts";
import type { Extra, RawHandler } from "./wire.ts";

/** Where journal context travels on `tools/call`, in both directions (J§5). */
export const JOURNAL_META = "hatp/journal";
const CHECK = "hatp/journal/check";
const COMPENSATE = "hatp/txn/compensate";
const GET = "hatp/journal/get";

const fail = (code: HatpError["code"], message: string, data: Record<string, unknown> = {}) => toMcpError(new HatpError(code, message), data);

/** Adds to the `hatp` capability this server already advertises (from `serveHatp`), or starts one at 0.3. */
function extendCapability(s: Server, patch: (c: HatpCapability) => HatpCapability): void {
  const current = advertisedOf(s)?.hatp as HatpCapability | undefined;
  const base: HatpCapability = current ? { ...current, roles: [...current.roles], keys: [...(current.keys ?? [])], operations: { ...current.operations } } : { version: "0.3", roles: [], keys: [] };
  advertiseExtension(s, { hatp: { ...patch(base), version: "0.3" } });
}

const addKey = (keys: Jwk[], k: Jwk) => (keys.some((x) => x.kid === k.kid) ? keys : [...keys, k]);

// ---------------------------------------------------------------------------------------------
// Participant side

/** A call this server journaled, as kept for its compensation token. */
export interface JournaledCall {
  runId: string;
  entryId: string;
  tool: string;
  arguments: Record<string, unknown>;
  callDigest: string;
  effect: Effect;
  undoBy?: string;
  /** Who made the call, from `caller`. Only the same caller may check or compensate it (J§5.2). */
  caller?: string;
}

export interface JournaledTool {
  undo: UndoDeclaration;
  /** For a tool that moves money: a JSON Pointer to the amount in its arguments. The Recorder's caps count it (J§7). */
  amountFrom?: string;
  /**
   * What the call changed, from the actual change, never from the agent's text (J§5.2). `version` is the changed
   * resource's version right after the call; without it, the entry is unversioned and only reversed by force.
   */
  effect(args: Record<string, unknown>, result: CallToolResult): Effect | Promise<Effect>;
  /** The resource's version now, so the binding can refuse a reversal that would overwrite newer work (J§8.6). */
  currentVersion?(call: JournaledCall): string | undefined | Promise<string | undefined>;
  /**
   * Reverses the call. The binding has already checked the window, `ifVersion` against `currentVersion`, and that the
   * request carries `ifVersion` or `force`. Throw HatpError to refuse (for example `UNDO_CONFLICT` for rules of your own).
   */
  compensate?(call: JournaledCall, o: { ifVersion?: string; force: boolean }): Promise<{ summary: string; version?: string; sideEffects?: string[] }>;
}

type TokenRecord = JournaledCall & { done?: Receipt; pending?: Promise<{ receipt: Receipt }>; keepUntil: number };
type PerformedRecord = {
  digest: string;
  caller?: string;
  answer: Promise<unknown>;
  /** The call was running when the participant stopped: its outcome is unknown, so a repeat is refused. */
  interrupted?: boolean;
  keepUntil: number;
};

/**
 * One item of a journal participant's durable store (J§5.2). Each is stored before anyone is told of it: a call as
 * `started` before the tool runs, its `answered` result before the answer leaves, a reversal as `compensating`
 * before `compensate()` runs and `compensated` before its receipt leaves.
 */
export type JournalStoreItem =
  | { kind: "started"; key: string; digest: string; caller?: string; at: string; keepUntil?: string }
  | { kind: "answered"; key: string; answer: unknown; keepUntil: string; token?: { token: string; call: JournaledCall } }
  | { kind: "forgotten"; key: string }
  | { kind: "compensating"; token: string; at: string }
  | { kind: "compensated"; token: string; receipt: Receipt }
  | { kind: "compensate-ended"; token: string };

/** Durable memory for a journal participant. `append` MUST store the item before it returns. */
export interface JournalStore {
  append(item: JournalStoreItem): void;
  /** Replaces the whole store with these items. `journalState` calls it on recovery, to drop expired items. */
  rewrite?(items: JournalStoreItem[]): void;
}

/** Appends one JSON line per item with a synchronous write. */
export class JournalFileStore implements JournalStore {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
  append(item: JournalStoreItem) {
    appendFileSync(this.path, JSON.stringify(item) + "\n");
  }
  rewrite(items: JournalStoreItem[]) {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, items.map((i) => JSON.stringify(i) + "\n").join(""));
    renameSync(tmp, this.path);
  }
}

/** Reads a JournalFileStore back. A missing file is an empty store; a torn last line, from a crash mid-write, is skipped. */
export function readJournalStore(path: string): JournalStoreItem[] {
  if (!existsSync(path)) return [];
  const out: JournalStoreItem[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as JournalStoreItem);
    } catch {
      // only the last line can be torn
    }
  }
  return out;
}

/** How long a participant keeps a `none` call for repeats: at least 24 hours (J§5.2). */
const KEEP_NONE_MS = 24 * 3600_000;

/**
 * What a journal participant remembers: compensation tokens, and each call it performed (so a repeat is answered,
 * not run again). Make one per participant and pass it to `journalTools` on every McpServer that serves as that
 * participant: an HTTP server builds an McpServer per session, and a Recorder that reconnects must still be able
 * to undo its calls.
 *
 * Without a `store` it is held in memory, and lost when the process stops. With one, every change is stored first,
 * and `journalState({ store, recover: readJournalStore(path) })` restores it after a restart.
 */
export interface JournalState {
  tokens: Map<string, TokenRecord>;
  performed: Map<string, PerformedRecord>;
  store?: JournalStore;
  /** Reversals that were running when the participant stopped: their outcome is unknown, so a retry is refused. */
  interruptedReversals: Set<string>;
}

export interface JournalStateOptions {
  store?: JournalStore;
  /** The store's items, read back after a restart (`readJournalStore`). */
  recover?: JournalStoreItem[];
  now?: () => number;
}

export function journalState(opts: JournalStateOptions = {}): JournalState {
  const state: JournalState = { tokens: new Map(), performed: new Map(), store: opts.store, interruptedReversals: new Set() };
  if (!opts.recover) return state;
  const now = (opts.now ?? Date.now)();
  const started = new Map<string, Extract<JournalStoreItem, { kind: "started" }>>();
  const answered = new Map<string, Extract<JournalStoreItem, { kind: "answered" }>>();
  const byToken = new Map<string, string>(); // token -> key
  const compensating = new Set<string>();
  const done = new Map<string, Receipt>();
  for (const item of opts.recover) {
    switch (item.kind) {
      case "started": started.set(item.key, item); answered.delete(item.key); break;
      case "answered": answered.set(item.key, item); if (item.token) byToken.set(item.token.token, item.key); break;
      case "forgotten": started.delete(item.key); answered.delete(item.key); break;
      case "compensating": compensating.add(item.token); break;
      case "compensated": done.set(item.token, item.receipt); compensating.delete(item.token); break;
      case "compensate-ended": compensating.delete(item.token); break;
    }
  }
  const kept: JournalStoreItem[] = [];
  for (const [key, s] of started) {
    const a = answered.get(key);
    const keepUntil = a ? Date.parse(a.keepUntil) : s.keepUntil ? Date.parse(s.keepUntil) : Date.parse(s.at) + KEEP_NONE_MS;
    if (keepUntil <= now) continue;
    kept.push(s);
    if (!a) {
      state.performed.set(key, { digest: s.digest, caller: s.caller, answer: Promise.resolve(), interrupted: true, keepUntil });
      continue;
    }
    kept.push(a);
    state.performed.set(key, { digest: s.digest, caller: s.caller, answer: Promise.resolve(a.answer), keepUntil });
    if (!a.token) continue;
    const { token, call } = a.token;
    state.tokens.set(token, { ...call, keepUntil, ...(done.has(token) ? { done: done.get(token) } : {}) });
    if (done.has(token)) kept.push({ kind: "compensated", token, receipt: done.get(token)! });
    else if (compensating.has(token)) {
      state.interruptedReversals.add(token);
      kept.push({ kind: "compensating", token, at: s.at });
    }
  }
  opts.store?.rewrite?.(kept);
  return state;
}

/** Drops what no repeat or reversal can need any more (J§5.2). */
function prune(state: JournalState, now: number): void {
  for (const [k, p] of state.performed) if (p.keepUntil <= now) state.performed.delete(k);
  for (const [t, r] of state.tokens) if (r.keepUntil <= now && !r.pending) { state.tokens.delete(t); state.interruptedReversals.delete(t); }
}

export interface JournalToolsOptions {
  /** The participant's key. `signer.id` is its participant URI, and `signer.kid` must start with it and "#". */
  signer: Signer;
  tools: Record<string, JournaledTool>;
  /** Shared across this participant's McpServers (one per HTTP session, say). Default: this server's own. */
  state?: JournalState;
  /**
   * Who is calling, from what the transport authenticated. Tokens are bound to it: another caller can't check or
   * compensate them, or replay the call to read them. Default: `extra.authInfo.clientId`. Without it, the token
   * alone counts. Don't bind to the MCP session id: a Recorder reconnects with a new one long before an undo
   * window closes, and could no longer undo its own calls.
   */
  caller?(extra: Extra): string | undefined;
  now?: () => number;
}

/**
 * Makes tools on an McpServer journal participants (J§4–J§5, J§10.3–J§10.4). Call after registering the tools,
 * and after `serveHatp` if the server also takes part in transactions.
 *
 * - The capability gains the `journal` role, each tool's `undo` and `amountFrom`, and version 0.3.
 * - A `tools/call` with `_meta["hatp/journal"]` runs the tool and returns, in the result's `_meta`, what it
 *   changed, a compensation token for a `compensate` tool, and a signed `execute` receipt. A repeat of the same
 *   (runId, entryId), which a Recorder sends when a call got no answer (J§5.4), is answered with the same result
 *   and never runs the tool again; a repeat with other arguments is refused. Held in memory, like the tokens.
 * - `hatp/journal/check` reports whether a reversal would succeed now, changing nothing.
 * - `hatp/txn/compensate` with one of this server's tokens reverses the call. It needs `ifVersion` or `force`
 *   (`UNDO_VERSION_REQUIRED`), refuses a changed resource (`UNDO_CONFLICT`) or a closed window
 *   (`UNDO_WINDOW_CLOSED`), and answers a repeat with the same receipt. Other tokens go to `serveHatp`'s handler.
 */
export function journalTools(server: McpServer, opts: JournalToolsOptions): { calls(): JournaledCall[] } {
  const s = server.server;
  const now = opts.now ?? Date.now;
  const id = opts.signer.id;
  if (!opts.signer.kid.startsWith(`${id}#`)) throw new Error(`hatp-mcp: key ${opts.signer.kid} is outside ${id}'s namespace`);
  for (const [name, t] of Object.entries(opts.tools)) {
    const problem = undoProblem(t.undo);
    if (problem) throw new Error(`hatp-mcp: ${name}'s undo declaration is invalid: ${problem}`);
    if (t.undo.kind === "compensate" && !t.compensate) throw new Error(`hatp-mcp: ${name} is declared compensate but has no compensate()`);
  }
  const map = handlers(s);
  const call = map.get("tools/call");
  if (!call) throw new Error("hatp-mcp: register the tools before journaling them");

  extendCapability(s, (c) => ({
    ...c,
    roles: c.roles.includes("journal") ? c.roles : [...c.roles, "journal"],
    operations: { ...c.operations, ...Object.fromEntries(Object.entries(opts.tools).map(([n, t]) => [n, { ...c.operations?.[n], undo: t.undo, ...(t.amountFrom ? { amountFrom: t.amountFrom } : {}) }])) },
    keys: addKey(c.keys, opts.signer.publicJwk),
  }));

  const callerOf = opts.caller ?? ((extra: Extra) => extra.authInfo?.clientId as string | undefined);
  const state = opts.state ?? journalState();
  const tokens = state.tokens;
  const store = state.store;
  // Each journaled call by (runId, entryId): performed at most once, its answer kept for repeats (J§5.4).
  const performed = state.performed;
  const iso = (t = now()) => new Date(t).toISOString();

  type Journaled = { tool: JournaledTool; runId: string; entryId: string; name: string; args: Record<string, unknown>; digest: string; key: string; who?: string };
  const journaledOf = (req: { params?: Record<string, unknown> }, extra: Extra): Journaled | undefined => {
    const name = req.params?.name;
    const tool = typeof name === "string" ? opts.tools[name] : undefined;
    const meta = (req.params?._meta as Record<string, unknown> | undefined)?.[JOURNAL_META] as { runId?: unknown; entryId?: unknown } | undefined;
    if (!tool || !meta) return undefined;
    if (typeof meta.runId !== "string" || typeof meta.entryId !== "string") throw fail("PLAN_INVALID", `${JOURNAL_META} needs runId and entryId`);
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    return { tool, runId: meta.runId, entryId: meta.entryId, name: name as string, args, digest: callDigest({ runId: meta.runId, entryId: meta.entryId, tool: name as string, arguments: args }), key: JSON.stringify([meta.runId, meta.entryId]), who: callerOf(extra) };
  };
  /** The answer to a repeat of a call already performed or in progress, or undefined for a new call. */
  const repeatOf = (j: Journaled): Promise<unknown> | undefined => {
    const seen = performed.get(j.key);
    if (!seen) return undefined;
    if (seen.caller !== undefined && seen.caller !== j.who) throw fail("PLAN_INVALID", `${j.runId}/${j.entryId} was called by another caller`);
    if (seen.digest !== j.digest) throw fail("PLAN_INVALID", `${j.runId}/${j.entryId} was already called with other arguments`);
    // Refused, not run again: the Recorder sent it unanswered, so it records the entry in doubt (J§5.4).
    if (seen.interrupted) throw fail("OUTCOME_UNKNOWN", `${j.runId}/${j.entryId} was cut off by a restart of this server before it answered`);
    return seen.answer;
  };
  // Requests the journal itself is passing down to run: the wrappers below must run them, not answer them as repeats.
  const forwarding = new WeakSet<object>();
  journalRepeats.set(s, (req, extra) => {
    if (forwarding.has(req)) return undefined;
    const j = journaledOf(req, extra);
    return j && repeatOf(j);
  });

  map.set("tools/call", async (req, extra) => {
    const j = journaledOf(req, extra);
    if (!j) return call(req, extra);
    const repeat = repeatOf(j);
    if (repeat) return repeat;
    prune(state, now());
    // Stored before the call starts, so a repeat that arrives meanwhile waits for this attempt, and a repeat after a
    // restart is refused rather than run again.
    // Kept as long as its answer would be, so a repeat however late is refused, not run (J§5.2).
    const slot: PerformedRecord = { digest: j.digest, caller: j.who, answer: Promise.resolve(), keepUntil: now() + Math.max(KEEP_NONE_MS, (j.tool.undo.windowSeconds ?? 0) * 1000) };
    performed.set(j.key, slot);
    try {
      store?.append({ kind: "started", key: j.key, digest: j.digest, ...(j.who !== undefined ? { caller: j.who } : {}), at: iso(), keepUntil: iso(slot.keepUntil) });
    } catch (e) {
      performed.delete(j.key);
      throw fail("INVALID_STATE", `could not store the call before running it: ${(e as Error)?.message ?? String(e)}`);
    }
    slot.answer = perform(req, extra, j, slot, () => {
      if (performed.get(j.key) === slot) performed.delete(j.key);
      try { store?.append({ kind: "forgotten", key: j.key }); } catch { /* after a restart, a repeat is refused: in doubt, never run twice */ }
    });
    return slot.answer;
  });

  /**
   * Runs one journaled call. `forget` is called if the tool didn't run (the call underneath threw before a result),
   * so a later attempt may run it. Once it ran, its answer stands for every repeat, even a failure to describe it.
   */
  async function perform(req: Parameters<RawHandler>[0], extra: Extra, j: Journaled, slot: PerformedRecord, forget: () => void) {
    const { runId, entryId, args, digest, tool } = j;
    // A journaled call runs to completion or not at all: the Recorder learns its outcome from a repeat if the
    // first answer is lost, so the client's cancellation (sent when its request times out) doesn't reach the tool.
    const quiet = { ...extra, signal: new AbortController().signal };
    let result: CallToolResult;
    forwarding.add(req);
    try {
      result = (await call!(req, quiet)) as CallToolResult;
    } catch (e) {
      forget();
      throw e;
    } finally {
      forwarding.delete(req);
    }
    let journal: JournalResult;
    let issued: { token: string; call: JournaledCall } | undefined;
    if (result.isError) {
      // The tool says it failed: nothing here can vouch for a reversal, so it is recorded as irreversible.
      journal = { entryId, undo: { kind: "none" }, effect: { summary: "The tool reported an error", uses: [] }, receipt: executeReceipt(opts.signer, { runId, entryId, callDigest: digest, outcome: "error", issuedAt: iso() }) };
    } else {
      let effect: Effect;
      try {
        effect = await tool.effect(args, result);
      } catch (e) {
        // The tool ran, but nothing can say what it changed: irreversible, and never run again for a repeat.
        const summary = `${j.name} ran, but its effect could not be described: ${(e as Error)?.message ?? String(e)}`;
        return answer(j, slot, result, { entryId, undo: { kind: "none" }, effect: { summary }, receipt: executeReceipt(opts.signer, { runId, entryId, callDigest: digest, issuedAt: iso() }) });
      }
      const receipt = executeReceipt(opts.signer, { runId, entryId, callDigest: digest, issuedAt: iso() });
      if (tool.undo.kind === "compensate") {
        const undoBy = iso(now() + tool.undo.windowSeconds! * 1000);
        const token = `ctk_${randomUUID()}`;
        issued = { token, call: { runId, entryId, tool: j.name, arguments: args, callDigest: digest, effect, undoBy, ...(j.who !== undefined ? { caller: j.who } : {}) } };
        journal = { entryId, undo: { kind: "compensate", undoBy }, compensationToken: token, effect, receipt };
      } else {
        journal = { entryId, undo: { kind: "none" }, effect, receipt };
      }
    }
    return answer(j, slot, result, journal, issued);
  }

  /**
   * Stores the answer, then gives it. A token is issued only once it is stored: if the store fails, the call is
   * answered as irreversible, since an undo that a restart would lose can't be offered (J§5.2).
   */
  function answer(j: Journaled, slot: PerformedRecord, result: CallToolResult, journal: JournalResult, issued?: { token: string; call: JournaledCall }) {
    const keepUntil = Math.max(now() + KEEP_NONE_MS, issued?.call.undoBy ? Date.parse(issued.call.undoBy) : 0);
    let out = { ...result, _meta: { ...result._meta, [JOURNAL_META]: journal } };
    try {
      store?.append({ kind: "answered", key: j.key, answer: out, keepUntil: iso(keepUntil), ...(issued ? { token: issued } : {}) });
    } catch (e) {
      if (issued) {
        const { compensationToken: _t, ...rest } = journal;
        const why = `${j.name} ran, but its undo could not be stored, so it can't be offered: ${(e as Error)?.message ?? String(e)}`;
        out = { ...result, _meta: { ...result._meta, [JOURNAL_META]: { ...rest, undo: { kind: "none" }, effect: { ...journal.effect, summary: `${journal.effect?.summary ?? j.name}. ${why}` } } } };
        issued = undefined;
      }
    }
    slot.keepUntil = keepUntil;
    if (issued) tokens.set(issued.token, { ...issued.call, keepUntil });
    return out;
  }

  const own = (token: unknown, extra: Extra) => {
    const rec = typeof token === "string" ? tokens.get(token) : undefined;
    if (!rec) return undefined;
    const who = callerOf(extra);
    if (rec.caller !== undefined && who !== rec.caller) throw fail("TXN_UNKNOWN", "this compensation token belongs to another caller");
    return rec;
  };
  const conflictOf = async (rec: JournaledCall, ifVersion: string | undefined) => {
    const tool = opts.tools[rec.tool];
    const current = await tool.currentVersion?.(rec);
    return { current, conflict: ifVersion !== undefined && current !== undefined && current !== ifVersion };
  };

  const check: RawHandler = async (req, extra) => {
    const p = (req.params ?? {}) as { runId?: string; entryId?: string; compensationToken?: string; ifVersion?: string };
    const rec = own(p.compensationToken, extra);
    if (!rec || rec.runId !== p.runId || rec.entryId !== p.entryId) throw fail("TXN_UNKNOWN", `no journaled call ${p.runId}/${p.entryId} with that token`);
    const decl = opts.tools[rec.tool].undo;
    // A reversal cut off by a restart may have happened: never report it as undoable.
    const open = !rec.done && !state.interruptedReversals.has(p.compensationToken as string) && !!rec.undoBy && Date.parse(rec.undoBy) > now();
    const { current, conflict } = await conflictOf(rec, p.ifVersion);
    const receipt = signObject<JournalReceipt>({ type: "hatp.receipt", txnId: rec.runId, branchId: rec.entryId, callDigest: rec.callDigest, phase: "check", outcome: conflict ? "conflict" : open ? "undoable" : rec.done ? "reversed" : "closed", issuedAt: iso(), issuer: id }, opts.signer);
    const result: JournalCheckResult = {
      undoable: open && !conflict, undoBy: rec.undoBy,
      conflict: conflict ? { currentVersion: current!, summary: `${rec.effect.resource ?? rec.tool} is at ${current}, not ${p.ifVersion}` } : null,
      sideEffects: decl.sideEffects ?? [], cost: (decl.cost as Money | undefined) ?? null, remedy: null, receipt,
    };
    return result;
  };
  map.set(CHECK, check);

  const previous = map.get(COMPENSATE); // serveHatp's, for transaction tokens
  map.set(COMPENSATE, async (req, extra) => {
    const p = (req.params ?? {}) as { txnId?: string; branchId?: string; planDigest?: string; compensationToken?: string; ifVersion?: string; force?: boolean };
    const rec = own(p.compensationToken, extra);
    if (!rec) {
      if (previous) return previous(req, extra);
      throw fail("TXN_UNKNOWN", "no such compensation token");
    }
    if (rec.runId !== p.txnId || rec.entryId !== p.branchId) throw fail("TXN_UNKNOWN", `the token is not for ${p.txnId}/${p.branchId}`);
    if (rec.done) return { receipt: rec.done }; // compensate is idempotent (§7.4)
    if (state.interruptedReversals.has(p.compensationToken as string)) throw fail("OUTCOME_UNKNOWN", `the reversal of ${rec.runId}/${rec.entryId} was cut off by a restart of this server before it answered`);
    // A retry while the first attempt still runs waits for it, rather than reversing twice.
    if (rec.pending) return rec.pending;
    rec.pending = reverse(rec, p.compensationToken as string, p);
    try {
      return await rec.pending;
    } finally {
      rec.pending = undefined;
    }
  });

  async function reverse(rec: TokenRecord, token: string, p: { planDigest?: string; ifVersion?: string; force?: boolean }): Promise<{ receipt: Receipt }> {
    const force = p.force === true;
    if (force && p.ifVersion !== undefined) throw fail("PLAN_INVALID", "send ifVersion or force, not both");
    if (!force && p.ifVersion === undefined) throw fail("UNDO_VERSION_REQUIRED", "a journal compensation needs ifVersion or force");
    if (typeof p.planDigest !== "string") throw fail("PLAN_INVALID", "planDigest required: the receipt binds the reversal that was approved");
    if (!rec.undoBy || Date.parse(rec.undoBy) <= now()) throw fail("UNDO_WINDOW_CLOSED", `${rec.tool} could be undone until ${rec.undoBy}`);
    const { current, conflict } = await conflictOf(rec, p.ifVersion);
    if (conflict) throw fail("UNDO_CONFLICT", `${rec.effect.resource ?? rec.tool} changed since the agent's call`, { currentVersion: current, summary: `${rec.effect.resource ?? rec.tool} is at ${current}, not ${p.ifVersion}` });
    let done: Awaited<ReturnType<NonNullable<JournaledTool["compensate"]>>>;
    try {
      store?.append({ kind: "compensating", token, at: iso() });
    } catch (e) {
      throw fail("COMPENSATION_FAILED", `could not store the reversal before running it: ${(e as Error)?.message ?? String(e)}`);
    }
    try {
      const { keepUntil: _k, done: _d, pending: _p, ...call } = rec;
      done = await opts.tools[rec.tool].compensate!(call, { ifVersion: p.ifVersion, force });
    } catch (e) {
      try { store?.append({ kind: "compensate-ended", token }); } catch { /* after a restart, a retry is refused as in doubt */ }
      if (e instanceof HatpError) throw toMcpError(e);
      throw e;
    }
    const receipt = signObject<Receipt>({
      type: "hatp.receipt", txnId: rec.runId, branchId: rec.entryId, planDigest: p.planDigest, phase: "compensate", outcome: "reversed",
      detail: { effect: { summary: done.summary, resource: rec.effect.resource, versionBefore: force ? current : p.ifVersion, version: done.version, sideEffects: done.sideEffects ?? [] } },
      issuedAt: iso(), issuer: id,
    }, opts.signer);
    try { store?.append({ kind: "compensated", token, receipt }); } catch { /* it happened; after a restart, a retry is refused as in doubt */ }
    rec.done = receipt;
    return { receipt };
  }

  return { calls: () => [...tokens.values()].map(({ done: _done, pending: _pending, keepUntil: _keep, ...c }) => c) };
}

// ---------------------------------------------------------------------------------------------
// Recorder side

export interface McpJournalServerOptions {
  /** Receives the keys a journal server advertises, so the Recorder can check its receipts. */
  keyring?: KeyRing;
  requestTimeoutMs?: number;
}

/**
 * Any MCP server, as the Recorder sees it (`createRecorder({ servers })`). A server with the `journal` role gets its
 * `undo` declarations, `check` and `compensate`; any other server is still journaled, as `unknown` (J§5.3).
 * Approvals the policy collected (J§7) travel in `_meta["ai.probita/human-gateway"].approvals`.
 */
export function mcpJournalServer(id: string, client: Client, opts: McpJournalServerOptions = {}): JournalServer {
  const cap = (client.getServerCapabilities()?.extensions?.[HUMAN_GATEWAY_EXTENSION] as { hatp?: HatpCapability } | undefined)?.hatp;
  const journal = !!cap?.roles?.includes("journal");
  const foreign = (cap?.keys ?? []).find((k) => !k.kid.startsWith(`${id}#`));
  if (foreign) throw new HatpError("INVALID_STATE", `${id} advertises key ${foreign.kid} outside its namespace`);
  if (journal) opts.keyring?.add(...(cap?.keys ?? []));
  const ops = Object.entries(cap?.operations ?? {});
  const server: JournalServer = {
    id,
    undo: journal ? Object.fromEntries(ops.flatMap(([n, o]) => (o.undo ? [[n, o.undo]] : []))) : undefined,
    amountFrom: journal ? Object.fromEntries(ops.flatMap(([n, o]) => (o.amountFrom ? [[n, o.amountFrom]] : []))) : undefined,
    async call({ tool, arguments: args, journal: ctx, approvals }) {
      let result: CallToolResult;
      try {
        result = (await client.callTool({
          name: tool, arguments: args,
          _meta: { [JOURNAL_META]: ctx, ...(approvals?.length ? { [HUMAN_GATEWAY_EXTENSION]: { approvals } } : {}) },
        }, undefined, opts.requestTimeoutMs ? { timeout: opts.requestTimeoutMs } : undefined)) as CallToolResult;
      } catch (e) {
        // An HATP error is the server's answer that it didn't perform the call. Anything else (a timeout, a lost
        // connection) is no answer, and the Recorder records the call in doubt (J§5.4).
        const code = hatpCodeOf(e);
        if (code) throw new HatpError(code, bare((e as Error).message));
        throw e;
      }
      const returned = result._meta?.[JOURNAL_META] as JournalResult | undefined;
      return { result, journal: journal ? returned : undefined };
    },
  };
  if (journal) {
    server.check = (req) => request<JournalCheckResult>(client, id, CHECK, req, opts.requestTimeoutMs);
    server.compensate = (req) => request<{ receipt: Receipt }>(client, id, COMPENSATE, req, opts.requestTimeoutMs);
  }
  return server;
}

// ---------------------------------------------------------------------------------------------
// Run Records over MCP (J§10.1)

export interface ServeJournalRunsOptions {
  /** The Recorder's signing keys, advertised so readers can verify Run Records. */
  keys: Jwk[];
  /** The Recorder's id; each key's kid must start with it and "#". */
  recorderId: string;
  /**
   * Who may read a run (J§10.1): by default the run's onBehalfOf, its policy's approvers, and auditors. Required:
   * a refusal answers `RUN_UNKNOWN`, the same as a run that doesn't exist.
   */
  authorize(run: RunRecord, extra: Extra): boolean;
}

/** Serves `hatp/journal/get` from a Recorder, and advertises the `recorder` role. */
export function serveJournalRuns(server: Server | McpServer, recorder: { get(runId: string): RunRecord }, opts: ServeJournalRunsOptions): void {
  const s = lowLevel(server);
  const foreign = opts.keys.find((k) => !k.kid.startsWith(`${opts.recorderId}#`));
  if (foreign) throw new Error(`hatp-mcp: key ${foreign.kid} is outside ${opts.recorderId}'s namespace`);
  extendCapability(s, (c) => ({ ...c, roles: c.roles.includes("recorder") ? c.roles : [...c.roles, "recorder"], keys: opts.keys.reduce(addKey, c.keys) }));
  s.setRequestHandler(z.object({ method: z.literal(GET), params: z.record(z.string(), z.unknown()) }), async ({ params }, extra) => {
    const runId = params.runId;
    let run: RunRecord | undefined;
    try {
      run = typeof runId === "string" ? recorder.get(runId) : undefined;
    } catch {
      run = undefined;
    }
    if (!run || !opts.authorize(run, extra)) throw fail("RUN_UNKNOWN", `no run ${String(runId)}, or you may not see it`);
    return { ...run };
  });
}

/** A Recorder reached over MCP: its Run Records (`hatp/journal/get`) and the keys to verify them with. */
export function mcpRecorder(id: string, client: Client, opts: { requestTimeoutMs?: number } = {}): { id: string; keys: Jwk[]; get(runId: string): Promise<RunRecord> } {
  const cap = (client.getServerCapabilities()?.extensions?.[HUMAN_GATEWAY_EXTENSION] as { hatp?: HatpCapability } | undefined)?.hatp;
  if (!cap?.roles?.includes("recorder")) throw new HatpError("NOT_SUPPORTED", `${id} does not advertise the recorder role`);
  const keys = cap.keys ?? [];
  const foreign = keys.find((k) => !k.kid.startsWith(`${id}#`));
  if (foreign) throw new HatpError("INVALID_STATE", `${id} advertises key ${foreign.kid} outside its namespace`);
  return { id, keys, get: (runId) => request<RunRecord>(client, id, GET, { runId }, opts.requestTimeoutMs) };
}
