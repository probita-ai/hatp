// The Human Gateway extension over MCP (spec/sep/0000-human-gateway.md): a gateway that serves
// hatp/ask/approve and Human Cards as resources, its requester side, and approval-gated tools.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ErrorCode, ListResourcesRequestSchema, McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, ServerNotification, ServerRequest, Tool } from "@modelcontextprotocol/sdk/types.js";
import { HatpError, HUMAN_GATEWAY_EXTENSION, verifyObject } from "hatp-protocol";
import type { ActionApproval, ApprovalGate, AskApproveRequest, AskApproveResult, AskContext, AskQuestionRequest, AskQuestionResult, Assurance, HatpCode, HumanCard, Jwk, Payment, PaymentTerms, Question, QuestionKind, Requires } from "hatp-protocol";
import { z } from "zod";
import { bare, hatpCodeOf, request, toMcpError } from "./wire.ts";

export { HUMAN_GATEWAY_EXTENSION } from "hatp-protocol";

const ASK_APPROVE = "hatp/ask/approve";
const QUESTION_KINDS = ["choose", "form", "text"] as const satisfies readonly QuestionKind[];
/** MIME type of a Human Card resource (SEP §3.2). */
export const HUMAN_CARD_MIME = "application/vnd.hatp.human-card+json";

/** What a Human Gateway advertises in `capabilities.extensions` (SEP §2). */
export interface HumanGatewayExtension {
  revision: "1";
  gatewayId: string;
  orgs: string[];
  /** Each kid MUST start with `gatewayId` followed by "#". */
  keys: Jwk[];
  assurance: Assurance[];
}

/** What a gated server advertises in `capabilities.extensions` (SEP §2). */
export interface GatedServerExtension {
  revision: "1";
  serverId: string;
  trustedGateways: string[];
}

/** Client capabilities a requester passes to `new Client(...)`, so gateways accept its asks (SEP §2). */
export const humanGatewayClientCapabilities = { extensions: { [HUMAN_GATEWAY_EXTENSION]: {} } };

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type RawHandler = (request: { method: string; params?: Record<string, unknown> }, extra: Extra) => Promise<unknown>;

const lowLevel = (server: Server | McpServer): Server => ("server" in server ? server.server : server);

// The SDK keeps request handlers in a private map. Wrapping the one McpServer installed is the only way to
// answer before it does: McpServer turns any error thrown by a tool into a result, and SEP §6 needs a JSON-RPC error.
function handlers(s: Server): Map<string, RawHandler> {
  const map = (s as unknown as { _requestHandlers?: Map<string, RawHandler> })._requestHandlers;
  if (!(map instanceof Map)) throw new Error("hatp-mcp: this version of the MCP SDK does not expose request handlers; gated tools need @modelcontextprotocol/sdk 1.x");
  return map;
}

function checkKeys(owner: string, keys: Jwk[]) {
  const foreign = keys.find((k) => !k.kid.startsWith(`${owner}#`));
  if (foreign) throw new HatpError("INVALID_STATE", `${owner} advertises key ${foreign.kid} outside its namespace`);
}

// ---------------------------------------------------------------------------------------------
// Gateway side

/** The gateway a server delegates to. `createHumanGateway` from hatp-protocol fits. */
export interface AskHandler {
  askApprove(req: AskApproveRequest, ctx?: AskContext): Promise<AskApproveResult>;
  askQuestion?(req: AskQuestionRequest, ctx?: AskContext): Promise<AskQuestionResult>;
}

export interface ServeHumanGatewayOptions {
  extension: Omit<HumanGatewayExtension, "revision">;
  /** How often requesters should poll a task, in ms. Default 1000. Tasks need the server built with a `taskStore`. */
  taskPollIntervalMs?: number;
  /** Cards to serve as resources, as their issuer signed them. `Directory` from hatp-protocol fits. */
  cards?: { list(): HumanCard[] };
  /**
   * Who sent the request, from what the transport authenticated (`extra.authInfo`, a session). That person
   * never approves their own ask (SEP §5.2, step 2). Without it the gateway can only apply the address's `exclude`.
   */
  principal?(extra: Extra): string | undefined;
}

