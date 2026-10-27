import type { KeyRing, Signer } from "./crypto.ts";
import type { Participant, Plan, TransactionRecord, TxnEvent } from "./types.ts";
/** Durable decision log. The decision MUST be appended before any phase-2 message (spec §6.1). */
export interface TxnLog {
    append(txnId: string, event: TxnEvent): void;
}
export declare class MemoryLog implements TxnLog {
    entries: {
        txnId: string;
        event: TxnEvent;
    }[];
    append(txnId: string, event: TxnEvent): void;
}
/** Appends one JSON line per event with a synchronous write, so a crash cannot lose a logged decision. */
export declare class FileLog implements TxnLog {
    path: string;
    constructor(path: string);
    append(txnId: string, event: TxnEvent): void;
}
export interface CoordinatorOptions {
    id: string;
    signer: Signer;
    /** Looks up a participant by the URI used in plans. A JSON-RPC/MCP client can stand behind this. */
    participants: (id: string) => Participant | undefined;
    /** Human Gateway participant id per organisation (spec §6.3). */
    gateways?: Record<string, string>;
    /** When given, every receipt and approval must verify against it. */
    keyring?: KeyRing;
    log?: TxnLog;
    leaseSeconds?: number;
    safetyMarginSeconds?: number;
    phase2EstimateSeconds?: number;
    now?: () => number;
    onEvent?: (e: TxnEvent) => void;
}
export declare function validatePlan(plan: Plan, now?: number): void;
export declare function createCoordinator(opts: CoordinatorOptions): {
    id: string;
    run: (input: Plan) => Promise<TransactionRecord>;
};
/** Offline verification of a Transaction Record (spec §8.5). */
export declare function verifyRecord(record: TransactionRecord, keyring: KeyRing): {
    ok: boolean;
    problems: string[];
};
