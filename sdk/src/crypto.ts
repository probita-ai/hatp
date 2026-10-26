// Canonical JSON (RFC 8785 subset), SHA-256 digests, and Ed25519 signatures (spec §8).
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Jwk, Plan, Signature } from "./types.ts";

/** JCS-style canonical JSON: sorted keys, no whitespace, undefined dropped. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v ?? null)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("base64url");
}

export function planDigest(plan: Plan): string {
  return `sha256:${sha256(canonicalize(plan))}`;
}

export function hashObject(value: unknown): string {
  return `sha256:${sha256(canonicalize(value))}`;
}

export interface Signer {
  /** Issuer identity written into signed objects (participant URI, human:// or agent:// address). */
  id: string;
  kid: string;
  publicJwk: Jwk;
  privateKey: KeyObject;
}

export function createSigner(id: string, kid = `${id}#key-1`): Signer {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return { id, kid, privateKey, publicJwk: { kid, kty: "OKP", crv: "Ed25519", x: jwk.x } };
}

function payloadOf(obj: { signature?: Signature }): Buffer {
  const { signature: _ignored, ...rest } = obj;
  return Buffer.from(canonicalize(rest), "utf8");
}

/** Returns a copy of `obj` with a detached Ed25519 signature over its canonical form. */
export function signObject<T extends { signature?: Signature }>(obj: T, signer: Signer): T {
  const sig = sign(null, payloadOf(obj), signer.privateKey).toString("base64url");
  return { ...obj, signature: { alg: "Ed25519", kid: signer.kid, sig } };
}

export function verifyObject(obj: { signature?: Signature }, jwk: Jwk): boolean {
  if (!obj.signature || obj.signature.kid !== jwk.kid) return false;
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
  return verify(null, payloadOf(obj), key, Buffer.from(obj.signature.sig, "base64url"));
}

/** Maps key ids to public keys so anyone can verify receipts, approvals, cards, and records. */
export class KeyRing {
  private keys = new Map<string, Jwk>();

  add(...jwks: Jwk[]): this {
    for (const k of jwks) this.keys.set(k.kid, k);
    return this;
  }

  verify(obj: { signature?: Signature }): boolean {
    const jwk = obj.signature && this.keys.get(obj.signature.kid);
    return !!jwk && verifyObject(obj, jwk);
  }
}

export function nonce(): string {
  return randomUUID();
}

/** Time-ordered transaction id (sortable prefix + random suffix). */
export function newTxnId(): string {
  return `txn_${Date.now().toString(36)}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}
