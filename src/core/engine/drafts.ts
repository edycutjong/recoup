/**
 * Deterministic drafting + counter-offer parsing helpers for the engine.
 *
 * In production the free-text drafter is Gemini Pro behind the same shape;
 * offline it is a fixed function so the hostile-draft → critic-block →
 * re-tone beat (SEED_DATA) is reproducible in tests.
 */

import type { Cents, Intent, Invoice } from '../types';
import { usd } from '../types';

/**
 * Draft a free-text response for a given debtor intent. NOTE: the hostile
 * draft is INTENTIONALLY too sharp — it exists so the Compliance Critic can
 * visibly block it and the engine can fall back to the locked de-escalation
 * template. That is the safety gate working, on the record.
 */
export function draftResponse(intent: Intent, invoice: Invoice, paymentUrl: string): string {
  const amt = usd(invoice.amountCents);
  switch (intent) {
    case 'hostile':
      // Deliberately non-compliant first draft (ultimatum + coercion) — the
      // critic MUST catch this; tests assert it never reaches the wire.
      return `This has gone on long enough. You need to pay up immediately or else we will take this much further. ${amt} — today.`;
    case 'promise_to_pay':
      return `Thanks for the update on invoice ${invoice.id}. To close the loop, could you confirm the exact date payment will go out? The link makes it instant when you are ready: ${paymentUrl}`;
    case 'ghost':
      return `Circling back on invoice ${invoice.id} (${amt}). When you have thirty seconds, the payment link is here: ${paymentUrl} — or reply with a date that works and I will note it.`;
    case 'paying':
      return `Great — thank you. I will watch for the payment on invoice ${invoice.id}. The link is here in case it is easier: ${paymentUrl}`;
    default:
      return `Thanks for the reply about invoice ${invoice.id} (${amt}). Happy to work out the details — the payment link is here when ready: ${paymentUrl}`;
  }
}

export interface ParsedOffer {
  totalCents: Cents | null;
  installments: number | null;
}

/** Deterministic extraction of a counter-offer from debtor text. */
export function parseOffer(text: string, invoiceAmountCents: Cents): ParsedOffer {
  let totalCents: Cents | null = null;
  let installments: number | null = null;

  const pct = text.match(/(\d{1,3})\s?(?:%|percent)/i);
  if (pct) {
    const p = Number(pct[1]);
    if (p > 0 && p <= 100) totalCents = Math.round((invoiceAmountCents * p) / 100);
  }

  if (totalCents === null && /\bhalf\b/i.test(text)) {
    totalCents = Math.round(invoiceAmountCents / 2);
  }

  if (totalCents === null) {
    const dollars = text.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
    if (dollars) {
      const n = Number(dollars[1]!.replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) totalCents = Math.round(n * 100);
    }
  }

  const inst = text.match(/(\d{1,2})\s+(?:monthly\s+|weekly\s+)?(?:payments|installments|instalments|months)/i);
  if (inst) {
    const n = Number(inst[1]);
    if (n >= 1 && n <= 24) installments = n;
  }

  return { totalCents, installments };
}

/** "agreed" / "deal" style acceptance of a pending plan proposal. */
export function isAcceptance(text: string): boolean {
  return /\b(agreed?|deal|works for (me|us)|i accept|we accept|yes,? let'?s do (it|that)|sounds good|that works)\b/i.test(text);
}

export function formatPlanDetails(installments: Cents[], cadenceDays: number): string {
  const parts = installments.map((c) => usd(c)).join(' + ');
  return `${installments.length} installments of ${parts}, ${cadenceDays} days apart`;
}
