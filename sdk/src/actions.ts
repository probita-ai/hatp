// Approvals for single MCP tool calls: the Human Gateway SEP (spec/sep/0000-human-gateway.md §5–§7).
// A transaction approval binds a plan digest; an action approval binds one tools/call, its server,
// and the payment terms a paid tool sets.
import { createHash } from "node:crypto";
import { canonicalize, hashObject, verifyObject } from "./crypto.ts";
import { parseHumanAddress } from "./directory.ts";
import { HatpError } from "./types.ts";
import type { Assurance, HumanCard, Jwk, Money, Signature, WebAuthnAssertion } from "./types.ts";
import { passkeysOf, verifyAssertion } from "./webauthn.ts";

/** The extension identifier, in capabilities and in `_meta` (SEP §2, §6). */
export const HUMAN_GATEWAY_EXTENSION = "ai.probita/human-gateway";

/** What a paid tool will charge, as the approval covers it (SEP §5.1, §6.1). */
export interface Payment {
  /** CAIP-2 chain id. */
  network: string;
  /** CAIP-19 asset id. */
  asset: string;
  /** Decimal string in the asset's atomic units. */
  maxAmount: string;
  payTo: string;
}

/** One tools/call, described as the human approves it (SEP §5.1). */
export interface Action {
  type: "mcp.tools/call";
  /** The gated server's serverId. */
  server: string;
  tool: string;
  /** Exactly the arguments the requester will send. */
  arguments: Record<string, unknown>;
  /** Digest of the tool's definition, binding the approval to the version the human was shown. */
  toolDigest?: string;
  payment?: Payment;
}

/** A requirement as a gated tool states it: `amountFrom` says where the amount is (SEP §6, §6.1). */
export interface ActionRequirement {
  action: string;
  amount?: Money;
  /** A JSON Pointer into the action's arguments (`"/amount"`), or `"payment"`. */
  amountFrom?: string;
}

export interface ActionApproval {
  type: "hatp.approval";
  actionDigest: string;
  decision: "approve" | "reject";
  approver: string;
  routedVia: string[];
  routingReason?: string;
  authentication: { method: string; at: string; assurance: Assurance; webauthn?: WebAuthnAssertion };
  /** The gated server this approval is for: the action's `server`. */
  audience: string;
  nonce: string;
  decidedAt: string;
  expiresAt: string;
  issuer: string;
  signature?: Signature;
}

export interface AskApproveRequest {
  address: string;
  requirement: ActionRequirement;
  action: Action;
  actionDigest: string;
  decideBy: string;
  /** Agent-written. Shown separately and labelled as such. */
  purpose?: string;
  /** Minimum assurance for an approval to count. */
  assurance?: Assurance;
}

export interface AskApproveResult {
  decision: "approve" | "reject";
  approvals: ActionApproval[];
}

/** `"sha256:" + base64url(SHA-256(JCS(action)))` (SEP §5.1). */
export function actionDigest(action: Action): string {
  return hashObject(action);
}

/** Digest of a tool definition as tools/list returns it: name, description, inputSchema, annotations (SEP §5.1). */
export function toolDigest(tool: { name: string; description?: string; inputSchema: unknown; annotations?: unknown }): string {
  const { name, description, inputSchema, annotations } = tool;
  return hashObject(annotations === undefined ? { name, description, inputSchema } : { name, description, inputSchema, annotations });
}

/** The passkey challenge for an action approval (SEP §7.1). */
export function actionChallenge(c: Pick<ActionApproval, "actionDigest" | "decision" | "approver" | "audience" | "nonce" | "expiresAt">): string {
  const body = { type: "hatp.approval.challenge", actionDigest: c.actionDigest, decision: c.decision, approver: c.approver, audience: c.audience, nonce: c.nonce, expiresAt: c.expiresAt };
  return createHash("sha256").update(canonicalize(body), "utf8").digest("base64url");
}

