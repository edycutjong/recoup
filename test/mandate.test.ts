/**
 * Mandate middleware unit tests (COMPLEXITY §3) — policy validation, quiet-hours
 * arithmetic, proposal shape, floor rounding, per-invariant denials & receipts.
 * The randomized structural guarantees live in mandate.property.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  MandateGate,
  PolicyValidationError,
  PolicyViolationError,
  validatePolicy,
  validateProposalShape,
  inQuietHours,
} from '../src/core/mandate';
import { FixedClock } from '../src/core/types';
import type { MandatePolicy } from '../src/core/types';

const OK: MandatePolicy = { floorPct: 60, maxInstallments: 3, quietHours: { startHour: 21, endHour: 8 }, maxTouchesPerWeek: 5, legalLanguage: false };
const clock = () => new FixedClock('2026-07-06T15:00:00.000Z');
const ctx = (over: Partial<{ invoiceAmountCents: number; recentSendTimesMs: number[]; localHour: number; optedOut: boolean }> = {}) => ({
  invoiceAmountCents: 480_000, recentSendTimesMs: [], localHour: 15, optedOut: false, ...over,
});

describe('validatePolicy', () => {
  it('accepts and normalizes a well-formed policy', () => {
    const p = validatePolicy({ ...OK });
    expect(p).toEqual(OK);
  });

  it.each([
    ['floorPct 0', { ...OK, floorPct: 0 }],
    ['floorPct 101', { ...OK, floorPct: 101 }],
    ['floorPct NaN', { ...OK, floorPct: Number.NaN }],
    ['maxInstallments 0', { ...OK, maxInstallments: 0 }],
    ['maxInstallments 13', { ...OK, maxInstallments: 13 }],
    ['maxInstallments 2.5', { ...OK, maxInstallments: 2.5 }],
    ['quietHours startHour 24', { ...OK, quietHours: { startHour: 24, endHour: 8 } }],
    ['quietHours endHour -1', { ...OK, quietHours: { startHour: 21, endHour: -1 } }],
    ['maxTouchesPerWeek 0', { ...OK, maxTouchesPerWeek: 0 }],
    ['maxTouchesPerWeek 15', { ...OK, maxTouchesPerWeek: 15 }],
    ['legalLanguage non-bool', { ...OK, legalLanguage: 'yes' }],
  ])('rejects %s', (_label, bad) => {
    expect(() => validatePolicy(bad)).toThrowError(PolicyValidationError);
  });

  it('collects multiple problems at once', () => {
    try {
      validatePolicy({ floorPct: -1, maxInstallments: 99, quietHours: { startHour: 21, endHour: 8 }, maxTouchesPerWeek: 5, legalLanguage: false });
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyValidationError);
      expect((e as PolicyValidationError).problems.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('the gate constructor validates its policy', () => {
    expect(() => new MandateGate({ ...OK, floorPct: 250 }, clock())).toThrowError(PolicyValidationError);
  });
});

describe('inQuietHours', () => {
  it('non-wrapping window [9,17)', () => {
    const qh = { startHour: 9, endHour: 17 };
    expect(inQuietHours(9, qh)).toBe(true);
    expect(inQuietHours(16, qh)).toBe(true);
    expect(inQuietHours(17, qh)).toBe(false); // end exclusive
    expect(inQuietHours(8, qh)).toBe(false);
  });

  it('wrapping window [21,8) covers midnight', () => {
    const qh = { startHour: 21, endHour: 8 };
    expect(inQuietHours(22, qh)).toBe(true);
    expect(inQuietHours(0, qh)).toBe(true);
    expect(inQuietHours(7, qh)).toBe(true);
    expect(inQuietHours(8, qh)).toBe(false);
    expect(inQuietHours(20, qh)).toBe(false);
  });

  it('empty window when start === end', () => {
    for (let h = 0; h < 24; h++) expect(inQuietHours(h, { startHour: 5, endHour: 5 })).toBe(false);
  });

  it('rejects an out-of-range hour', () => {
    expect(() => inQuietHours(24, { startHour: 21, endHour: 8 })).toThrow();
    expect(() => inQuietHours(-1, { startHour: 21, endHour: 8 })).toThrow();
  });
});

describe('validateProposalShape', () => {
  it('accepts a well-formed proposal', () => {
    expect(validateProposalShape({ totalCents: 300, installments: [100, 100, 100], cadenceDays: 30 })).toEqual([]);
  });
  it('rejects non-positive total', () => {
    expect(validateProposalShape({ totalCents: 0, installments: [1], cadenceDays: 30 }).length).toBeGreaterThan(0);
  });
  it('rejects empty installments', () => {
    expect(validateProposalShape({ totalCents: 100, installments: [], cadenceDays: 30 }).length).toBeGreaterThan(0);
  });
  it('rejects a non-positive installment', () => {
    expect(validateProposalShape({ totalCents: 100, installments: [100, 0], cadenceDays: 30 }).length).toBeGreaterThan(0);
  });
  it('rejects installments that do not sum to total', () => {
    const probs = validateProposalShape({ totalCents: 300, installments: [100, 100], cadenceDays: 30 });
    expect(probs.some((p) => p.includes('sum'))).toBe(true);
  });
  it('rejects cadenceDays out of [1,90]', () => {
    expect(validateProposalShape({ totalCents: 100, installments: [100], cadenceDays: 0 }).length).toBeGreaterThan(0);
    expect(validateProposalShape({ totalCents: 100, installments: [100], cadenceDays: 91 }).length).toBeGreaterThan(0);
  });
});

describe('MandateGate.floorCents rounding', () => {
  it('rounds the floor UP (never rounds a debtor below the mandate)', () => {
    const g = new MandateGate({ ...OK, floorPct: 60 }, clock());
    expect(g.floorCents(480_000)).toBe(288_000);
    expect(g.floorCents(333)).toBe(Math.ceil(333 * 0.6)); // 200
  });
});

describe('MandateGate.authorize — receipts and denials', () => {
  it('records a denial with code, actionType, message and timestamp', () => {
    const g = new MandateGate(OK, clock());
    expect(() => g.authorize({ type: 'propose_plan', invoiceId: 'INV', proposal: { totalCents: 100, installments: [100], cadenceDays: 30 }, body: 'x', legal: false, criticReceiptId: 'cr' }, ctx())).toThrowError(PolicyViolationError);
    expect(g.deniedCount).toBe(1);
    expect(g.denials[0]).toMatchObject({ code: 'I1_FLOOR', actionType: 'propose_plan' });
    expect(g.denials[0]!.ts).toMatch(/^2026-07-06T/);
  });

  it('a malformed proposal is denied I1_SHAPE before the floor check', () => {
    const g = new MandateGate(OK, clock());
    let code = '';
    try { g.authorize({ type: 'propose_plan', invoiceId: 'INV', proposal: { totalCents: 300, installments: [100, 100], cadenceDays: 30 }, body: 'x', legal: false, criticReceiptId: 'cr' }, ctx()); } catch (e) { code = (e as PolicyViolationError).code; }
    expect(code).toBe('I1_SHAPE');
  });

  it('recommend_writeoff requires a reasoned memo (>= 40 chars)', () => {
    const g = new MandateGate(OK, clock());
    let code = '';
    try { g.authorize({ type: 'recommend_writeoff', invoiceId: 'INV', memo: 'too short' }, ctx()); } catch (e) { code = (e as PolicyViolationError).code; }
    expect(code).toBe('WRITEOFF_MEMO');
    const token = g.authorize({ type: 'recommend_writeoff', invoiceId: 'INV', memo: 'Dead entity confirmed; further outreach is negative EV and wasteful.' }, ctx());
    expect(g.isIssued(token)).toBe(true);
    expect(token.checks).toContain('writeoff:memo');
  });

  it('a valid at-floor plan lists every invariant check it ran', () => {
    const g = new MandateGate(OK, clock());
    const token = g.authorize({ type: 'propose_plan', invoiceId: 'INV', proposal: { totalCents: 288_000, installments: [96_000, 96_000, 96_000], cadenceDays: 30 }, body: 'x', legal: false, criticReceiptId: 'cr' }, ctx());
    expect(token.checks).toEqual(expect.arrayContaining(['I3:not-opted-out', 'I2:quiet-hours', 'I2:touch-cap', 'I4:legal-toggle', 'I1:shape', 'I1:floor', 'I1:installments']));
  });
});
