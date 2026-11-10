// MCP binding for HATP (spec §9): serve a Participant from an MCP server, and give the
// coordinator a Participant backed by an MCP client session.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { HatpError } from "hatp-protocol";
import type { Jwk, KeyRing, LockService, Participant, PrepareRequest, ResolveRequest, ResolveResult, Tier } from "hatp-protocol";
import { z } from "zod";
import { request, toMcpError } from "./wire.ts";

export { HATP_ERROR } from "./wire.ts";
export * from "./gateway.ts";

/** What a server advertises in `capabilities.experimental.hatp` (spec §9). */
export interface HatpCapability {
  version: "0.1";
  roles: ("participant" | "human-gateway" | "directory" | "locks")[];
  operations?: Record<string, { tier: Tier; maxLeaseSeconds?: number; maxHoldSeconds?: number }>;
  /** Each kid MUST start with the participant's URI followed by "#". */
  keys: Jwk[];
}

const METHODS = {
  prepare: "hatp/txn/prepare",
  quote: "hatp/txn/quote",
  commit: "hatp/txn/commit",
  abort: "hatp/txn/abort",
  compensate: "hatp/txn/compensate",
  renew: "hatp/txn/renew",
  estimate: "hatp/txn/estimate",
  tighten: "hatp/txn/tighten",
  status: "hatp/txn/status",
} as const;
type Method = keyof typeof METHODS;
const RESOLVE = "hatp/directory/resolve";
const LOCKS = { acquire: "hatp/lock/acquire", renew: "hatp/lock/renew", release: "hatp/lock/release" } as const;

/** What a Directory answers over MCP (spec §4.4). `Directory` from hatp-protocol fits. */
export interface Resolver {
  resolve(req: ResolveRequest): ResolveResult | Promise<ResolveResult>;
}

/** The parameters a remote agent may send; the server's clock, not the caller's, decides deadlines. */
export type RemoteResolveRequest = Omit<ResolveRequest, "now">;

export interface ServeHatpOptions {
  /** Answers hatp/directory/resolve when `capability.roles` includes "directory". Without it, resolve is NOT_SUPPORTED. */
  directory?: Resolver;
  /** Answers hatp/lock/* when `capability.roles` includes "locks" (spec §7.6). `createLockManager()` from hatp-protocol fits. */
  locks?: LockService;
}

/**
 * Makes an MCP server an HATP participant, Human Gateway or Directory: advertises the capability,
 * handles hatp/txn/* by delegating to `participant`, and hatp/directory/resolve by delegating to
 * `options.directory`. Call before connecting the server. Existing tools are untouched and stay
 * callable outside any transaction.
 *
 * Results go out as the Directory returns them. A Directory serving agents outside its
 * organisation coarsens what it returns itself (spec §4.2); the binding doesn't know who is asking.
 */
export function serveHatp(server: Server | McpServer, participant: Participant | undefined, capability: HatpCapability, options: ServeHatpOptions = {}): void {
  const s = "server" in server ? server.server : server;
  const handle = (method: string, fn: (req: Record<string, unknown>) => Promise<object>) =>
    s.setRequestHandler(z.object({ method: z.literal(method), params: z.record(z.string(), z.unknown()) }), async ({ params }) => {
      const { _meta, ...req } = params;
      try {
        return { ...(await fn(req)) };
      } catch (e) {
        if (e instanceof HatpError) throw toMcpError(e);
        throw e;
      }
    });

  s.registerCapabilities({ experimental: { hatp: { ...capability } } });
  for (const [name, method] of Object.entries(METHODS) as [Method, string][]) {
    const fn = participant?.[name] as ((req: unknown) => Promise<object>) | undefined;
    if (!fn) continue; // the client gets MethodNotFound, which it reports as NOT_SUPPORTED
    handle(method, (req) => fn.call(participant, req));
  }
  if (options.locks && capability.roles.includes("locks")) {
    const locks = options.locks;
    handle(LOCKS.acquire, async (req) => {
      if (typeof req.resource !== "string") throw new HatpError("PLAN_INVALID", "resource required");
      return locks.acquire(req as unknown as Parameters<LockService["acquire"]>[0]);
    });
    handle(LOCKS.renew, async (req) => locks.renew(req as unknown as Parameters<LockService["renew"]>[0]));
    handle(LOCKS.release, async (req) => locks.release(req as unknown as Parameters<LockService["release"]>[0]));
  }
  if (options.directory && capability.roles.includes("directory")) {
    const directory = options.directory;
    handle(RESOLVE, async (req) => {
      if (typeof req.address !== "string") throw new HatpError("PLAN_INVALID", "address required");
      const { address, requirement, exclude, deadline, assurance } = req as RemoteResolveRequest;
      return directory.resolve({ address, requirement, exclude, deadline, assurance });
    });
  }
}

