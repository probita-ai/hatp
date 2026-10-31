import assert from "node:assert/strict";
import { test } from "node:test";
import { createSigner, Directory, fetchDiscovery, gatewaysFrom, HatpError, issuerKeys, signCard, validateDiscovery, wellKnownUrl } from "../src/index.ts";
import type { OrgDiscovery } from "../src/index.ts";

const issuer = createSigner("https://directory.acme.com");
const doc = (extra: Partial<OrgDiscovery> = {}): OrgDiscovery => ({
  hatp: "0.1",
  org: "acme.com",
  issuers: [{ id: issuer.id, keys: [issuer.publicJwk] }],
  directory: { participant: "mcp://gateway.acme.com/hatp", mcp: "https://gateway.acme.com/mcp" },
  gateway: { participant: "mcp://gateway.acme.com/hatp", mcp: "https://gateway.acme.com/mcp" },
  ...extra,
});
const invalid = (e: unknown) => e instanceof HatpError && e.code === "PLAN_INVALID";

// A fetch that serves `body` and records which URL was asked for.
function serve(body: unknown, status = 200) {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked };
}

test("the document lives at https://{org}/.well-known/human-card.json", () => {
  assert.equal(wellKnownUrl("acme.com"), "https://acme.com/.well-known/human-card.json");
  assert.equal(wellKnownUrl("Acme.COM"), "https://acme.com/.well-known/human-card.json");
  assert.throws(() => wellKnownUrl("acme.com/evil?x="), invalid);
});

test("fetches, validates, and feeds a Directory and a coordinator", async () => {
  const { fetch, asked } = serve(doc());
  const d = await fetchDiscovery("acme.com", { fetch });
  assert.deepEqual(asked, ["https://acme.com/.well-known/human-card.json"]);

  // Cards signed by the published issuer are accepted; others are not.
  const directory = new Directory(issuerKeys(d));
  const card = signCard({ id: "human://acme.com/bob", displayName: "Bob", org: "acme.com", roles: ["finance-approver"], authority: [{ action: "approve.spend" }], channels: ["web"], keys: [], issuer: issuer.id }, issuer);
  directory.add(card);
  const rogue = createSigner("https://directory.acme.com");
  assert.throws(() => directory.add(signCard({ ...card, id: "human://acme.com/mallory" }, rogue)));

  assert.deepEqual(gatewaysFrom([d]), { "acme.com": "mcp://gateway.acme.com/hatp" });
});

test("a document can only speak for the host that served it", async () => {
  const { fetch } = serve(doc({ org: "evil.example" }));
  await assert.rejects(fetchDiscovery("acme.com", { fetch }), (e: HatpError) => invalid(e) && /does not match the host/.test(e.message));
});

test("rejects malformed documents", () => {
  assert.throws(() => validateDiscovery(doc({ hatp: "9" as "0.1" }), "acme.com"), invalid);
  assert.throws(() => validateDiscovery(doc({ issuers: [] }), "acme.com"), invalid);
  assert.throws(() => validateDiscovery(doc({ issuers: [{ id: issuer.id, keys: [{ ...issuer.publicJwk, crv: "P-256" as "Ed25519" }] }] }), "acme.com"), invalid);
  assert.throws(() => validateDiscovery(doc({ gateway: { participant: "mcp://gateway.acme.com/hatp", mcp: "http://gateway.acme.com/mcp" } }), "acme.com"), invalid);
  assert.throws(() => validateDiscovery("nope", "acme.com"), invalid);
});

test("an HTTP error is reported, not parsed", async () => {
  const { fetch } = serve({}, 404);
  await assert.rejects(fetchDiscovery("acme.com", { fetch }), (e: HatpError) => e.code === "TXN_UNKNOWN" && /HTTP 404/.test(e.message));
});