/**
 * Makes an MCP server a Human Gateway (SEP §2–§5, spec/hatp-asks.md): advertises the extension, answers
 * `hatp/ask/approve` and `hatp/ask/{choose,form,text}` by delegating to `gateway`, and serves `options.cards`
 * as `human://` resources. Call before connecting.
 *
 * Waiting (SEP §5.3): a request with `params.task` returns a task at once and completes it when the humans
 * decide, if the server was built with a `taskStore` and a `tasks` capability; cancelling the task withdraws the
 * asks. Without `params.task` the request stays open, and cancelling the request withdraws the asks.
 */
export function serveHumanGateway(server: Server | McpServer, gateway: AskHandler, options: ServeHumanGatewayOptions): void {
  const s = lowLevel(server);
  checkKeys(options.extension.gatewayId, options.extension.keys);
  s.registerCapabilities({ extensions: { [HUMAN_GATEWAY_EXTENSION]: { revision: "1", ...options.extension } } });
  const pollInterval = options.taskPollIntervalMs ?? 1000;

  const serve = (method: string, run: (req: Record<string, unknown>, ctx: AskContext) => Promise<object>) =>
    s.setRequestHandler(z.object({ method: z.literal(method), params: z.record(z.string(), z.unknown()) }), async ({ params }, extra) => {
      try {
        // A gateway MUST NOT accept asks from a client that did not negotiate the extension (SEP §2).
        if (!s.getClientCapabilities()?.extensions?.[HUMAN_GATEWAY_EXTENSION]) throw new HatpError("NOT_SUPPORTED", `the client did not declare ${HUMAN_GATEWAY_EXTENSION}`);
        const { _meta, task, ...req } = params;
        const principal = options.principal?.(extra);
        if (!task) return { ...(await run(req, { principal, signal: extra.signal })) };

        const store = extra.taskStore;
        if (!store) throw new HatpError("NOT_SUPPORTED", "this gateway was built without a taskStore");
        const created = await store.createTask({ ttl: extra.taskRequestedTtl ?? null, pollInterval });
        const ctl = new AbortController();
        // The SDK marks a cancelled task in the store and tells no one, so watch for it while humans decide.
        const watch = setInterval(() => {
          store.getTask(created.taskId).then((t) => { if (t.status === "cancelled") ctl.abort(); }, () => ctl.abort());
        }, pollInterval);
        watch.unref?.();
        run(req, { principal, signal: ctl.signal })
          .then(
            (result) => store.storeTaskResult(created.taskId, "completed", { ...result }),
            (e) => store.storeTaskResult(created.taskId, "failed", { hatpError: e instanceof HatpError ? { code: e.code, message: bare(e.message) } : { code: "INVALID_STATE", message: String((e as Error)?.message ?? e) } }),
          )
          .catch(() => {}) // a cancelled task is terminal and refuses a result; nothing is waiting for it
          .finally(() => clearInterval(watch));
        return { task: created };
      } catch (e) {
        if (e instanceof HatpError) throw toMcpError(e);
        throw e;
      }
    });

  serve(ASK_APPROVE, (req, ctx) => gateway.askApprove(req as unknown as AskApproveRequest, ctx));
  for (const kind of QUESTION_KINDS) {
    serve(`hatp/ask/${kind}`, async (req, ctx) => {
      if (!gateway.askQuestion) throw new HatpError("NOT_SUPPORTED", "this gateway does not ask questions");
      const q = req.question as Question | undefined;
      if (q?.kind !== kind) throw new HatpError("PLAN_INVALID", `hatp/ask/${kind} takes a ${kind} question`);
      return gateway.askQuestion(req as unknown as AskQuestionRequest, ctx);
    });
  }

  if (!options.cards) return;
  const cards = options.cards;
  const resource = (c: HumanCard) => ({ uri: c.id, name: c.id, title: c.displayName, mimeType: HUMAN_CARD_MIME });
  const read = (uri: string) => {
    const card = cards.list().find((c) => c.id === uri);
    if (!card) throw new McpError(-32002, `no card ${uri}`); // resource not found
    return { contents: [{ uri, mimeType: HUMAN_CARD_MIME, text: JSON.stringify(card) }] };
  };
  if (server instanceof McpServer) {
    server.registerResource("human-cards", new ResourceTemplate("human://{org}/{name}", { list: () => ({ resources: cards.list().map(resource) }) }), { mimeType: HUMAN_CARD_MIME, description: "Human Cards: who may decide what, without contact details" }, (uri) => read(uri.href));
  } else {
    s.registerCapabilities({ resources: {} });
    s.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: cards.list().map(resource) }));
    s.setRequestHandler(ReadResourceRequestSchema, ({ params }) => read(params.uri));
  }
}

