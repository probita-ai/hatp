// Questions over MCP (hatp/ask/choose|form|text) and waiting through MCP Tasks (SEP §5.3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { actionDigest, createHumanGateway, createSigner, Directory, HatpError, questionDigest, signCard, verifyAnswer } from "hatp-protocol";
import type { Action, AskApproveRequest, AskQuestionRequest, HumanChannel, Question } from "hatp-protocol";
import { z } from "zod";
import { humanGatewayClientCapabilities, mcpHumanGateway, serveHumanGateway } from "../src/index.ts";

const role = "human://acme.com/role/finance-approver";
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const seat: Question = { kind: "choose", prompt: "Which flight?", options: [{ id: "ua1520", label: "UA 1520" }, { id: "dl404", label: "DL 404" }] };
const isCode = (code: string) => (e: unknown) => e instanceof HatpError && e.code === code;

/** A gateway over MCP whose one human answers after `afterMs`, or never. `tasks`: build the server with a task store. */
async function world(o: { afterMs?: number; never?: boolean; tasks?: boolean } = {}) {
  const issuer = createSigner("https://directory.acme.com");
  const directory = new Directory([issuer.publicJwk]).add(signCard({
    id: "human://acme.com/bob", displayName: "Bob", org: "acme.com", roles: ["finance-approver"],
    authority: [{ action: "approve.spend", maxAmount: { value: 10000, currency: "USD" } }],
    channels: ["web"], sla: { decideSeconds: 60 }, keys: [], issuer: issuer.id,
  }, issuer));
  const withdrawn: string[] = [];
  const wait = <T>(value: T, signal: AbortSignal, kind: string) => new Promise<T>((resolve, reject) => {
    const t = o.never ? undefined : setTimeout(() => resolve(value), o.afterMs ?? 1);
    signal.addEventListener("abort", () => { clearTimeout(t); withdrawn.push(kind); reject(new Error("withdrawn")); }, { once: true });
  });
  const channel: HumanChannel = {
    deliver: () => new Promise(() => {}),
    deliverAction: (_a, _h, signal) => wait({ decision: "approve" as const, method: "test" }, signal, "action"),
    deliverQuestion: (_a, _h, signal) => wait({ status: "answered" as const, answer: { choices: ["dl404"] }, method: "test" }, signal, "question"),
  };
  const signer = createSigner("https://gateway.acme.com");
  const gateway = createHumanGateway({ id: signer.id, signer, directory, channel });
  const server = o.tasks
    ? new McpServer({ name: "gateway", version: "0.0.0" }, { taskStore: new InMemoryTaskStore(), capabilities: { tasks: { requests: {}, list: {}, cancel: {} } } })
    : new McpServer({ name: "gateway", version: "0.0.0" });
  serveHumanGateway(server, gateway, { extension: { gatewayId: signer.id, orgs: ["acme.com"], keys: [signer.publicJwk], assurance: ["gateway-attested"] }, taskPollIntervalMs: 5 });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "agent", version: "0.0.0" }, { capabilities: humanGatewayClientCapabilities });
  await client.connect(clientSide);
  return { client, signer, withdrawn };
}

const action: Action = { type: "mcp.tools/call", server: "https://payments.example", tool: "charge_card", arguments: { amount: { value: 2140, currency: "USD" } } };
const approve = (o: Partial<AskApproveRequest> = {}): AskApproveRequest => ({ address: role, requirement: { action: "approve.spend", amountFrom: "/amount" }, action, actionDigest: actionDigest(action), decideBy: inMs(30_000), ...o });
const question = (q: Question = seat): AskQuestionRequest => ({ address: role, question: q, questionDigest: questionDigest(q), decideBy: inMs(30_000), audience: "agent://acme.com/bot" });

test("a question travels over MCP and its answer verifies against the gateway's advertised key", async () => {
  const w = await world();
  const gw = mcpHumanGateway(w.client);
  const r = await gw.askQuestion(question());
  assert.equal(r.status, "answered");
  assert.equal(verifyAnswer(r.answers[0], { gatewayKeys: gw.extension.keys, question: seat, audience: "agent://acme.com/bot" }), undefined);
});

test("each question method takes only its own kind", async () => {
  const w = await world();
  await assert.rejects(w.client.request({ method: "hatp/ask/form", params: { ...question() } }, z.record(z.string(), z.unknown())), (e: unknown) => /takes a form question/.test(String(e)));
  await assert.rejects(mcpHumanGateway(w.client).askQuestion({ ...question(), question: { kind: "vote", prompt: "?" } as unknown as Question }), isCode("NOT_SUPPORTED"));
});

test("with Tasks, the ask returns a task at once and the decision arrives through it", async () => {
  const w = await world({ afterMs: 40, tasks: true });
  const gw = mcpHumanGateway(w.client);
  const r = await gw.askApprove(approve());
  assert.equal(r.decision, "approve");
  const { tasks } = await w.client.experimental.tasks.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "completed");
  assert.equal((await gw.askQuestion(question())).status, "answered");
});

test("with Tasks, a gateway error keeps its HATP code", async () => {
  const w = await world({ tasks: true });
  const gw = mcpHumanGateway(w.client);
  await assert.rejects(gw.askApprove(approve({ action: { ...action, arguments: { amount: { value: 99_999, currency: "USD" } } }, actionDigest: actionDigest({ ...action, arguments: { amount: { value: 99_999, currency: "USD" } } }) })), isCode("AUTHORITY_INSUFFICIENT"));
});

test("cancelling the task withdraws the ask from the human", async () => {
  const w = await world({ never: true, tasks: true });
  const ctl = new AbortController();
  const p = mcpHumanGateway(w.client).askApprove(approve(), { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(p, isCode("INVALID_STATE"));
  for (let i = 0; i < 50 && !w.withdrawn.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(w.withdrawn, ["action"]);
});

test("without Tasks, cancelling the request withdraws the ask", async () => {
  const w = await world({ never: true });
  const ctl = new AbortController();
  const p = mcpHumanGateway(w.client).askQuestion(question(), { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(p, isCode("INVALID_STATE"));
  for (let i = 0; i < 50 && !w.withdrawn.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(w.withdrawn, ["question"]);
});

test("asking for a task from a gateway built without a task store is NOT_SUPPORTED", async () => {
  const w = await world();
  await assert.rejects(mcpHumanGateway(w.client, { tasks: true }).askApprove(approve()), isCode("NOT_SUPPORTED"));
});
