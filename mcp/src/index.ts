// MCP binding for HATP (spec §9): serve a Participant from an MCP server, and give the
// coordinator a Participant backed by an MCP client session.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { HatpError } from "hatp-protocol";
import type { HatpCode, Jwk, KeyRing, Participant, PrepareRequest, Tier } from "hatp-protocol";
import { z } from "zod";

/** JSON-RPC error code for HATP errors; the HATP code travels in `data.hatpCode` (spec §10.1). */
export const HATP_ERROR = -32050;

/** What a server advertises in `capabilities.experimental.hatp` (spec §9). */
export interface HatpCapability {
  version: "0.1";
  roles: ("participant" | "human-gateway" | "directory")[];
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
} as const;
type Method = keyof typeof METHODS;

// HatpError and McpError both prefix their messages, and the server's McpError prefix travels
// over the wire, so the client sees it twice. Strip them all so they don't stack.
const bare = (message: string) => message.replace(/^(MCP error -?\d+: )+/, "").replace(/^[A-Z_]+: /, "");

/**
 * Makes an MCP server an HATP participant or Human Gateway: advertises the capability and
 * handles hatp/txn/* by delegating to `participant`. Call before connecting the server.
 * Existing tools are untouched and stay callable outside any transaction.
 */
export function serveHatp(server: Server | McpServer, participant: Participant, capability: HatpCapability): void {
  const s = "server" in server ? server.server : server;
  s.registerCapabilities({ experimental: { hatp: { ...capability } } });
  for (const [name, method] of Object.entries(METHODS) as [Method, string][]) {
    const fn = participant[name] as ((req: unknown) => Promise<object>) | undefined;
    if (!fn) continue; // the client gets MethodNotFound, which it reports as NOT_SUPPORTED
    s.setRequestHandler(z.object({ method: z.literal(method), params: z.record(z.string(), z.unknown()) }), async ({ params }) => {
      const { _meta, ...req } = params;
      try {
        return { ...(await fn.call(participant, req)) };
      } catch (e) {
        if (e instanceof HatpError) throw new McpError(HATP_ERROR, bare(e.message), { hatpCode: e.code });
        throw e;
      }
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

  const call = async <T>(name: Method, params: object, timeout = opts.requestTimeoutMs): Promise<T> => {
    try {
      return (await client.request({ method: METHODS[name], params: { ...params } }, z.record(z.string(), z.unknown()), { timeout })) as T;
    } catch (e) {
      if (e instanceof McpError && e.code === HATP_ERROR) {
        const code = (e.data as { hatpCode?: HatpCode } | undefined)?.hatpCode ?? "INVALID_STATE";
        throw new HatpError(code, bare(e.message));
      }
      if (e instanceof McpError && e.code === ErrorCode.MethodNotFound) throw new HatpError("NOT_SUPPORTED", `${id}: ${METHODS[name]}`);
      throw e;
    }
  };
  // Prepare can take as long as the plan allows: a Human Gateway answers when the human decides.
  const prepareTimeout = (req: PrepareRequest) => Math.max(opts.requestTimeoutMs ?? 60_000, Date.parse(req.plan.deadline) - Date.now() + (opts.prepareGraceMs ?? 30_000));

  const p: Participant = {
    id,
    prepare: (req) => call("prepare", req, prepareTimeout(req)),
    commit: (req) => call("commit", req),
    abort: (req) => call("abort", req),
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
