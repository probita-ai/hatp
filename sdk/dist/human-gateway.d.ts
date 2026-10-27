import type { Signer } from "./crypto.ts";
import type { Directory } from "./directory.ts";
import type { ApprovalGroup, HumanCard, Money, Participant, Plan } from "./types.ts";
/** Decision-relevant content, always rendered from the structured plan (spec §10.3). */
export interface AskSummary {
    onBehalfOf?: string;
    initiator: string;
    deadline: string;
    decideBy: string;
    lines: {
        participant: string;
        tool: string;
        arguments: Record<string, unknown>;
        amount?: Money;
        tier: string;
    }[];
    totals: Money[];
}
export interface Ask {
    askId: string;
    txnId: string;
    groupId: string;
    planDigest: string;
    requirement: ApprovalGroup["requirement"];
    summary: AskSummary;
    /** Free text written by the agent. Channels MUST show it separately, labelled as agent-provided. */
    agentProvidedText?: string;
    routedVia: string[];
}
export interface HumanDecision {
    decision: "approve" | "reject";
    /** How the human was authenticated at decision time, e.g. "webauthn", "slack-sso". */
    method: string;
    assurance?: "human-signed" | "gateway-attested";
}
export interface HumanChannel {
    /** Deliver the ask and resolve when the human decides. Must stop waiting when `signal` aborts. */
    deliver(ask: Ask, human: HumanCard, signal: AbortSignal): Promise<HumanDecision>;
    /** Optional: tell humans how the transaction ended. */
    notify?(event: {
        txnId: string;
        groupId: string;
        outcome: "committed" | "aborted";
    }): void;
}
export interface HumanGatewayOptions {
    id: string;
    signer: Signer;
    directory: Directory;
    channel: HumanChannel;
    /** Milliseconds per SLA second. Default 1000; tests and demos shrink it. */
    msPerSecond?: number;
    now?: () => number;
    log?: (msg: string) => void;
}
export declare function summarize(plan: Plan, group: ApprovalGroup): AskSummary;
/**
 * Worst-case SLA seconds before an approval group stops waiting, assuming every human asked
 * times out: each of the `required` slots walks the escalation chain in parallel (spec §6.3).
 */
export declare function escalationWorstCase(directory: Directory, candidates: string[], required: number): number;
export declare function createHumanGateway(opts: HumanGatewayOptions): Participant & {
    /** Exposed for demos and tests: approval branches still being asked, and tightened deadlines held. */
    inspect(): {
        inflight: string[];
        cutoffs: string[];
    };
};