/** Why a human-signed action approval's passkey assertion doesn't verify against the approver's card, or undefined. */
export function verifyActionHumanSignature(a: ActionApproval, card: HumanCard | undefined): string | undefined {
  const w = a.authentication.webauthn;
  if (a.authentication.assurance !== "human-signed") return "approval is not human-signed";
  if (!w) return "human-signed approval has no passkey assertion";
  if (!card || card.id !== a.approver) return `no card for ${a.approver}`;
  const key = passkeysOf(card).find((k) => k.kid === w.kid);
  if (!key) return `${w.kid} is not a passkey on ${a.approver}'s card`;
  return verifyAssertion(w, key, actionChallenge(a));
}

/**
 * The amount to check authority against. With `amountFrom`, it is read from the action itself, since the
 * agent writes the requirement (the lesson of HATP's transaction gateway): a stated amount may be higher, never lower.
 */
export function actionAmount(action: Action, req: ActionRequirement): Money | undefined {
  if (!req.amountFrom) return req.amount;
  let found: Money | undefined;
  if (req.amountFrom === "payment") {
    if (!action.payment) throw new HatpError("PLAN_INVALID", "requirement reads the payment, but the action has none");
    found = { value: Number(action.payment.maxAmount), currency: action.payment.asset }; // compared in the asset itself, never converted
  } else {
    const v = req.amountFrom.split("/").slice(1).reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), action.arguments);
    const m = v as Money | undefined;
    if (!m || typeof m.value !== "number" || !Number.isFinite(m.value) || m.value < 0 || typeof m.currency !== "string") throw new HatpError("PLAN_INVALID", `no amount at ${req.amountFrom}`);
    found = { value: m.value, currency: m.currency };
  }
  if (req.amount && req.amount.currency === found.currency && req.amount.value > found.value) return req.amount;
  return found;
}

/** What a gated tool needs before it runs (SEP §6). */
export interface Requires {
  address: string;
  requirement: ActionRequirement;
  assurance?: Assurance;
  /** For a paid tool whose server sets the price: the network and asset it charges in (SEP §6.1). */
  payment?: { network: string; asset: string };
}

/** What a paid tool will actually charge for one call, in the asset's atomic units (SEP §6.1). */
export interface PaymentTerms {
  network: string;
  asset: string;
  amount: string;
  payTo: string;
}

/**
 * Why a server's payment terms fall outside the approved payment, or undefined (SEP §6.1). The payer's
 * client or wallet MUST run this before signing a payment: when the gated server is also the payee,
 * the server's own check cannot protect the payer.
 */
export function paymentTermsProblem(approved: Payment, terms: PaymentTerms): string | undefined {
  if (approved.network !== terms.network || approved.asset !== terms.asset || approved.payTo !== terms.payTo) return "the terms are for another network, asset or payee than the approved payment";
  let amount: bigint, max: bigint;
  try {
    amount = BigInt(terms.amount);
    max = BigInt(approved.maxAmount);
  } catch {
    return "amounts must be integers in the asset's atomic units";
  }
  if (amount < 0n) return "a negative amount";
  if (amount > max) return `the terms ask ${terms.amount}, more than the approved ${approved.maxAmount}`;
  return undefined;
}

export interface ApprovalGateOptions {
  serverId: string;
  /** Gateways whose Approvals this server accepts: gatewayId → its keys. */
  trustedGateways: Record<string, Jwk[]>;
  /** Approvers' cards, to verify human-signed approvals. Cards must come from a trusted gateway. */
  cards?: { get(id: string): HumanCard | undefined };
  now?: () => number;
}

export interface GateCheck {
  tool: string;
  arguments: Record<string, unknown>;
  requires: Requires;
  approvals?: ActionApproval[];
  /** The tool's current definition, when the server accepts approvals bound to it (`toolDigest`). */
  toolDefinition?: { name: string; description?: string; inputSchema: unknown; annotations?: unknown };
  /** The payment object the requester passed back, for a paid tool. */
  payment?: Payment;
  /** What the server will charge for this call, for a paid tool. */
  terms?: PaymentTerms;
}

