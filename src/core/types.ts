/**
 * Shared domain types for the Recoup offline core.
 * COMPLEXITY.md is the binding blueprint; §4 defines the state machine and
 * invariants I1–I6 that these types support.
 */

// ---------------------------------------------------------------------------
// Money & time
// ---------------------------------------------------------------------------

/** All money is integer USD cents. No floats cross a money boundary. */
export type Cents = number;

/** ISO-8601 UTC timestamp string. */
export type IsoTs = string;

/** Injected clock so every component is deterministic under test. */
export interface Clock {
  now(): Date;
}

export class FixedClock implements Clock {
  private t: number;
  constructor(startIso: string) {
    this.t = Date.parse(startIso);
    if (Number.isNaN(this.t)) throw new Error(`FixedClock: bad start ${startIso}`);
  }
  now(): Date {
    return new Date(this.t);
  }
  advanceHours(h: number): void {
    this.t += h * 3_600_000;
  }
  advanceDays(d: number): void {
    this.advanceHours(d * 24);
  }
  /** Jump forward to the next occurrence of localHour (0-23). */
  advanceToHour(localHour: number): void {
    const cur = new Date(this.t);
    let deltaH = (localHour - cur.getUTCHours() + 24) % 24;
    if (deltaH === 0) deltaH = 24;
    this.t += deltaH * 3_600_000 - (cur.getUTCMinutes() * 60_000 + cur.getUTCSeconds() * 1000 + cur.getUTCMilliseconds());
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

// ---------------------------------------------------------------------------
// Invoice & mandate policy
// ---------------------------------------------------------------------------

export type UsState = 'CA' | 'TX' | 'NY';

export interface Invoice {
  id: string;
  client: { name: string; email: string };
  debtor: { entity: string; contact: string; email: string };
  amountCents: Cents;
  issuedAt: IsoTs;
  agedDays: number;
  /** Governing US state for statutory late interest. */
  state: UsState;
  /** Commercial (B2B) only — consumer debt is out of scope at intake (PRD). */
  kind: 'b2b';
  /** Fixture marker. Every seeded invoice is synthetic. */
  synthetic: boolean;
}

/** Quiet hours in the debtor's local time; start === end means "no quiet window". */
export interface QuietHours {
  startHour: number; // 0..23, quiet period begins (inclusive)
  endHour: number; // 0..23, quiet period ends (exclusive)
}

/**
 * The machine-readable settlement mandate the client signs (COMPLEXITY §3).
 * The gate in core/mandate validates every money/send action against this.
 */
export interface MandatePolicy {
  floorPct: number; // I1: never accept/propose total below this % of amount
  maxInstallments: number; // I1: never more parts than this
  quietHours: QuietHours; // I2
  maxTouchesPerWeek: number; // I2
  legalLanguage: boolean; // I4: legal escalation text requires explicit opt-in
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

export const INTENTS = [
  'paying', // will pay / paid confirmation
  'promise_to_pay', // "check's in the mail" style promise, no proof
  'hardship', // wants to pay, cash-constrained → plan candidate
  'counter_offer', // negotiating amount/structure
  'dispute', // contests the debt → human handoff
  'hostile', // aggressive tone → de-escalate
  'ghost', // evasive brush-off with no payment signal
  'opt_out', // demands contact stop (I3)
  'wrong_contact', // not the right person; may give a redirect
  'bankrupt', // insolvency declared → write-off path
] as const;

export type Intent = (typeof INTENTS)[number];

export interface IntentResult {
  intent: Intent;
  confidence: number; // 0..1
  rationale: string;
  source: 'heuristic' | 'adapter';
}

/** Pluggable second-stage classifier (Gemini in prod, deterministic mock in tests). */
export interface IntentAdapter {
  readonly name: string;
  classify(text: string, ctx: { invoice: Invoice }): Promise<IntentResult>;
}

// ---------------------------------------------------------------------------
// Actions the clerk can take (Negotiator function-call surface)
// ---------------------------------------------------------------------------

export interface PlanProposal {
  totalCents: Cents;
  installments: Cents[]; // length 1..maxInstallments, sums to totalCents
  cadenceDays: number; // days between installments
}

export type ActionRequest =
  | { type: 'send_reminder'; invoiceId: string; stage: number; body: string; legal: boolean }
  | { type: 'send_free_text'; invoiceId: string; body: string; legal: boolean; criticReceiptId: string }
  | { type: 'propose_plan'; invoiceId: string; proposal: PlanProposal; body: string; legal: boolean; criticReceiptId: string }
  | { type: 'accept_plan'; invoiceId: string; proposal: PlanProposal }
  | { type: 'escalate'; invoiceId: string; toStage: number; body: string; legal: boolean }
  | { type: 'recommend_writeoff'; invoiceId: string; memo: string };

export type ActionType = ActionRequest['type'];

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type LedgerKind =
  | 'intake'
  | 'mandate_signed'
  | 'classify'
  | 'strategy'
  | 'policy_check'
  | 'critic_receipt'
  | 'send'
  | 'proposal'
  | 'plan_accepted'
  | 'payment'
  | 'fee'
  | 'writeoff'
  | 'dispute'
  | 'handoff'
  | 'opt_out'
  | 'contact_update'
  | 'note';

export interface LedgerEntryInput {
  actor: string; // e.g. 'classifier', 'negotiator', 'critic', 'treasury'
  kind: LedgerKind;
  invoiceId: string;
  payload: unknown; // canonical-JSON-serializable
  /** entry_hash refs of causally prior entries (I5 for fee rows). */
  refs?: string[];
}

export interface LedgerEntry {
  seq: number;
  ts: IsoTs;
  actor: string;
  kind: LedgerKind;
  invoiceId: string;
  payload: unknown;
  refs: string[];
  prevHash: string; // hex
  entryHash: string; // hex = SHA-256(prevHash ∥ canonical_json(core fields))
  sig: string; // base64 Ed25519 over entryHash bytes
  pubkey: string; // base64 SPKI DER of the signing key
}

// ---------------------------------------------------------------------------
// Critic
// ---------------------------------------------------------------------------

export interface CriticVerdict {
  receiptId: string;
  pass: boolean;
  reasons: string[];
  reviewedSha256: string; // hash of the exact reviewed draft
  ts: IsoTs;
  model: string; // which critic produced it (mock name in tests)
}

/** Second-model critique surface — mockable; Gemini-backed in production. */
export interface CriticAdapter {
  readonly name: string;
  review(draft: string, ctx: { intent?: Intent; legalAllowed: boolean }): Promise<CriticVerdict>;
}

// ---------------------------------------------------------------------------
// Actuator results
// ---------------------------------------------------------------------------

export interface SendResult {
  rfc822MessageId: string;
  msgSha256: string;
  to: string;
  sentAt: IsoTs;
}

export interface PaymentLink {
  linkId: string;
  url: string;
  invoiceId: string;
  installmentIndex: number; // 0-based
  amountCents: Cents;
}

export interface PaymentEvent {
  eventId: string;
  linkId: string;
  invoiceId: string;
  installmentIndex: number;
  amountCents: Cents;
  paidAt: IsoTs;
}

export interface FeeRow {
  feeId: string;
  invoiceId: string;
  paymentEventId: string;
  feeCents: Cents;
  pct: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}

export function usd(cents: Cents): string {
  return `$${(cents / 100).toFixed(2)}`;
}
