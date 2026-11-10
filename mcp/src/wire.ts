// Shared by the HATP binding and the Human Gateway extension: HATP errors on the wire, and one hatp/* request.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { HatpError } from "hatp-protocol";
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