const fail = (code: "APPROVAL_REQUIRED" | "APPROVAL_INVALID", message: string) => new HatpError(code, message);

/**
 * The checks a gated server runs before a gated tool (SEP §6). `check` throws APPROVAL_REQUIRED or
 * APPROVAL_INVALID; on success it returns the nonces to `consume` once the tool has actually run.
 */
export function createApprovalGate(opts: ApprovalGateOptions) {
  const now = opts.now ?? Date.now;
  const used = new Map<string, number>(); // nonce → expiresAt
  const sweep = () => { for (const [n, exp] of used) if (exp <= now()) used.delete(n); };

  return {
    check(c: GateCheck): { nonces: string[] } {
      const approvals = c.approvals ?? [];
      if (!approvals.length) throw fail("APPROVAL_REQUIRED", `${c.tool} needs an approval from ${c.requires.address}`);
      if (c.requires.payment) {
        if (!c.payment) throw fail("APPROVAL_INVALID", `${c.tool} is paid: pass the approved payment back with the approvals`);
        if (!c.terms) throw fail("APPROVAL_INVALID", `${c.tool} is paid but the server stated no terms`);
        const problem = paymentTermsProblem(c.payment, c.terms);
        if (problem) throw fail("APPROVAL_INVALID", `${c.tool}: ${problem}`);
      }
      const base: Action = { type: "mcp.tools/call", server: opts.serverId, tool: c.tool, arguments: c.arguments, ...(c.payment ? { payment: c.payment } : {}) };
      const digests = new Set([actionDigest(base)]);
      if (c.toolDefinition) digests.add(actionDigest({ ...base, toolDigest: toolDigest(c.toolDefinition) }));

      sweep();
      const required = parseHumanAddress(c.requires.address).quorum?.required ?? 1;
      const approvers = new Set<string>();
      const nonces: string[] = [];
      for (const a of approvals) {
        if (a.type !== "hatp.approval" || a.decision !== "approve") throw fail("APPROVAL_INVALID", "only approvals with decision approve count");
        if (!digests.has(a.actionDigest)) throw fail("APPROVAL_INVALID", `approval by ${a.approver} is for another call: tool, arguments, payment or tool version differ`);
        const keys = opts.trustedGateways[a.issuer];
        if (!keys || !keys.some((k) => verifyObject(a, k))) throw fail("APPROVAL_INVALID", `approval by ${a.approver} is not signed by a trusted gateway`);
        if (a.audience !== opts.serverId) throw fail("APPROVAL_INVALID", `approval by ${a.approver} is for ${a.audience}`);
        const t = now();
        if (!(Date.parse(a.decidedAt) <= t && t < Date.parse(a.expiresAt))) throw fail("APPROVAL_INVALID", `approval by ${a.approver} is outside its validity window`);
        if (used.has(a.nonce) || nonces.includes(a.nonce)) throw fail("APPROVAL_INVALID", `approval by ${a.approver} was already used`);
        if (c.requires.assurance === "human-signed") {
          const problem = opts.cards ? verifyActionHumanSignature(a, opts.cards.get(a.approver)) : "no approver cards to verify the passkey against";
          if (problem) throw fail("APPROVAL_INVALID", `approval by ${a.approver}: ${problem}`);
        }
        approvers.add(a.approver);
        nonces.push(a.nonce);
      }
      if (approvers.size < required) throw fail("APPROVAL_INVALID", `${approvers.size}/${required} distinct approvers`);
      return { nonces };
    },

    /** Records the nonces once the tool has run. A call answered without running it must not consume them (SEP §6, check 5). */
    consume(nonces: string[], approvals: ActionApproval[]): void {
      for (const a of approvals) if (nonces.includes(a.nonce)) used.set(a.nonce, Date.parse(a.expiresAt));
    },
  };
}
export type ApprovalGate = ReturnType<typeof createApprovalGate>;
