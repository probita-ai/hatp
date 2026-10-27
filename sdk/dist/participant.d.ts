import type { Signer } from "./crypto.ts";
import type { Branch, Jwk, Money, Participant, Plan, Tier } from "./types.ts";
export interface OperationContext {
    txnId: string;
    branchId: string;
    plan: Plan;
    branch: Branch;
    /** Set by prepare for hold-tier operations; passed back to commit/abort. */
    holdRef?: string;
}
export type PrepareOutcome = {
    ok: true;
    holdRef?: string;
    amount?: Money;
} | {
    ok: false;
    code: string;
    message: string;
};
export interface OperationHandler {
    tier: Tier;
    /** hold: place the hold. compensate/final: validate only, no effect. */
    prepare(args: Record<string, unknown>, ctx: OperationContext): Promise<PrepareOutcome>;
    /** hold: convert hold into effect. compensate/final: perform the effect. */
    commit(args: Record<string, unknown>, ctx: OperationContext): Promise<{
        compensationToken?: string;
        detail?: Record<string, unknown>;
    }>;
    /** hold: release the hold. Others: usually nothing to do. */
    abort?(args: Record<string, unknown>, ctx: OperationContext): Promise<void>;
    /** compensate tier only. */
    compensate?(token: string, ctx: OperationContext): Promise<void>;
    /** hold tier, approval-first mode: non-binding price without placing a hold. */
    quote?(args: Record<string, unknown>, ctx: OperationContext): Promise<{
        amount?: Money;
    }>;
}
export interface ResourceParticipantOptions {
    id: string;
    signer: Signer;
    operations: Record<string, OperationHandler>;
    maxLeaseSeconds?: number;
    /** Longest a hold may last from prepare, renewals included; reported as holdHorizon. Unset: renewals are uncapped. */
    maxHoldSeconds?: number;
    /** When set, commit/abort decisions must be signed by one of these coordinator keys. */
    coordinatorKeys?: Jwk[];
    now?: () => number;
}
export declare function createResourceParticipant(opts: ResourceParticipantOptions): Participant & {
    /** Exposed for demos and tests: current state of every branch this participant knows. */
    inspect(): Record<string, string>;
};
