import type { Signer } from "./crypto.ts";
import type { HumanCard, Jwk, Requirement } from "./types.ts";
export interface HumanAddress {
    org: string;
    kind: "person" | "role" | "pool";
    name: string;
    skills: string[];
    exclude: string[];
    quorum?: {
        required: number;
        of: number;
    };
}
export declare function parseHumanAddress(address: string): HumanAddress;
export declare function signCard(card: HumanCard, issuer: Signer): HumanCard;
export interface Candidate {
    id: string;
    score: number;
    reasons: string[];
}
export interface ResolveRequest {
    address: string;
    requirement?: Requirement;
    /** Extra exclusions on top of those in the address (e.g. the plan's onBehalfOf). */
    exclude?: string[];
    deadline?: string;
    now?: number;
}
export interface ResolveResult {
    candidates: Candidate[];
    quorum: {
        required: number;
        of: number;
    };
}
export declare class Directory {
    private cards;
    private issuerKeys;
    /** Cards are only accepted when signed by one of `issuerKeys` (spec §4.2). */
    constructor(issuerKeys: Jwk[]);
    add(card: HumanCard): this;
    get(id: string): HumanCard | undefined;
    /** Update live fields (status, open asks) without re-signing; these are advisory. */
    setLive(id: string, live: {
        status?: NonNullable<HumanCard["availability"]>["status"];
        open?: number;
    }): void;
    resolve(req: ResolveRequest): ResolveResult;
}
