// Shared by the HATP binding and the Human Gateway extension: HATP errors on the wire, and one hatp/* request.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { HatpError, HUMAN_GATEWAY_EXTENSION } from "hatp-protocol";
import type { HatpCode } from "hatp-protocol";
import { z } from "zod";

/** JSON-RPC error code for HATP errors; the HATP code travels in `data.hatpCode` and, for the SEP, `data.code` (spec §10.1, SEP §8). */
export const HATP_ERROR = -32050;

// HatpError and McpError both prefix their messages, and the server's McpError prefix travels
// over the wire, so the client sees it twice. Strip them all so they don't stack.
export const bare = (message: string) => message.replace(/^(MCP error -?\d+: )+/, "").replace(/^[A-Z_]+: /, "");

/** An HatpError as the JSON-RPC error a server sends. `extra` joins `data`. */
export const toMcpError = (e: HatpError, extra: Record<string, unknown> = {}) => new McpError(HATP_ERROR, bare(e.message), { hatpCode: e.code, code: e.code, ...extra });

/** The HATP code of an error a server sent, or undefined if it isn't an HATP error. */
export function hatpCodeOf(e: unknown): HatpCode | undefined {
  if (!(e instanceof McpError) || e.code !== HATP_ERROR) return undefined;
  const data = e.data as { hatpCode?: HatpCode; code?: HatpCode } | undefined;
  return data?.hatpCode ?? data?.code ?? "INVALID_STATE";
}

// The SDK merges capabilities one level deep, so two calls that each set extensions["ai.probita/human-gateway"]
// would overwrite each other. Each server's settings are kept here and merged before they are registered.
const advertised = new WeakMap<Server, Record<string, unknown>>();

/** Adds `settings` to what `s` advertises under `capabilities.extensions["ai.probita/human-gateway"]` (SEP §2). */
export function advertiseExtension(s: Server, settings: Record<string, unknown>): void {
  const merged = { ...advertised.get(s), revision: "1", ...settings };
  advertised.set(s, merged);
  s.registerCapabilities({ extensions: { [HUMAN_GATEWAY_EXTENSION]: merged } });
}

/** The extension settings this server advertises so far, for helpers that add to them. */
export function advertisedOf(s: Server): Record<string, unknown> | undefined {
  return advertised.get(s);
}

/**
 * Per server: answers a repeated journaled call (same runId and entryId) from what the journal already holds, or
 * returns undefined. Every tools/call wrapper asks it first, so a repeat is answered before anything else sees
 * it, whatever order the wrappers were installed in. A gate would otherwise refuse the repeat's approval as
 * already in use, though the first attempt ran (J§5.4).
 */
export const journalRepeats = new WeakMap<Server, (req: { params?: Record<string, unknown> }, extra: Extra) => Promise<unknown> | undefined>();

export const lowLevel = (server: Server | McpServer): Server => ("server" in server ? server.server : server);

export type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
export type RawHandler = (request: { method: string; params?: Record<string, unknown> }, extra: Extra) => Promise<unknown>;

// The SDK keeps request handlers in a private map. Wrapping the one McpServer installed is the only way to
// answer before it does: McpServer turns any error thrown by a tool into a result, and SEP §6 needs a JSON-RPC error.
export function handlers(s: Server): Map<string, RawHandler> {
  const map = (s as unknown as { _requestHandlers?: Map<string, RawHandler> })._requestHandlers;
  if (!(map instanceof Map)) throw new Error("hatp-mcp: this version of the MCP SDK does not expose request handlers; gated and journaled tools need @modelcontextprotocol/sdk 1.x");
  return map;
}

/** The extension settings a connected server advertised, or undefined. */
export function extensionOf(client: Client): Record<string, unknown> | undefined {
  return client.getServerCapabilities()?.extensions?.[HUMAN_GATEWAY_EXTENSION] as Record<string, unknown> | undefined;
}

// Sends one hatp/* request and turns HATP errors back into HatpError.
export async function request<T>(client: Client, id: string, method: string, params: object, timeout?: number): Promise<T> {
  try {
    return (await client.request({ method, params: { ...params } }, z.record(z.string(), z.unknown()), { timeout })) as T;
  } catch (e) {
    const code = hatpCodeOf(e);
    if (code) throw new HatpError(code, bare((e as Error).message));
    if (e instanceof McpError && e.code === ErrorCode.MethodNotFound) throw new HatpError("NOT_SUPPORTED", `${id}: ${method}`);
    throw e;
  }
}
