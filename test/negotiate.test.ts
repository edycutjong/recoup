/**
 * Negotiation engine (COMPLEXITY §3): statutory late-interest per state rulepack,
 * exact installment splitting, and the EV(plan) vs EV(holdout) decision that the
 * ledger and replay UI render as the demo's split-screen math.
 */

import { describe, expect, it } from 'vitest';
import {
  lateInterest,
  getRulepack,
  RULEPACKS,
  buildInstallments,
  evOfPlan,
  evOfHoldout,
  decidePlan,
  floorCentsOf,
  DEFAULT_PARAMS,
} from '../src/core/negotiate';
import { AUSTIN_DESIGNER, DEFAULT_POLICY } from '../src/core/fixtures';
import type { UsState } from '../src/core/types';

describe('lateInterest — statutory rulepacks (FIXTURE)', () => {
  it('CA: 10%/yr, no grace, $4,800 @ 87 days', () => {
    const calc = lateInterest(480_000, 87, RULEPACKS.CA);
    expect(calc.accrualDays).toBe(87);
    expect(calc.interestCents).toBe(11_441); // round(480000 * 0.10 * 87/365)
    expect(calc.citation).toContain('Civ. Code');
    expect(calc.rulepackVersion).toBe('2026.07-fixture');
  });

  it('TX: 18%/yr with a 30-day grace shortens accrual', () => {
    const calc = lateInterest(215_000, 62, RULEPACKS.TX);
    expect(calc.accrualDays).toBe(32); // 62 - 30 grace
    expect(calc.interestCents).toBe(3_393); // round(215000 * 0.18 * 32/365)
  });

  it('NY: 9%/yr, no grace', () => {
    expect(lateInterest(100_000, 365, RULEPACKS.NY).interestCents).toBe(9_000); // 9% of 100k over a full year
  });

  it('accrual clamps to zero inside the grace window', () => {
    expect(lateInterest(215_000, 10, RULEPACKS.TX).interestCents).toBe(0); // 10 < 30-day grace
  });

  it('rejects negative inputs', () => {
    expect(() => lateInterest(-1, 10, RULEPACKS.CA)).toThrow();
    expect(() => lateInterest(1000, -1, RULEPACKS.CA)).toThrow();
  });

  it('getRulepack throws for an unknown state', () => {
    expect(() => getRulepack('ZZ' as UsState)).toThrow();
  });

  it('every shipped rulepack is clearly marked SYNTHETIC/FIXTURE', () => {
    for (const s of Object.keys(RULEPACKS) as UsState[]) {
      expect(RULEPACKS[s].source).toBe('FIXTURE');
      expect(RULEPACKS[s].citation).toContain('FIXTURE');
    }
  });
});

describe('buildInstallments — exact-sum splitting', () => {
  it('splits evenly when divisible', () => {
    expect(buildInstallments(480_000, 3)).toEqual([160_000, 160_000, 160_000]);
  });
  it('sends the remainder to the earliest parts', () => {
    expect(buildInstallments(100, 3)).toEqual([34, 33, 33]);
  });
  it('n = 1 returns the whole balance', () => {
    expect(buildInstallments(480_000, 1)).toEqual([480_000]);
  });
  it('always sums back to the total', () => {
    for (const [t, n] of [[100, 3], [999_999, 7], [288_000, 3], [1, 1]] as const) {
      expect(buildInstallments(t, n).reduce((a, b) => a + b, 0)).toBe(t);
    }
  });
  it('rejects bad arguments', () => {
    expect(() => buildInstallments(0, 3)).toThrow();
    expect(() => buildInstallments(100, 0)).toThrow();
  });
});

describe('EV math', () => {
  it('evOfPlan discounts later installments by the decay factor', () => {
    const r = evOfPlan({ totalCents: 480_000, installments: [160_000, 160_000, 160_000], cadenceDays: 30 }, DEFAULT_PARAMS);
    expect(r.ps[0]).toBe(0.85);
    expect(r.ps[1]).toBeCloseTo(0.8075, 4);
    expect(Math.round(r.ev)).toBe(387_940);
  });

  it('evOfHoldout adds statutory interest over the holdout horizon', () => {
    const r = evOfHoldout(AUSTIN_DESIGNER, 'hardship', RULEPACKS.CA, DEFAULT_PARAMS);
    expect(r.p).toBe(0.35); // hardship holdout probability
    expect(r.interest.accrualDays).toBe(147); // 87 + 60-day horizon
    expect(r.nominal).toBe(480_000 + r.interest.interestCents);
    expect(r.ev).toBeGreaterThan(0);
  });
});

describe('decidePlan', () => {
  it('proposes the demo 3×$1,600 plan for the Austin hardship case', () => {
    const d = decidePlan(AUSTIN_DESIGNER, DEFAULT_POLICY, 'hardship');
    expect(d.decision).toBe('propose_plan');
    expect(d.proposal?.installments).toEqual([160_000, 160_000, 160_000]);
    expect(d.floorCents).toBe(288_000);
    expect(d.rulepack.state).toBe('CA');
    expect(d.narrative).toMatch(/propose/i);
  });

  it('clamps a below-floor counter-offer UP to the mandate floor (I1 at construction)', () => {
    const d = decidePlan(AUSTIN_DESIGNER, DEFAULT_POLICY, 'counter_offer', 200_000); // offer $2,000 < $2,880 floor
    expect(d.proposal?.totalCents).toBe(288_000);
  });

  it('clamps requested installments down to the mandate max', () => {
    const d = decidePlan(AUSTIN_DESIGNER, DEFAULT_POLICY, 'hardship', null, 5); // wants 5, mandate allows 3
    expect(d.proposal?.installments.length).toBe(3);
  });

  it('floorCentsOf rounds up', () => {
    expect(floorCentsOf(AUSTIN_DESIGNER, DEFAULT_POLICY)).toBe(288_000);
  });
});
