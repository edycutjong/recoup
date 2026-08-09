/**
 * Versioned state rulepacks for statutory late interest (COMPLEXITY §3/§5).
 *
 * >>> FIXTURE DATA — SYNTHETIC <<<
 * These three packs (CA/TX/NY) are deterministic FIXTURES for the offline
 * core: schema-correct, citation-shaped, and clearly marked. The production
 * system replaces them with the nightly 50-state statute crawl (versioned).
 * Do not treat the rates below as legal advice or current law.
 */

import type { Cents, UsState } from '../types';

export interface Rulepack {
  state: UsState;
  version: string; // e.g. '2026.07-fixture'
  citation: string;
  annualRatePct: number; // simple interest, % per annum
  graceDays: number; // days past due before interest accrues
  source: 'FIXTURE';
}

export const RULEPACKS: Record<UsState, Rulepack> = {
  CA: {
    state: 'CA',
    version: '2026.07-fixture',
    citation: 'Cal. Civ. Code §3289(b) [FIXTURE]',
    annualRatePct: 10,
    graceDays: 0,
    source: 'FIXTURE',
  },
  TX: {
    state: 'TX',
    version: '2026.07-fixture',
    citation: 'Tex. Prop. Code ch. 28 (prompt payment) [FIXTURE]',
    annualRatePct: 18,
    graceDays: 30,
    source: 'FIXTURE',
  },
  NY: {
    state: 'NY',
    version: '2026.07-fixture',
    citation: 'N.Y. C.P.L.R. §5004 [FIXTURE]',
    annualRatePct: 9,
    graceDays: 0,
    source: 'FIXTURE',
  },
};

export function getRulepack(state: UsState): Rulepack {
  const pack = RULEPACKS[state];
  if (!pack) throw new Error(`no rulepack for state ${state}`);
  return pack;
}

export interface InterestCalc {
  interestCents: Cents;
  accrualDays: number;
  annualRatePct: number;
  citation: string;
  rulepackVersion: string;
  formula: string;
}

/** Simple statutory interest: amount × rate × accrualDays/365, banker-free rounding to cents. */
export function lateInterest(amountCents: Cents, agedDays: number, pack: Rulepack): InterestCalc {
  if (!Number.isInteger(amountCents) || amountCents < 0) throw new Error('amountCents must be a non-negative integer');
  if (!Number.isFinite(agedDays) || agedDays < 0) throw new Error('agedDays must be >= 0');
  const accrualDays = Math.max(0, Math.floor(agedDays) - pack.graceDays);
  const interestCents = Math.round((amountCents * (pack.annualRatePct / 100) * accrualDays) / 365);
  return {
    interestCents,
    accrualDays,
    annualRatePct: pack.annualRatePct,
    citation: pack.citation,
    rulepackVersion: pack.version,
    formula: `${amountCents}c × ${pack.annualRatePct}%/yr × ${accrualDays}/365 = ${interestCents}c`,
  };
}
