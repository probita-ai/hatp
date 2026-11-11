// Questions for humans outside transactions (spec/hatp-asks.md): choose, form and free text.
// An approval authorises an action; an answer is information. Both are routed the same way and
// signed by the gateway, and an answer can be signed by the human's passkey too.
import { createHash } from "node:crypto";
import { canonicalize, hashObject, verifyObject } from "./crypto.ts";
import type { Assurance, HumanCard, Jwk, Signature, WebAuthnAssertion } from "./types.ts";
import { passkeysOf, verifyAssertion } from "./webauthn.ts";

export type FormField =
  | { type: "string"; title?: string; description?: string; minLength?: number; maxLength?: number; enum?: string[]; format?: "email" | "uri" | "date" | "date-time" }
  | { type: "number" | "integer"; title?: string; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; title?: string; description?: string };

/** What the human is asked. Every word of it is written by the requester, so channels label it as such (A§4). */
export type Question =
  | { kind: "choose"; prompt: string; options: { id: string; label: string }[]; minChoices?: number; maxChoices?: number }
  | { kind: "form"; prompt: string; fields: Record<string, FormField>; required?: string[] }
  | { kind: "text"; prompt: string; maxLength?: number };

export type QuestionKind = Question["kind"];

export type AnswerValue = { choices: string[] } | { values: Record<string, string | number | boolean> } | { text: string };

export interface AskQuestionRequest {
  address: string;
  question: Question;
  questionDigest: string;
  decideBy: string;
  /** Agent-written context, shown apart from the question. */
  purpose?: string;
  /** Only humans whose card lists this action may answer, e.g. "answer.legal". Amounts don't apply. */
  requirement?: { action: string };
  /** `human-signed`: an answer only counts with the human's passkey over it. */
  assurance?: Assurance;
  /** Who will rely on the answer. Signed into it, so it can't be presented to someone else as addressed to them. */
  audience?: string;
}

export interface Answer {
  type: "hatp.answer";
  questionDigest: string;
  /** The human's answer. Absent only in the record of a decline. */
  answer: AnswerValue;
  answerDigest: string;
  responder: string;
  routedVia: string[];
  routingReason?: string;
  authentication: { method: string; at: string; assurance: Assurance; webauthn?: WebAuthnAssertion };
  audience?: string;
  nonce: string;
  decidedAt: string;
  issuer: string;
  signature?: Signature;
}

export interface AskQuestionResult {
  /** `declined`: every human asked either declined or missed their SLA, and at least one declined. */
  status: "answered" | "declined";
  answers: Answer[];
  /** Humans who declined, in order. */
  declinedBy: string[];
}

/** `"sha256:" + base64url(SHA-256(JCS(question)))`. */
export function questionDigest(q: Question): string {
  return hashObject(q);
}

export function answerDigest(a: AnswerValue): string {
  return hashObject(a);
}

/**
 * The passkey challenge for an answer. Unlike an approval's, it can only be computed once the human
 * has answered, so the channel computes it with this function before calling `navigator.credentials.get`.
 */
export function answerChallenge(c: { questionDigest: string; answer: AnswerValue; responder: string; nonce: string; audience?: string }): string {
  const body = { type: "hatp.answer.challenge", questionDigest: c.questionDigest, answerDigest: answerDigest(c.answer), responder: c.responder, nonce: c.nonce, audience: c.audience ?? null };
  return createHash("sha256").update(canonicalize(body), "utf8").digest("base64url");
}

/** Why a question is malformed, or undefined. */
export function questionProblem(q: Question): string | undefined {
  if (!q || typeof q !== "object") return "question required";
  if (typeof q.prompt !== "string" || !q.prompt.trim()) return "question.prompt required";
  switch (q.kind) {
    case "choose": {
      if (!Array.isArray(q.options) || q.options.length < 2) return "choose needs at least two options";
      const ids = q.options.map((o) => o?.id);
      if (ids.some((id) => typeof id !== "string" || !id)) return "every option needs an id";
      if (new Set(ids).size !== ids.length) return "option ids must be distinct";
      if (q.options.some((o) => typeof o.label !== "string")) return "every option needs a label";
      const min = q.minChoices ?? 1, max = q.maxChoices ?? 1;
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1 || min > max || max > q.options.length) return "minChoices and maxChoices must fit the options";
      return undefined;
    }
    case "form": {
      if (!q.fields || typeof q.fields !== "object" || !Object.keys(q.fields).length) return "form needs at least one field";
      for (const [name, f] of Object.entries(q.fields)) {
        if (!f || !["string", "number", "integer", "boolean"].includes(f.type)) return `field ${name}: type must be string, number, integer or boolean`;
      }
      const unknown = (q.required ?? []).find((r) => !(r in q.fields));
      return unknown ? `required field ${unknown} is not in fields` : undefined;
    }
    case "text":
      return q.maxLength !== undefined && (!Number.isInteger(q.maxLength) || q.maxLength < 1) ? "maxLength must be a positive integer" : undefined;
    default:
      return `unknown question kind ${(q as { kind?: unknown }).kind}`;
  }
}

