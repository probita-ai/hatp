// Human-signed approvals with passkeys (spec §8.4).
// A passkey cannot sign an arbitrary JSON object: WebAuthn signs authenticatorData || SHA-256(clientDataJSON),
// and clientDataJSON carries a challenge. HATP makes the challenge a digest of the decision, so the
// assertion binds the human's own key to this plan, this decision and this nonce.
import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalize } from "./crypto.ts";
import type { Approval, HumanCard, Jwk, WebAuthnAssertion, WebAuthnKey } from "./types.ts";

/** What a human signs with their passkey. Everything a verifier needs to tie the assertion to one decision. */
export interface ChallengeInput {
  txnId: string;
  groupId: string;
  planDigest: string;
  decision: "approve" | "reject";
  approver: string;
  nonce: string;
}

/** base64url(SHA-256(JCS({ type: "hatp.approval.challenge", … }))). Pass its bytes as the WebAuthn challenge. */
export function approvalChallenge(c: ChallengeInput): string {
  const body = { type: "hatp.approval.challenge", txnId: c.txnId, groupId: c.groupId, planDigest: c.planDigest, decision: c.decision, approver: c.approver, nonce: c.nonce };
  return createHash("sha256").update(canonicalize(body), "utf8").digest("base64url");
}

export function isWebAuthnKey(k: Jwk | WebAuthnKey): k is WebAuthnKey {
  return (k as { use?: string }).use === "webauthn";
}

/** The passkeys on a card, if any. */
export function passkeysOf(card: HumanCard): WebAuthnKey[] {
  return card.keys.filter(isWebAuthnKey);
}

/** Builds a card key from a credential's public key, as returned by `AuthenticatorAttestationResponse.getPublicKey()` (SPKI DER). */
export function webauthnKeyFromSpki(spki: Uint8Array | string, meta: { kid: string; credentialId: string; rpId: string }): WebAuthnKey {
  const der = typeof spki === "string" ? Buffer.from(spki, "base64url") : Buffer.from(spki);
  const jwk = createPublicKey({ key: der, format: "der", type: "spki" }).export({ format: "jwk" }) as { kty: string; crv: string; x: string; y?: string };
  if (jwk.kty === "EC" && jwk.crv === "P-256") return { kid: meta.kid, kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y!, alg: "ES256", use: "webauthn", credentialId: meta.credentialId, rpId: meta.rpId };
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") return { kid: meta.kid, kty: "OKP", crv: "Ed25519", x: jwk.x, alg: "EdDSA", use: "webauthn", credentialId: meta.credentialId, rpId: meta.rpId };
  throw new Error(`unsupported passkey algorithm: ${jwk.kty}/${jwk.crv}`);
}

/** clientData.origin must be the relying party itself or one of its subdomains, over https (http only for localhost). */
function originMatches(origin: string, rpId: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const host = u.hostname;
  if (host !== rpId && !host.endsWith(`.${rpId}`)) return false;
  return u.protocol === "https:" || (u.protocol === "http:" && host === "localhost");
}

/**
 * Checks a WebAuthn assertion against a card key and the expected challenge.
 * Returns undefined when it verifies, otherwise the reason it does not.
 */
export function verifyAssertion(a: WebAuthnAssertion, key: WebAuthnKey, challenge: string): string | undefined {
  if (a.kid !== key.kid) return "assertion names another key";
  if (a.credentialId !== key.credentialId) return "assertion is from another credential";
  let client: { type?: string; challenge?: string; origin?: string; crossOrigin?: boolean };
  const clientDataJSON = Buffer.from(a.clientDataJSON, "base64url");
  try {
    client = JSON.parse(clientDataJSON.toString("utf8"));
  } catch {
    return "clientDataJSON is not JSON";
  }
  if (client.type !== "webauthn.get") return "clientData.type is not webauthn.get";
  if (client.challenge !== challenge) return "challenge does not match this decision";
  if (client.crossOrigin === true) return "assertion was made in a cross-origin frame";
  if (!client.origin || !originMatches(client.origin, key.rpId)) return `origin ${client.origin} is not ${key.rpId}`;

  const auth = Buffer.from(a.authenticatorData, "base64url");
  if (auth.length < 37) return "authenticatorData too short";
  if (!auth.subarray(0, 32).equals(createHash("sha256").update(key.rpId, "utf8").digest())) return "rpIdHash does not match";
  const flags = auth[32];
  if (!(flags & 0x01)) return "user was not present";
  if (!(flags & 0x04)) return "user was not verified";

  const signed = Buffer.concat([auth, createHash("sha256").update(clientDataJSON).digest()]);
  const sig = Buffer.from(a.signature, "base64url");
  const ok =
    key.kty === "EC"
      ? verify("sha256", signed, { key: createPublicKey({ key: { kty: "EC", crv: "P-256", x: key.x, y: key.y }, format: "jwk" }), dsaEncoding: "der" }, sig)
      : verify(null, signed, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" }), sig);
  return ok ? undefined : "passkey signature does not verify";
}

/**
 * Checks that a `human-signed` approval carries a passkey assertion from a key on the approver's card,
 * over this approval's challenge. Returns undefined when it does, otherwise the reason it does not.
 */
export function verifyHumanSignature(approval: Approval, card: HumanCard | undefined): string | undefined {
  const a = approval.authentication.webauthn;
  if (approval.authentication.assurance !== "human-signed") return "approval is not human-signed";
  if (!a) return "human-signed approval has no passkey assertion";
  if (!card || card.id !== approval.approver) return `no card for ${approval.approver}`;
  const key = passkeysOf(card).find((k) => k.kid === a.kid);
  if (!key) return `${a.kid} is not a passkey on ${approval.approver}'s card`;
  return verifyAssertion(a, key, approvalChallenge(approval));
}