// ---------------------------------------------------------------------------------------------
// Requester side

export interface McpHumanGatewayOptions {
  /** Keys of the issuers whose cards to accept. Without them, `cards()` refuses to return any (SEP §3.2). */
  issuerKeys?: Jwk[];
  /** Added to the time left until decideBy to get the ask's timeout. Default 30 s. */
  askGraceMs?: number;
  /**
   * Wait through MCP Tasks instead of holding the request open (SEP §5.3): the ask returns a task at once and
   * the client polls it. Default: when the gateway advertises a `tasks` capability.
   */
  tasks?: boolean;
}

/** Per-ask options. Aborting `signal` withdraws the ask: the request, or the task, is cancelled. */
export interface AskOptions {
  signal?: AbortSignal;
}

export interface McpHumanGateway {
  /** The extension settings the gateway advertised: its id, orgs and signing keys. */
  extension: HumanGatewayExtension;
  /** Asks for approval of one tool call and waits for the decision. A rejection is a result, not an error. */
  askApprove(req: AskApproveRequest, o?: AskOptions): Promise<AskApproveResult>;
  /** Asks a question (`hatp/ask/choose`, `form` or `text`, from `question.kind`). Everyone declining is a result. */
  askQuestion(req: AskQuestionRequest, o?: AskOptions): Promise<AskQuestionResult>;
  /** The gateway's Human Cards, each checked against `issuerKeys`. Cards that don't verify are listed in `rejected`. */
  cards(): Promise<{ cards: HumanCard[]; rejected: string[] }>;
}

