/**
 * Reply-intent classification (COMPLEXITY §1 Classifier).
 *
 * Layer 1: a deterministic, fully-offline heuristic scorer. It must clear the
 * engineered edge from SEED_DATA.md — "things are tight this quarter, maybe
 * later?" is HARDSHIP (money-difficulty signal) even though "maybe later"
 * smells like ghosting to a keyword matcher: financial-distress terms outrank
 * deflection terms.
 *
 * Layer 2: a pluggable IntentAdapter consulted when the heuristic is unsure.
 * Tests use DeterministicMockAdapter; production uses the Gemini adapter in
 * ./gemini (only constructed when GEMINI_API_KEY is set).
 */

import type { Intent, IntentAdapter, IntentResult, Invoice } from '../types';

interface Rule {
  intent: Intent;
  weight: number;
  pattern: RegExp;
  label: string;
}

// Order does not matter for scoring; weights + priority decide.
const RULES: Rule[] = [
  // I3 — opt-out (highest stakes: must never be missed)
  { intent: 'opt_out', weight: 10, pattern: /\b(stop (emailing|contacting|messaging)|do not contact|don'?t contact|unsubscribe|remove me from|cease (all )?contact|no further contact)\b/i, label: 'stop-contact demand' },

  // Insolvency
  { intent: 'bankrupt', weight: 9, pattern: /\b(chapter (7|11|13)|bankruptcy|bankrupt|insolvent|insolvency|liquidat(ing|ion)|receivership|winding (up|down) the (company|business))\b/i, label: 'insolvency declared' },

  // Wrong contact
  { intent: 'wrong_contact', weight: 8, pattern: /\b(no longer (with|at|work)|left the (company|firm)|wrong (person|contact|department)|not my (invoice|department|responsibility)|i don'?t work (there|at)|reach out to (our )?(billing|accounts))\b/i, label: 'redirect / not the right person' },

  // Dispute
  { intent: 'dispute', weight: 8, pattern: /\b(dispute|never (approved|signed|agreed|authorized)|not what we agreed|wasn'?t delivered|work (was|is) (incomplete|defective|not done)|we don'?t owe|already paid|incorrect invoice|billing error|contest (this|the) (invoice|charge))\b/i, label: 'debt contested' },

  // Hostile
  { intent: 'hostile', weight: 7, pattern: /\b(harass(ing|ment)?|sue you|hear from my (lawyer|attorney)|screw (you|off)|piss(ed)? off|shove it|threaten(ing)?|scam(mer)?s?|leave (me|us) alone|absolute joke)\b/i, label: 'aggressive tone' },

  // Hardship — money-difficulty language (outranks deflection by weight)
  { intent: 'hardship', weight: 6, pattern: /\b((cash|money|things|finances|budgets?) (is|are|'s)? ?(really |very |so )?tight|cash ?flow|can'?t afford|can'?t do the (full|\$)|hard times|struggling to (pay|cover)|slow (quarter|month|season)|revenue (is|'s) down|waiting on (our|my) own (clients?|invoices?)|money (is|'s) tight|tight this (quarter|month|year))\b/i, label: 'financial difficulty' },

  // Counter offer — explicit numeric/structural offer
  { intent: 'counter_offer', weight: 6, pattern: /\b(would you (accept|take)|can you do|settle (for|at)|(\d{1,3}) ?(%|percent)|pay (half|\$?\d)|split (it|the (balance|amount))|(monthly|weekly) payments?|installments?|payment plan)\b/i, label: 'explicit offer / structure request' },

  // Paying — concrete payment action
  { intent: 'paying', weight: 6, pattern: /\b(just (paid|sent)|payment (sent|processed|went through|initiated)|paying (it |the invoice )?(now|today)|will pay (it |in full )?(today|now|right away)|sent the (wire|ach|transfer)|link, paid|paid in full)\b/i, label: 'payment action stated' },

  // Promise to pay — dated promise, no proof
  { intent: 'promise_to_pay', weight: 4, pattern: /\b(check('?s| is) in the mail|by (end of|next) (week|month)|by friday|next (week|month)|end of (the )?(week|month)|when i get paid|soon as (i|we) can|process it (this|next) week)\b/i, label: 'unverified promise' },

  // Ghost — pure deflection, no money signal
  { intent: 'ghost', weight: 2, pattern: /\b(circle back|touch base|maybe later|super busy|slammed (right now|this week)|let me check|look into it|get back to you|following up internally|will revert)\b/i, label: 'deflection without payment signal' },
];

/** Deterministic tie-break priority (first wins on equal score). */
const PRIORITY: Intent[] = [
  'opt_out',
  'bankrupt',
  'wrong_contact',
  'dispute',
  'hostile',
  'hardship',
  'counter_offer',
  'paying',
  'promise_to_pay',
  'ghost',
];

export interface HeuristicOutcome extends IntentResult {
  scores: Partial<Record<Intent, number>>;
  matched: string[];
}

export function classifyHeuristic(text: string): HeuristicOutcome {
  const scores: Partial<Record<Intent, number>> = {};
  const matched: string[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      scores[rule.intent] = (scores[rule.intent] ?? 0) + rule.weight;
      matched.push(`${rule.intent}:${rule.label}`);
    }
  }

  // Shouting boost for hostility (>=60% caps over 12+ letters).
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 12) {
    const capsRatio = (letters.replace(/[^A-Z]/g, '').length / letters.length);
    if (capsRatio >= 0.6) {
      scores.hostile = (scores.hostile ?? 0) + 5;
      matched.push('hostile:shouting (caps ratio)');
    }
  }

  const entries = Object.entries(scores) as [Intent, number][];
  if (entries.length === 0) {
    return {
      intent: 'ghost',
      confidence: 0.2,
      rationale: 'no signals matched; treating as evasive/no-signal reply',
      source: 'heuristic',
      scores,
      matched,
    };
  }

  entries.sort((a, b) => (b[1] - a[1]) || (PRIORITY.indexOf(a[0]) - PRIORITY.indexOf(b[0])));
  const [topIntent, topScore] = entries[0]!;
  const second = entries[1]?.[1] ?? 0;
  const total = entries.reduce((a, [, s]) => a + s, 0);
  // Confidence: share of the top signal, boosted by margin over the runner-up.
  const confidence = Math.min(0.99, topScore / total * 0.6 + (topScore - second) / (topScore || 1) * 0.4);

  return {
    intent: topIntent,
    confidence: Number(confidence.toFixed(3)),
    rationale: `signals: ${matched.join('; ')}`,
    source: 'heuristic',
    scores,
    matched,
  };
}

export const ADAPTER_CONFIDENCE_THRESHOLD = 0.55;

/**
 * Two-stage classifier: heuristic first; below-threshold confidence defers to
 * the adapter (deterministic mock in tests, Gemini in production).
 */
export class IntentClassifier {
  constructor(
    private readonly adapter: IntentAdapter | null = null,
    private readonly threshold: number = ADAPTER_CONFIDENCE_THRESHOLD,
  ) {}

  async classify(text: string, ctx: { invoice: Invoice }): Promise<IntentResult> {
    const heuristic = classifyHeuristic(text);
    if (heuristic.confidence >= this.threshold || !this.adapter) {
      return heuristic;
    }
    const fromAdapter = await this.adapter.classify(text, ctx);
    return { ...fromAdapter, source: 'adapter' };
  }
}

/**
 * Deterministic stand-in for the Gemini classifier used by tests and the
 * scripted simulator. Optionally pinned per exact text; otherwise it reuses
 * the heuristic scorer (still deterministic, still offline).
 */
export class DeterministicMockAdapter implements IntentAdapter {
  readonly name = 'mock-intent-adapter';
  constructor(private readonly pinned: ReadonlyMap<string, Intent> = new Map()) {}

  async classify(text: string, _ctx: { invoice: Invoice }): Promise<IntentResult> {
    const pin = this.pinned.get(text);
    if (pin) {
      return { intent: pin, confidence: 0.95, rationale: `pinned fixture classification → ${pin}`, source: 'adapter' };
    }
    const h = classifyHeuristic(text);
    return { intent: h.intent, confidence: Math.max(h.confidence, 0.7), rationale: h.rationale, source: 'adapter' };
  }
}