export interface McpParticipantOptions {
  /** Receives the keys the server advertises, so the coordinator can verify its receipts. */
  keyring?: KeyRing;
  /** Timeout for requests other than prepare. Default: the MCP SDK's (60 s). */
  requestTimeoutMs?: number;
  /** Added to the time left until the plan deadline to get prepare's timeout. Default 30 s. */
  prepareGraceMs?: number;
}

/**
 * A Participant that sends hatp/txn/* over an MCP client session, for use with createCoordinator.
 * `id` is the participant URI used in plans. The client must already be connected.
 */
export function mcpParticipant(id: string, client: Client, opts: McpParticipantOptions = {}): Participant {
  const cap = client.getServerCapabilities()?.experimental?.hatp as HatpCapability | undefined;
  if (!cap) throw new HatpError("NOT_SUPPORTED", `${id} does not advertise the hatp capability`);
  if (cap.version !== "0.1") throw new HatpError("NOT_SUPPORTED", `${id} speaks hatp ${cap.version}`);
  // Keys are self-asserted, so a server may only vouch for kids in its own namespace;
  // otherwise it could replace another participant's key in a shared keyring.
  const foreign = (cap.keys ?? []).find((k) => !k.kid.startsWith(`${id}#`));
  if (foreign) throw new HatpError("INVALID_STATE", `${id} advertises key ${foreign.kid} outside its namespace`);
  opts.keyring?.add(...(cap.keys ?? []));

  const call = <T>(name: Method, params: object, timeout = opts.requestTimeoutMs): Promise<T> => request<T>(client, id, METHODS[name], params, timeout);
  // Prepare can take as long as the plan allows: a Human Gateway answers when the human decides.
  const prepareTimeout = (req: PrepareRequest) => Math.max(opts.requestTimeoutMs ?? 60_000, Date.parse(req.plan.deadline) - Date.now() + (opts.prepareGraceMs ?? 30_000));

  const p: Participant = {
    id,
    prepare: (req) => call("prepare", req, prepareTimeout(req)),
    commit: (req) => call("commit", req),
    abort: (req) => call("abort", req),
    // A branch that voted pending is asked again with status (spec §7.7). Servers that never vote pending needn't serve it.
    status: (req) => call("status", req),
  };
  if (cap.roles.includes("participant")) {
    p.quote = (req) => call("quote", req);
    p.renew = (req) => call("renew", req);
    p.compensate = (req) => call("compensate", req);
  }
  if (cap.roles.includes("human-gateway")) {
    p.estimate = (req) => call("estimate", req);
    p.tighten = (req) => call("tighten", req);
  }
  return p;
}

/**
 * A Directory reached over an MCP client session (spec §4.4), so an agent can look up candidate
 * humans before it builds a plan. The server must advertise the "directory" role.
 */
export function mcpDirectory(id: string, client: Client, opts: { requestTimeoutMs?: number } = {}): { id: string; resolve(req: RemoteResolveRequest): Promise<ResolveResult> } {
  const cap = client.getServerCapabilities()?.experimental?.hatp as HatpCapability | undefined;
  if (!cap?.roles.includes("directory")) throw new HatpError("NOT_SUPPORTED", `${id} does not advertise the hatp directory role`);
  return {
    id,
    resolve: ({ address, requirement, exclude, deadline, assurance }) => request<ResolveResult>(client, id, RESOLVE, { address, requirement, exclude, deadline, assurance }, opts.requestTimeoutMs),
  };
}

/** A lock service reached over an MCP client session (spec §7.6). The server must advertise the "locks" role. */
export function mcpLocks(id: string, client: Client, opts: { requestTimeoutMs?: number } = {}): LockService & { id: string } {
  const cap = client.getServerCapabilities()?.experimental?.hatp as HatpCapability | undefined;
  if (!cap?.roles.includes("locks")) throw new HatpError("NOT_SUPPORTED", `${id} does not advertise the hatp locks role`);
  return {
    id,
    acquire: (req) => request(client, id, LOCKS.acquire, req, opts.requestTimeoutMs),
    renew: (req) => request(client, id, LOCKS.renew, req, opts.requestTimeoutMs),
    release: (req) => request(client, id, LOCKS.release, req, opts.requestTimeoutMs),
  };
}
