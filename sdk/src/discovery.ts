// Organisation discovery: /.well-known/human-card.json (spec §4.5). Takes an agent from
// human://acme.com/… to acme.com's Directory, Human Gateway and Human Card issuer keys.
import { HatpError } from "./types.ts";
import type { Jwk } from "./types.ts";

export interface OrgEndpoint {
  /** Participant URI used in plans and in `gateways`, e.g. "mcp://gateway.acme.com/hatp". */
  participant: string;
  /** Where to open an MCP session to it. */
  mcp?: string;
}

export interface OrgDiscovery {
  hatp: "0.1";
  /** MUST equal the host the document was fetched from. */
  org: string;
  /** Who may sign this organisation's Human Cards, with their public keys (spec §8.2). */
  issuers: { id: string; keys: Jwk[] }[];
  /** Serves hatp/directory/resolve (§4.4). */
  directory?: OrgEndpoint;
  /** Human Gateway that answers for this organisation's approval groups (§6.3). */
  gateway?: OrgEndpoint;
}

export const WELL_KNOWN_PATH = "/.well-known/human-card.json";

/** https://{org}/.well-known/human-card.json */
export function wellKnownUrl(org: string): string {
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(org)) throw new HatpError("PLAN_INVALID", `bad organisation domain: ${org}`);
  return `https://${org.toLowerCase()}${WELL_KNOWN_PATH}`;
}

/** Checks a discovery document fetched for `org`, and returns it typed. Throws PLAN_INVALID. */
export function validateDiscovery(doc: unknown, org: string): OrgDiscovery {
  const fail = (m: string): never => {
    throw new HatpError("PLAN_INVALID", `${wellKnownUrl(org)}: ${m}`);
  };
  if (!doc || typeof doc !== "object") fail("not a JSON object");
  const d = doc as OrgDiscovery;
  if (d.hatp !== "0.1") fail(`unsupported version ${String(d.hatp)}`);
  // The domain is the only thing vouching for the document, so it can only speak for itself.
  if (typeof d.org !== "string" || d.org.toLowerCase() !== org.toLowerCase()) fail(`org ${String(d.org)} does not match the host`);
  if (!Array.isArray(d.issuers) || d.issuers.length === 0) fail("at least one issuer required");
  for (const i of d.issuers) {
    if (typeof i?.id !== "string" || !Array.isArray(i.keys) || i.keys.length === 0) fail("each issuer needs an id and keys");
    for (const k of i.keys) {
      if (k?.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.x !== "string" || typeof k.kid !== "string") fail(`issuer ${i.id}: keys must be Ed25519 JWKs with a kid`);
    }
  }
  for (const [name, e] of [["directory", d.directory], ["gateway", d.gateway]] as const) {
    if (e === undefined) continue;
    if (typeof e.participant !== "string") fail(`${name}.participant required`);
    if (e.mcp !== undefined && !/^https:\/\//.test(e.mcp)) fail(`${name}.mcp must be an https URL`);
  }
  return d;
}

export interface FetchDiscoveryOptions {
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Fetches and validates an organisation's discovery document over HTTPS. */
export async function fetchDiscovery(org: string, opts: FetchDiscoveryOptions = {}): Promise<OrgDiscovery> {
  const url = wellKnownUrl(org);
  const res = await (opts.fetch ?? fetch)(url, { headers: { accept: "application/json" }, redirect: "error" });
  if (!res.ok) throw new HatpError("TXN_UNKNOWN", `${url}: HTTP ${res.status}`);
  return validateDiscovery(await res.json(), org);
}

/** Every issuer key in the document, for `new Directory(...)` or a KeyRing. */
export function issuerKeys(doc: OrgDiscovery): Jwk[] {
  return doc.issuers.flatMap((i) => i.keys);
}

/** The `gateways` map createCoordinator takes, from the documents of the organisations a plan names. */
export function gatewaysFrom(docs: OrgDiscovery[]): Record<string, string> {
  return Object.fromEntries(docs.filter((d) => d.gateway).map((d) => [d.org, d.gateway!.participant]));
}
