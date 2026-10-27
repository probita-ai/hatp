import type { KeyObject } from "node:crypto";
import type { Jwk, Plan, Signature } from "./types.ts";
/** JCS-style canonical JSON: sorted keys, no whitespace, undefined dropped. */
export declare function canonicalize(value: unknown): string;
export declare function sha256(data: string): string;
export declare function planDigest(plan: Plan): string;
export declare function hashObject(value: unknown): string;
export interface Signer {
    /** Issuer identity written into signed objects (participant URI, human:// or agent:// address). */
    id: string;
    kid: string;
    publicJwk: Jwk;
    privateKey: KeyObject;
}
export declare function createSigner(id: string, kid?: string): Signer;
/** Returns a copy of `obj` with a detached Ed25519 signature over its canonical form. */
export declare function signObject<T extends {
    signature?: Signature;
}>(obj: T, signer: Signer): T;
export declare function verifyObject(obj: {
    signature?: Signature;
}, jwk: Jwk): boolean;
/** Maps key ids to public keys so anyone can verify receipts, approvals, cards, and records. */
export declare class KeyRing {
    private keys;
    add(...jwks: Jwk[]): this;
    verify(obj: {
        signature?: Signature;
    }): boolean;
}
export declare function nonce(): string;
/** Time-ordered transaction id (sortable prefix + random suffix). */
export declare function newTxnId(): string;