/** A Human Gateway reached over an MCP client session. The client must declare `humanGatewayClientCapabilities`. */
export function mcpHumanGateway(client: Client, opts: McpHumanGatewayOptions = {}): McpHumanGateway {
  const ext = client.getServerCapabilities()?.extensions?.[HUMAN_GATEWAY_EXTENSION] as HumanGatewayExtension | undefined;
  if (!ext?.gatewayId) throw new HatpError("NOT_SUPPORTED", `the server does not advertise ${HUMAN_GATEWAY_EXTENSION} as a gateway`);
  checkKeys(ext.gatewayId, ext.keys ?? []);
  const gatewayId = ext.gatewayId;
  const useTasks = opts.tasks ?? !!client.getServerCapabilities()?.tasks;
  const grace = opts.askGraceMs ?? 30_000;

  async function ask<T>(method: string, req: { decideBy: string }, o: AskOptions = {}): Promise<T> {
    // Requesters MUST NOT apply a short default timeout: humans take as long as decideBy allows (SEP §5.3).
    const timeout = Math.max(60_000, Date.parse(req.decideBy) - Date.now() + grace);
    if (!useTasks) return requestWithSignal<T>(method, req, timeout, o.signal);
    if (!client.getServerCapabilities()?.tasks) throw new HatpError("NOT_SUPPORTED", `${gatewayId} does not advertise tasks`);

    const { task } = await request<{ task: { taskId: string; pollInterval?: number } }>(client, gatewayId, method, { ...req, task: {} });
    const tasks = client.experimental.tasks;
    const giveUp = Date.now() + timeout;
    let cancelled = false;
    const cancel = () => { cancelled = true; tasks.cancelTask(task.taskId).catch(() => {}); };
    o.signal?.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        if (cancelled) throw new HatpError("INVALID_STATE", "the ask was withdrawn by the requester");
        const t = await tasks.getTask(task.taskId);
        if (t.status === "completed" || t.status === "failed") {
          const r = (await tasks.getTaskResult(task.taskId, z.record(z.string(), z.unknown()))) as Record<string, unknown>;
          const { _meta, ...result } = r;
          const err = result.hatpError as { code: HatpCode; message: string } | undefined;
          if (t.status === "failed") throw new HatpError(err?.code ?? "INVALID_STATE", err?.message ?? "the ask failed");
          return result as T;
        }
        if (t.status === "cancelled") throw new HatpError("INVALID_STATE", "the ask was cancelled");
        if (Date.now() > giveUp) throw new HatpError("DEADLINE_EXCEEDED", "no decision by decideBy");
        await new Promise((r) => setTimeout(r, t.pollInterval ?? task.pollInterval ?? 1000));
      }
    } finally {
      o.signal?.removeEventListener("abort", cancel);
    }
  }

  // An aborted MCP request sends notifications/cancelled, which aborts the handler's signal on the gateway.
  async function requestWithSignal<T>(method: string, params: object, timeout: number, signal?: AbortSignal): Promise<T> {
    try {
      return (await client.request({ method, params: { ...params } }, z.record(z.string(), z.unknown()), { timeout, signal })) as T;
    } catch (e) {
      if (signal?.aborted) throw new HatpError("INVALID_STATE", "the ask was withdrawn by the requester");
      const code = hatpCodeOf(e);
      if (code) throw new HatpError(code, bare((e as Error).message));
      if (e instanceof McpError && e.code === ErrorCode.MethodNotFound) throw new HatpError("NOT_SUPPORTED", `${gatewayId}: ${method}`);
      throw e;
    }
  }

  return {
    extension: ext,
    askApprove: (req, o) => ask<AskApproveResult>(ASK_APPROVE, req, o),
    askQuestion: (req, o) => ask<AskQuestionResult>(`hatp/ask/${req.question?.kind}`, req, o),
    async cards() {
      const cards: HumanCard[] = [];
      const rejected: string[] = [];
      const { resources } = await client.listResources();
      for (const r of resources.filter((x) => x.mimeType === HUMAN_CARD_MIME)) {
        const { contents } = await client.readResource({ uri: r.uri });
        const text = contents[0] && "text" in contents[0] ? contents[0].text : undefined;
        let card: HumanCard | undefined;
        try {
          card = text ? (JSON.parse(text) as HumanCard) : undefined;
        } catch {
          card = undefined;
        }
        if (card && card.id === r.uri && (opts.issuerKeys ?? []).some((k) => verifyObject(card, k))) cards.push(card);
        else rejected.push(r.uri);
      }
      return { cards, rejected };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Gated tools

export interface GatedTool {
  requires: Requires;
  /** For a paid tool: what this call will charge. The approved payment must cover it (SEP §6.1). */
  terms?(args: Record<string, unknown>): PaymentTerms | undefined | Promise<PaymentTerms | undefined>;
}

export interface GateToolsOptions {
  /** `createApprovalGate` from hatp-protocol, with this server's serverId and trusted gateways. */
  gate: ApprovalGate;
  extension: Omit<GatedServerExtension, "revision">;
  /** Tool name → what it requires. Tools not listed run as before. */
  tools: Record<string, GatedTool>;
}

/**
 * Makes tools on an McpServer require Approvals (SEP §6). Call after registering the tools and before
 * connecting. tools/list carries each gated tool's `requires` in `_meta`; tools/call checks the Approvals in
 * `params._meta` before the tool runs and answers -32050 APPROVAL_REQUIRED or APPROVAL_INVALID if they fail.
 * A nonce is consumed only when the tool runs and returns without `isError`.
 */
export function gateTools(server: McpServer, opts: GateToolsOptions): void {
  const s = server.server;
  const map = handlers(s);
  const call = map.get("tools/call");
  const list = map.get("tools/list");
  if (!call || !list) throw new Error("hatp-mcp: register the tools before gating them");
  if (opts.extension.serverId === undefined) throw new Error("hatp-mcp: extension.serverId required");
  s.registerCapabilities({ extensions: { [HUMAN_GATEWAY_EXTENSION]: { revision: "1", ...opts.extension } } });

  map.set("tools/list", async (req, extra) => {
    const result = (await list(req, extra)) as { tools: Tool[] };
    return {
      ...result,
      tools: result.tools.map((t) => {
        const g = opts.tools[t.name];
        return g ? { ...t, _meta: { ...t._meta, [HUMAN_GATEWAY_EXTENSION]: { requires: g.requires } } } : t;
      }),
    };
  });

  const running = new Set<string>(); // nonces of calls in progress, so two concurrent calls can't share one approval
  map.set("tools/call", async (req, extra) => {
    const name = req.params?.name;
    const gated = typeof name === "string" ? opts.tools[name] : undefined;
    if (!gated) return call(req, extra);
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    const meta = ((req.params?._meta as Record<string, unknown> | undefined)?.[HUMAN_GATEWAY_EXTENSION] ?? {}) as { approvals?: ActionApproval[]; payment?: Payment };
    const approvals = Array.isArray(meta.approvals) ? meta.approvals : [];
    let nonces: string[];
    try {
      const listed = ((await list({ method: "tools/list", params: {} }, extra)) as { tools: Tool[] }).tools.find((t) => t.name === name);
      const toolDefinition = listed && { name: listed.name, description: listed.description, inputSchema: listed.inputSchema, annotations: listed.annotations };
      ({ nonces } = opts.gate.check({ tool: name as string, arguments: args, requires: gated.requires, approvals, toolDefinition, payment: meta.payment, terms: await gated.terms?.(args) }));
      if (nonces.some((n) => running.has(n))) throw new HatpError("APPROVAL_INVALID", "this approval is being used by another call");
    } catch (e) {
      if (e instanceof HatpError) throw toMcpError(e, e.code === "APPROVAL_REQUIRED" ? { requires: gated.requires } : {});
      throw e;
    }
    for (const n of nonces) running.add(n);
    try {
      const result = (await call(req, extra)) as CallToolResult;
      if (!result.isError) opts.gate.consume(nonces, approvals);
      return result;
    } finally {
      for (const n of nonces) running.delete(n);
    }
  });
}

/** What a gated tool requires, from its tools/list entry, or undefined for an ungated tool. */
export function requiresOf(tool: Pick<Tool, "_meta">): Requires | undefined {
  return (tool._meta?.[HUMAN_GATEWAY_EXTENSION] as { requires?: Requires } | undefined)?.requires;
}

/** Refusal of a gated tool call. For APPROVAL_REQUIRED, `requires` says whom to ask. */
export class GatedToolError extends HatpError {
  requires?: Requires;
  constructor(code: HatpError["code"], message: string, requires?: Requires) {
    super(code, message);
    this.requires = requires;
  }
}

/** Calls a gated tool with its Approvals (and, for a paid tool, the approved payment) in `_meta` (SEP §6). */
export async function callGatedTool(client: Client, call: { name: string; arguments: Record<string, unknown>; approvals?: ActionApproval[]; payment?: Payment }): Promise<CallToolResult> {
  try {
    return (await client.callTool({ name: call.name, arguments: call.arguments, _meta: { [HUMAN_GATEWAY_EXTENSION]: { approvals: call.approvals ?? [], ...(call.payment ? { payment: call.payment } : {}) } } })) as CallToolResult;
  } catch (e) {
    const code = hatpCodeOf(e);
    if (code) throw new GatedToolError(code, bare((e as Error).message), ((e as McpError).data as { requires?: Requires } | undefined)?.requires);
    throw e;
  }
}
