/**
 * Compliance Critic gate (COMPLEXITY §1/§4, invariant I4).
 *
 * Two paths to an outbound email, both receipted:
 *   1. Template path — rendered only from the frozen, hash-pinned registry
 *     (templates.ts). Still reviewed, because templates can carry hostile
 *     *variables*; the registry lock plus review makes the path double-safe.
 *   2. Free-text path — MUST pass the second-model critique adapter before
 *     send. Tests use DeterministicCritic; production swaps in a Gemini
 *     critic behind the same CriticAdapter interface.
 *
 * Every review issues a CriticVerdict receipt (pass or fail); the engine
 * ledgers all of them — a send without a passing receipt is impossible
 * because the actuator demands the receiptId and the gate checks it.
 */

import { createHash } from 'node:crypto';
import type { Clock, CriticAdapter, CriticVerdict, Intent } from '../types';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// Tone rules for the deterministic critic. Each hit fails the draft.
const HOSTILE_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\b(pay up|or else|you people|last chance before|we will make sure|everyone will know|expose you|ruin (you|your))\b/i, reason: 'threatening / coercive phrasing' },
  { re: /\b(deadbeat|thief|thieves|crook|liar|fraudster|scumbag|pathetic)\b/i, reason: 'abusive language' },
  { re: /\b(immediately|right now|today)\b.{0,24}\b(or|otherwise)\b/i, reason: 'ultimatum construction' },
  { re: /\b(we know where|show up at|come to your (office|home))\b/i, reason: 'implied physical presence / intimidation' },
  { re: /!{3,}/, reason: 'excessive exclamation' },
];

const LEGAL_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\b(legal action|lawsuit|sue|attorney|counsel|court|small claims|lien|judgment)\b/i, reason: 'legal threat language' },
  { re: /\b(statutory (late )?interest|late fees? under|§|c\.p\.l\.r|civ\. code|prop\. code)\b/i, reason: 'statute citation' },
  { re: /\b(collections? agency|credit (report|bureau))\b/i, reason: 'collections/credit-reporting language' },
];

function shoutRatio(text: string): number {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length < 20) return 0;
  return letters.replace(/[^A-Z]/g, '').length / letters.length;
}

/**
 * Deterministic, offline second-model stand-in. Same interface as the
 * production Gemini critic; its rules ARE the test oracle for tone gating.
 */
export class DeterministicCritic implements CriticAdapter {
  readonly name = 'deterministic-critic';
  constructor(private readonly clock: Clock) {}

  async review(draft: string, ctx: { intent?: Intent; legalAllowed: boolean }): Promise<CriticVerdict> {
    const reasons: string[] = [];
    for (const { re, reason } of HOSTILE_PATTERNS) {
      if (re.test(draft)) reasons.push(`tone: ${reason}`);
    }
    if (shoutRatio(draft) >= 0.5) reasons.push('tone: shouting (caps ratio)');
    if (!ctx.legalAllowed) {
      for (const { re, reason } of LEGAL_PATTERNS) {
        if (re.test(draft)) reasons.push(`I4: ${reason} while mandate legal_language=off`);
      }
    }
    const reviewedSha256 = sha256Hex(draft);
    const pass = reasons.length === 0;
    return {
      receiptId: `cr_${reviewedSha256.slice(0, 16)}_${pass ? 'pass' : 'fail'}`,
      pass,
      reasons,
      reviewedSha256,
      ts: this.clock.now().toISOString(),
      model: this.name,
    };
  }
}

/** A critic that always passes — used ONLY in negative tests to prove the gate itself blocks. */
export class RubberStampCritic implements CriticAdapter {
  readonly name = 'rubber-stamp-critic (test-only)';
  constructor(private readonly clock: Clock) {}
  async review(draft: string): Promise<CriticVerdict> {
    const reviewedSha256 = sha256Hex(draft);
    return {
      receiptId: `cr_${reviewedSha256.slice(0, 16)}_pass`,
      pass: true,
      reasons: [],
      reviewedSha256,
      ts: this.clock.now().toISOString(),
      model: this.name,
    };
  }
}

export class CriticBlockedError extends Error {
  constructor(public readonly verdict: CriticVerdict) {
    super(`critic blocked draft: ${verdict.reasons.join('; ')}`);
    this.name = 'CriticBlockedError';
  }
}

/**
 * The gate the engine talks to. Keeps every receipt (pass AND fail) for the
 * ledger; exposes requireApproval() which throws on fail so a blocked draft
 * cannot proceed by accident.
 */
export class CriticGate {
  readonly receipts: CriticVerdict[] = [];

  constructor(private readonly adapter: CriticAdapter) {}

  get adapterName(): string {
    return this.adapter.name;
  }

  async review(draft: string, ctx: { intent?: Intent; legalAllowed: boolean }): Promise<CriticVerdict> {
    const verdict = await this.adapter.review(draft, ctx);
    this.receipts.push(verdict);
    return verdict;
  }

  async requireApproval(draft: string, ctx: { intent?: Intent; legalAllowed: boolean }): Promise<CriticVerdict> {
    const verdict = await this.review(draft, ctx);
    if (!verdict.pass) throw new CriticBlockedError(verdict);
    return verdict;
  }

  /** Look up a receipt by id — the send actuator validates receipts exist and passed. */
  getReceipt(receiptId: string): CriticVerdict | undefined {
    return this.receipts.find((r) => r.receiptId === receiptId);
  }

  get failCount(): number {
    return this.receipts.filter((r) => !r.pass).length;
  }

  get passCount(): number {
    return this.receipts.filter((r) => r.pass).length;
  }
}

export { renderTemplate, getTemplate, TEMPLATES, TEMPLATE_HASHES, TemplateError, type RenderedEmail, type EmailTemplate } from './templates';
