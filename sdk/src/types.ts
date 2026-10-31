// Core HATP v0.1 types. Mirrors spec/schemas/hatp.schema.json.

export type Tier = "hold" | "compensate" | "final";

export interface Money {
  value: number;
  currency: string;
}

export interface Jwk {
  kid: string;
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface Signature {
  alg: "Ed25519";
  kid: string;
  sig: string;
}

export interface Authority {
  action: string;
  maxAmount?: Money;
}

export interface Requirement {
  action: string;
  amount?: Money;
}

export type Channel = "slack" | "teams" | "sms" | "email" | "voice" | "web" | "push";

export interface HumanCard {
  id: string;
  displayName: string;
  org: string;
  roles: string[];
  pools?: string[];
  skills?: string[];
  authority: Authority[];
  channels: Channel[];
  availability?: { timezone?: string; status?: "available" | "busy" | "away" | "offline"; hours?: string };
  sla?: { ackSeconds?: number; decideSeconds?: number };
  capacity?: { maxOpen?: number; open?: number };
  delegates?: string[];
  keys: Jwk[];
  issuer: string;
  signature?: Signature;
}

export interface Branch {
  branchId: string;
  participant: string;
  tier: Tier;
  operation: { tool: string; arguments: Record<string, unknown> };
  amount?: Money;
}

export interface ApprovalGroup {
  groupId: string;
  address: string;
  quorum: { required: number };
  rejectPolicy?: "any" | "majority";
  requirement: Requirement;
  decideBy: string;
}

export type PrepareOrder = "parallel" | "approval-first" | "holds-first";

/** A hold as placed before humans were asked, in holds-first mode (spec §5.4). */
export interface HeldBranch {
  holdRef?: string;
  amount?: Money;
  /** The hold's horizon, or its first lease when it reports none. No commit after this. Absent: the hold reported no end. */
  expiresAt?: string;
}

export interface Plan {
  hatp: "0.1";
  txnId: string;
  initiator: string;
  onBehalfOf?: string;
  purpose?: string;
  deadline: string;
  /** Unset: the coordinator chooses from the clock (spec §5.4). */
  prepareOrder?: PrepareOrder;
  branches: Branch[];
  approvals?: ApprovalGroup[];
  tolerance?: { amountPercent?: number };
  /** How long a human needs to resolve a final step left in doubt (spec §5.3). */
  escalation?: {
    leadSeconds: number;
    /** holds-first only: when the coordinator escalates at the latest. */
    escalateBy?: string;
  };
  /** holds-first only: the holds as placed, written by the coordinator before humans sign (spec §5.4). */
  holds?: {
    /** Digest of the plan the holds were prepared under, before this block and the fitted deadlines were added. */
    basePlanDigest: string;
    branches: Record<string, HeldBranch>;
  };
  /** txnId of the transaction this one recovers from (spec §6.5). */
  recoveryOf?: string;
  /** What the principal consented to in advance, should recovery be needed. */
  recovery?: {
    offSessionReauth?: { consented: boolean; maxAmount?: Money; mandateRef?: string };
  };
}

export type Phase = "quote" | "estimate" | "prepare" | "commit" | "abort" | "compensate" | "renew" | "tighten";

export interface Receipt {
  type: "hatp.receipt";
  txnId: string;
  branchId: string;
  planDigest: string;
  phase: Phase;
  outcome: string;
  detail?: Record<string, unknown>;
  issuedAt: string;
  issuer: string;
  signature?: Signature;
}

export interface Approval {
  type: "hatp.approval";
  txnId: string;
  groupId: string;
  planDigest: string;
  decision: "approve" | "reject";
  approver: string;
  routedVia: string[];
  routingReason?: string;
  authentication: { method: string; at: string; assurance: "human-signed" | "gateway-attested" };
  nonce: string;
  decidedAt: string;
  issuer: string;
  signature?: Signature;
}

export interface Vote {
  vote: "yes" | "no";
  leaseExpiresAt?: string;
  /** Latest time the participant will honor the hold, renewals included. Absent: treat leaseExpiresAt as the horizon. */
  holdHorizon?: string;
  holdRef?: string;
  amount?: Money;
  reason?: { code: string; message: string };
  approvals?: Approval[];
  receipt: Receipt;
}

export interface Decision {
  type: "hatp.decision";
  txnId: string;
  planDigest: string;
  decision: "commit" | "abort";
  decidedAt: string;
  issuer: string;
  signature?: Signature;
}

export interface PrepareRequest {
  txnId: string;
  branchId: string;
  planDigest: string;
  plan: Plan;
  leaseSeconds: number;
}

export interface PhaseRequest {
  txnId: string;
  branchId: string;
  planDigest: string;
  decisionRecord: Decision;
}

export interface CompensateRequest {
  txnId: string;
  branchId: string;
  planDigest: string;
  compensationToken: string;
}

export interface RenewRequest {
  txnId: string;
  branchId: string;
  planDigest: string;
  leaseSeconds: number;
}

export interface TightenRequest {
  txnId: string;
  branchId: string;
  planDigest: string;
  plan: Plan;
  /** New effective decideBy. Never later than the group's signed decideBy. */
  decideBy: string;
}

export interface Quote {
  amount?: Money;
  quoteRef: string;
  validUntil: string;
  /** How long a hold placed later may last, renewals included. */
  maxHoldSeconds?: number;
  receipt: Receipt;
}

export interface Estimate {
  /** Latest the approval group could still decide, in seconds from now, if every human asked times out. */
  worstCaseSeconds: number;
  receipt: Receipt;
}

export interface CommitResult {
  compensationToken?: string;
  receipt: Receipt;
}

/**
 * What a coordinator talks to. In-process objects implement it directly;
 * a JSON-RPC / MCP client binding implements it by sending hatp/txn/* requests.
 */
export interface Participant {
  id: string;
  quote?(req: PrepareRequest): Promise<Quote>;
  /** Human Gateways: worst-case decision time for an approval group (spec §7.9). */
  estimate?(req: PrepareRequest): Promise<Estimate>;
  /** Human Gateways: shorten an approval group's deadline to fit the tightest hold (spec §7.10). */
  tighten?(req: TightenRequest): Promise<{ decideBy: string; receipt: Receipt }>;
  prepare(req: PrepareRequest): Promise<Vote>;
  commit(req: PhaseRequest): Promise<CommitResult>;
  abort(req: PhaseRequest): Promise<{ receipt: Receipt }>;
  compensate?(req: CompensateRequest): Promise<{ receipt: Receipt }>;
  renew?(req: RenewRequest): Promise<{ leaseExpiresAt: string; receipt: Receipt }>;
}

export type TxnState =
  | "ACTIVE"
  | "PREPARING"
  | "COMMITTING"
  | "COMMITTED"
  | "ABORTING"
  | "ABORTED"
  | "COMPENSATING"
  | "IN_DOUBT"
  | "NEEDS_ATTENTION";

export type BranchState =
  | "ENLISTED"
  | "PREPARED"
  | "VOTED_NO"
  | "COMMITTED"
  | "ABORTED"
  | "COMPENSATED"
  | "IN_DOUBT"
  | "FAILED";

export interface TxnEvent {
  seq: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
  prevHash: string;
}

export interface TransactionRecord {
  type: "hatp.record";
  plan: Plan;
  planDigest: string;
  state: TxnState;
  branches: Record<string, BranchState>;
  approvals: Approval[];
  receipts: Receipt[];
  decision?: Decision;
  events: TxnEvent[];
  issuer: string;
  signature?: Signature;
}

/**
 * A way out of a NEEDS_ATTENTION transaction that the coordinator offers but never performs
 * itself: each one is a new action that needs fresh consent (spec §6.5).
 */
export type RecoveryOption =
  /** The final step happened and every hold is still live: capture them. */
  | { kind: "capture-holds"; branches: string[] }
  /** The final step did not happen: release the holds and undo the compensate steps. */
  | { kind: "roll-back"; branches: string[] }
  /** Holds lapsed after the final step happened: a new transaction, with its own approval, to place them again. */
  | { kind: "linked-transaction"; recoveryOf: string; branches: string[]; payerPresent: boolean }
  /** Undo the final step, where its provider can (e.g. an airline's same-day void). */
  | { kind: "undo-final"; branchId: string };

export type HatpCode =
  | "PLAN_INVALID"
  | "PLAN_MISMATCH"
  | "TXN_UNKNOWN"
  | "INVALID_STATE"
  | "HOLD_EXPIRED"
  | "DEADLINE_EXCEEDED"
  | "AUTHORITY_INSUFFICIENT"
  | "QUORUM_UNREACHABLE"
  | "LOCK_CONFLICT"
  | "STALE_FENCING_TOKEN"
  | "COMPENSATION_FAILED"
  | "COMMIT_FAILED"
  | "NOT_SUPPORTED";

export class HatpError extends Error {
  code: HatpCode;
  constructor(code: HatpCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
