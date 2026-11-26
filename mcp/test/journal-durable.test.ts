// A journal participant that restarts (J§5.2, #126): with a JournalFileStore, a repeat after the restart gets the
// first answer and never runs the tool again, earlier calls can still be undone, and a call or reversal cut off by
// the restart is refused rather than repeated, so the Recorder records it in doubt.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRecorder, createSigner, KeyRing } from "hatp-protocol";
import type { JournalEntry, JournalServer, JournalResult } from "hatp-protocol";
import { z } from "zod";
import { JournalFileStore, journalState, journalTools, mcpJournalServer, readJournalStore } from "../src/index.ts";
import type { JournalStore, JournalStoreItem } from "../src/index.ts";
import { hatpCodeOf } from "../src/wire.ts";

const id = "mcp://pay.acme.com/hatp";
const signer = createSigner(id);
const dir = () => mkdtempSync(join(tmpdir(), "hatp-journal-"));

/** The world outside the participant: it outlives restarts. */
function world() {
  return { charged: 0, refunded: 0, version: "v1", hang: undefined as Promise<void> | undefined, onCall: () => {}, compensateHang: undefined as Promise<void> | undefined, now: Date.now };
}
type World = ReturnType<typeof world>;

/** One run of the participant process, over the store at `path` (recovered if it exists). */
async function participant(w: World, store: JournalStore & { path?: string }, recover = true) {
  const s = new McpServer({ name: "pay", version: "0" });
  s.registerTool("charge", { inputSchema: { amount: z.number() } }, async () => {
    w.charged++;
    w.onCall();
    if (w.hang) await w.hang;
    return { content: [{ type: "text", text: "charged" }] };
  });
  s.registerTool("email", { inputSchema: { to: z.string() } }, async () => ({ content: [{ type: "text", text: "sent" }] }));
  s.registerTool("flaky", { inputSchema: {} }, async () => { throw new Error("backend down"); });
  const state = journalState({ store, recover: recover && store.path ? readJournalStore(store.path) : undefined, now: () => w.now() });
  journalTools(s, {
    signer, state, now: () => w.now(),
    tools: {
      charge: {
        undo: { kind: "compensate", windowSeconds: 3 * 24 * 3600 },
        effect: () => ({ summary: "charged", resource: "pay://c/1", version: w.version, uses: [] }),
        currentVersion: () => w.version,
        compensate: async () => { w.refunded++; if (w.compensateHang) await w.compensateHang; w.version = "v2"; return { summary: "refunded", version: "v2" }; },
      },
      email: { undo: { kind: "none", reason: "an email can't be unsent" }, effect: () => ({ summary: "sent", uses: [] }) },
      flaky: { undo: { kind: "none", reason: "test" }, effect: () => ({ summary: "never", uses: [] }) },
    },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.connect(b);
  const client = new Client({ name: "rec", version: "0" });
  await client.connect(a);
  return { client, state };
}

const meta = (runId: string, entryId: string) => ({ "hatp/journal": { runId, entryId, seq: Number(entryId.slice(1)), recorder: "mcp://rec.acme.com/hatp" } });
const call = (c: Client, entryId: string, args: Record<string, unknown> = { amount: 10 }, tool = "charge") => c.callTool({ name: tool, arguments: args, _meta: meta("run-1", entryId) });
const journalOf = (r: Awaited<ReturnType<typeof call>>) => (r._meta as Record<string, unknown>)["hatp/journal"] as JournalResult;
const compensate = (c: Client, token: string, entryId = "e1") => c.request({ method: "hatp/txn/compensate", params: { txnId: "run-1", branchId: entryId, planDigest: "sha256:plan", compensationToken: token, ifVersion: "v1" } }, z.record(z.string(), z.unknown()));
const check = (c: Client, token: string, entryId = "e1") => c.request({ method: "hatp/journal/check", params: { runId: "run-1", entryId, compensationToken: token, ifVersion: "v1" } }, z.record(z.string(), z.unknown()));
const codeOf = async (p: Promise<unknown>) => { try { await p; return "answered"; } catch (e) { return hatpCodeOf(e) ?? `not an HATP error: ${String(e)}`; } };

test("a repeat after a restart gets the first answer, token included, and the tool runs once", async () => {
  const w = world();
  const store = new JournalFileStore(join(dir(), "journal.jsonl"));
  const first = journalOf(await call((await participant(w, store)).client, "e1"));
  const again = journalOf(await call((await participant(w, store)).client, "e1"));
  assert.equal(w.charged, 1);
  assert.equal(again.compensationToken, first.compensationToken);
  assert.deepEqual(again.receipt, first.receipt);
  assert.equal(await codeOf(call((await participant(w, store)).client, "e1", { amount: 99 })), "PLAN_INVALID", "other arguments are still refused");
});

test("a call made before a restart can still be checked and undone after it, and the undo is answered once", async () => {
  const w = world();
  const store = new JournalFileStore(join(dir(), "journal.jsonl"));
  const token = journalOf(await call((await participant(w, store)).client, "e1")).compensationToken!;
  const p2 = (await participant(w, store)).client;
  assert.equal((await check(p2, token)).undoable, true);
  const { receipt } = await compensate(p2, token);
  const p3 = (await participant(w, store)).client;
  assert.deepEqual((await compensate(p3, token)).receipt, receipt, "a repeat after another restart gets the same receipt");
  assert.equal(w.refunded, 1);
  assert.equal((await check(p3, token)).undoable, false);
});

test("a call cut off by a restart is refused, not run again, and the Recorder records it in doubt", async () => {
  const w = world();
  const store = new JournalFileStore(join(dir(), "journal.jsonl"));
  w.hang = new Promise(() => {}); // the first process never finishes the call
  const before = mcpJournalServer(id, (await participant(w, store)).client, { requestTimeoutMs: 40 });
  let live: JournalServer = before;
  w.onCall = () => { void participant({ ...w, hang: undefined }, store).then((p) => { live = mcpJournalServer(id, p.client); }); };
  const keyring = new KeyRing();
  keyring.add(signer.publicJwk);
  const rs = createSigner("mcp://rec.acme.com/hatp");
  const recorder = createRecorder({ id: rs.id, signer: rs, keyring, servers: () => ({ ...before, call: (r) => live.call(r) }), inDoubt: { retries: 2, retryMs: 5, timeoutMs: 1000 } });
  const runId = recorder.startRun({ agent: "agent://acme.com/bot", onBehalfOf: "human://acme.com/dana" });
  // An in-doubt call answers the agent with the transport error, carrying the entry (J§5.4).
  const err = await recorder.call(runId, { participant: id, tool: "charge", arguments: { amount: 10 } }).then(() => undefined, (e: { entry?: JournalEntry }) => e);
  const entry = err!.entry!;
  assert.equal(w.charged, 1, "never charged again");
  assert.equal(entry.outcome, "in-doubt");
  assert.match(entry.reason ?? "", /cut off by a restart/);
});

test("a reversal cut off by a restart answers OUTCOME_UNKNOWN, and check no longer offers it", async () => {
  const w = world();
  const store = new JournalFileStore(join(dir(), "journal.jsonl"));
  const p1 = (await participant(w, store)).client;
  const token = journalOf(await call(p1, "e1")).compensationToken!;
  w.compensateHang = new Promise(() => {});
  void compensate(p1, token).catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  w.compensateHang = undefined;
  await p1.close(); // the first process is gone
  const p2 = (await participant(w, store)).client;
  assert.equal(await codeOf(compensate(p2, token)), "OUTCOME_UNKNOWN");
  assert.equal((await check(p2, token)).undoable, false);
  assert.equal(w.refunded, 1, "never refunded twice");
});

test("a tool that throws is answered as an error result: stored like any answer, so a repeat after a restart never runs it", async () => {
  const w = world();
  const store = new JournalFileStore(join(dir(), "journal.jsonl"));
  const p1 = (await participant(w, store)).client;
  // McpServer turns the throw into an isError result, which is an answer: recorded as irreversible, not forgotten.
  assert.equal((journalOf(await call(p1, "e1", {}, "flaky")).receipt as { outcome?: string }).outcome, "error");
  assert.deepEqual(readJournalStore(store.path).map((i) => i.kind), ["started", "answered"]);
  assert.equal((journalOf(await call((await participant(w, store)).client, "e1", {}, "flaky")).receipt as { outcome?: string }).outcome, "error");
});

test("a store that can't write: the call is refused before it runs, or answered without an undo it can't keep", async () => {
  const w = world();
  let failOn: JournalStoreItem["kind"] | undefined = "started";
  const store: JournalStore = { append: (i) => { if (i.kind === failOn) throw new Error("disk full"); } };
  const p = await participant(w, store, false);
  assert.equal(await codeOf(call(p.client, "e1")), "INVALID_STATE");
  assert.equal(w.charged, 0, "not run");
  failOn = "answered";
  const j = journalOf(await call(p.client, "e2"));
  assert.equal(w.charged, 1);
  assert.equal(j.undo.kind, "none");
  assert.equal(j.compensationToken, undefined);
  assert.match(j.effect?.summary ?? "", /its undo could not be stored/);
  assert.equal(p.state.tokens.size, 0);
  assert.deepEqual(journalOf(await call(p.client, "e2")), j, "a repeat gets the same answer");
  assert.equal(w.charged, 1);
});

test("recovery drops what has expired and rewrites the store; a torn last line is skipped", async () => {
  const w = world();
  const path = join(dir(), "journal.jsonl");
  const store = new JournalFileStore(path);
  const p1 = (await participant(w, store)).client;
  w.version = "v1";
  await call(p1, "e1", { to: "a@b.c" }, "email"); // a none call: kept 24 hours
  // A compensate call with a 3-day window: kept until it closes.
  const start = w.now();
  w.now = () => start;
  appendFileSync(path, '{"kind":"started","key":"[\\"run-1\\",\\"e3\\"]","TORN');
  const p2 = await participant(w, store);
  assert.ok(!readFileSync(path, "utf8").includes("TORN"), "the torn line is gone");
  await call(p2.client, "e2");
  w.now = () => start + 25 * 3600_000;
  const p3 = await participant(w, store);
  assert.equal(p3.state.performed.size, 1, "the email is forgotten after 24 hours, the charge is not");
  assert.equal(p3.state.tokens.size, 1, "the charge can still be undone: its window is open");
  assert.deepEqual(readJournalStore(path).map((i) => i.kind), ["started", "answered"], "the store was rewritten without the email");
  w.now = () => start + 4 * 24 * 3600_000;
  const p4 = await participant(w, store);
  assert.equal(p4.state.performed.size + p4.state.tokens.size, 0, "everything has expired");
  assert.equal(readFileSync(path, "utf8"), "");
  writeFileSync(path, "");
});

test("a cut-off call is remembered as long as its answer would be: with a 3-day window, still refused after 25 hours", async () => {
  const w = world();
  const store = new JournalFileStore(join(dir(), "journal.jsonl"));
  w.hang = new Promise(() => {});
  const p1 = (await participant(w, store)).client;
  void call(p1, "e1").catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  await p1.close();
  w.hang = undefined;
  const start = Date.now();
  w.now = () => start + 25 * 3600_000;
  assert.equal(await codeOf(call((await participant(w, store)).client, "e1")), "OUTCOME_UNKNOWN");
  assert.equal(w.charged, 1);
});