/** Why an answer doesn't fit its question, or undefined. Run by the gateway before it signs, and by anyone relying on one. */
export function answerProblem(q: Question, a: AnswerValue | undefined): string | undefined {
  if (!a || typeof a !== "object") return "no answer";
  switch (q.kind) {
    case "choose": {
      if (!("choices" in a) || !Array.isArray(a.choices)) return "a choose answer has choices";
      const ids = new Set(q.options.map((o) => o.id));
      if (a.choices.some((c) => !ids.has(c))) return "a choice is not one of the options";
      if (new Set(a.choices).size !== a.choices.length) return "a choice is repeated";
      const min = q.minChoices ?? 1, max = q.maxChoices ?? 1;
      return a.choices.length < min || a.choices.length > max ? `choose between ${min} and ${max}` : undefined;
    }
    case "form": {
      if (!("values" in a) || !a.values || typeof a.values !== "object") return "a form answer has values";
      for (const name of Object.keys(a.values)) if (!(name in q.fields)) return `${name} is not a field`;
      for (const name of q.required ?? []) if (a.values[name] === undefined) return `${name} is required`;
      for (const [name, v] of Object.entries(a.values)) {
        const f = q.fields[name];
        if (f.type === "boolean" && typeof v !== "boolean") return `${name} must be true or false`;
        if ((f.type === "number" || f.type === "integer") && (typeof v !== "number" || !Number.isFinite(v) || (f.type === "integer" && !Number.isInteger(v)) || (f.minimum !== undefined && v < f.minimum) || (f.maximum !== undefined && v > f.maximum))) return `${name} is not a valid ${f.type}`;
        if (f.type === "string") {
          if (typeof v !== "string") return `${name} must be text`;
          if ((f.minLength !== undefined && v.length < f.minLength) || (f.maxLength !== undefined && v.length > f.maxLength)) return `${name} has the wrong length`;
          if (f.enum && !f.enum.includes(v)) return `${name} must be one of ${f.enum.join(", ")}`;
        }
      }
      return undefined;
    }
    case "text":
      if (!("text" in a) || typeof a.text !== "string") return "a text answer has text";
      return q.maxLength !== undefined && a.text.length > q.maxLength ? `text longer than ${q.maxLength}` : undefined;
  }
}

/**
 * Why an Answer can't be relied on, or undefined: it must be signed by one of `gatewayKeys`, answer `question`
 * validly, and be addressed to `audience` when given. With `card`, a human-signed answer's passkey is checked too.
 */
export function verifyAnswer(a: Answer, o: { gatewayKeys: Jwk[]; question?: Question; audience?: string; card?: HumanCard }): string | undefined {
  if (a.type !== "hatp.answer") return "not an answer";
  if (!o.gatewayKeys.some((k) => verifyObject(a, k))) return "not signed by a trusted gateway";
  if (answerDigest(a.answer) !== a.answerDigest) return "answerDigest does not match the answer";
  if (o.question) {
    if (questionDigest(o.question) !== a.questionDigest) return "the answer is to another question";
    const problem = answerProblem(o.question, a.answer);
    if (problem) return problem;
  }
  if (o.audience !== undefined && a.audience !== o.audience) return `the answer is addressed to ${a.audience ?? "no one"}`;
  if (a.authentication.assurance === "human-signed") {
    const w = a.authentication.webauthn;
    if (!w) return "human-signed answer has no passkey assertion";
    if (!o.card) return undefined; // the gateway signature stands; pass the card to check the passkey too
    if (o.card.id !== a.responder) return `no card for ${a.responder}`;
    const key = passkeysOf(o.card).find((k) => k.kid === w.kid);
    if (!key) return `${w.kid} is not a passkey on ${a.responder}'s card`;
    return verifyAssertion(w, key, answerChallenge(a));
  }
  return undefined;
}
