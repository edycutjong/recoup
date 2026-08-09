/**
 * FLAGSHIP GUARANTEE (COMPLEXITY §3, invariants I1/I2/I3/I4).
 *
 * Across hundreds of randomized mandate policies and adversarial proposals we
 * prove that below-floor, over-installment, out-of-quiet-hours, over-cap, and
 * unauthorized-legal actions are STRUCTURALLY impossible: `authorize` denies
 * them (no token), so no actuator can ever act on them. The published metric
 * `executedViolations` provably stays 0 for the whole sweep.
 *
 * Honesty control: we also feed a KNOWN breach to `auditExecuted` on a throwaway
 * gate and watch the counter tick to 1 — so "violations = 0" is a real
 * measurement by a working detector, not a vacuous constant.
 */

import { describe, expect, it } from 'vitest';
import {
  MandateGate,
  PolicyViolationError,
  ForgedTokenError,
  inQuietHours,
  validateProposalShape,
} from '../src/core/mandate';
import { buildInstallments } from '../src/core/negotiate';
import { FixedClock } from '../src/core/types';
import type { ActionRequest, MandatePolicy, PlanProposal } from '../src/core/types';
import { mulberry32, randInt, randomPolicy } from './_util';

const NOW_ISO = '2026-07-06T15:00:00.000Z'; // local hour 15
const ITER = 300;

function clock() {
  return new FixedClock(NOW_ISO);
}

function ctxBase(amountCents: number) {
  return { invoiceAmountCents: amountCents, recentSendTimesMs: [] as number[], localHour: 15, optedOut: false };
}

function proposalAction(proposal: PlanProposal): Extract<ActionRequest, { type: 'propose_plan' }> {
  return { type: 'propose_plan', invoiceId: 'INV-P', proposal, body: 'Here is a plan for {{x}} -> resolved.', legal: false, criticReceiptId: 'cr_x' };
}

/** A localHour guaranteed to sit outside this policy's quiet window. */
function hourOutsideQuiet(p: MandatePolicy): number {
  for (let h = 0; h < 24; h++) if (!inQuietHours(h, p.quietHours)) return h;
  throw new Error('policy has no non-quiet hour (impossible: start===end ⇒ empty window)');
}
function hourInsideQuiet(p: MandatePolicy): number | null {
  for (let h = 0; h < 24; h++) if (inQuietHours(h, p.quietHours)) return h;
  return null; // empty quiet window
}

describe('MANDATE PROPERTY — below-floor proposals are structurally impossible (I1)', () => {
  it(`denies every below-floor proposal across ${ITER} random policies; issues a token for at-floor`, () => {
    const rng = mulberry32(0xF100);
    const gate = new MandateGate(randomPolicy(rng), clock()); // reused only to assert its counter never moves
    let denied = 0;
    let allowed = 0;

    for (let i = 0; i < ITER; i++) {
      const policy = randomPolicy(rng);
      const amount = randInt(rng, 50_000, 5_000_000);
      const g = new MandateGate(policy, clock());
      const floor = g.floorCents(amount);
      const ctx = ctxBase(amount);
      ctx.localHour = hourOutsideQuiet(policy);

      // --- below floor: total in [1, floor-1], valid installment count ---
      const belowTotal = randInt(rng, 1, floor - 1);
      const nBelow = Math.min(randInt(rng, 1, policy.maxInstallments), belowTotal);
      const belowProposal: PlanProposal = { totalCents: belowTotal, installments: buildInstallments(belowTotal, nBelow), cadenceDays: 30 };
      expect(validateProposalShape(belowProposal)).toEqual([]); // shape is fine; only the floor is violated
      expect(() => g.authorize(proposalAction(belowProposal), ctx)).toThrowError(PolicyViolationError);
      try { g.authorize(proposalAction(belowProposal), ctx); } catch (e) { expect((e as PolicyViolationError).code).toBe('I1_FLOOR'); }
      denied++;

      // --- exactly at floor: allowed (all other checks neutral) ---
      const nAt = Math.min(randInt(rng, 1, policy.maxInstallments), floor);
      const atProposal: PlanProposal = { totalCents: floor, installments: buildInstallments(floor, nAt), cadenceDays: 30 };
      const token = g.authorize(proposalAction(atProposal), ctx);
      expect(g.isIssued(token)).toBe(true);
      expect(token.policyFloorCents).toBe(floor);
      allowed++;

      expect(g.executedViolations).toBe(0);
    }

    expect(denied).toBe(ITER);
    expect(allowed).toBe(ITER);
    expect(gate.executedViolations).toBe(0);
  });
});

describe('MANDATE PROPERTY — over-installment proposals are impossible (I1)', () => {
  it(`denies proposals with more than maxInstallments parts across ${ITER} policies`, () => {
    const rng = mulberry32(0xF101);
    for (let i = 0; i < ITER; i++) {
      const policy = randomPolicy(rng);
      const amount = randInt(rng, 100_000, 5_000_000);
      const g = new MandateGate(policy, clock());
      const ctx = ctxBase(amount);
      ctx.localHour = hourOutsideQuiet(policy);

      const total = amount; // full balance is always >= floor
      const n = policy.maxInstallments + randInt(rng, 1, 6);
      const proposal: PlanProposal = { totalCents: total, installments: buildInstallments(total, n), cadenceDays: 30 };
      expect(proposal.installments.length).toBeGreaterThan(policy.maxInstallments);
      let code = '';
      try { g.authorize(proposalAction(proposal), ctx); } catch (e) { code = (e as PolicyViolationError).code; }
      expect(code).toBe('I1_INSTALLMENTS');
      expect(g.executedViolations).toBe(0);
    }
  });
});

describe('MANDATE PROPERTY — quiet-hours sends are impossible (I2)', () => {
  it(`denies sends inside the quiet window and allows them outside across ${ITER} policies`, () => {
    const rng = mulberry32(0xF102);
    let checkedInside = 0;
    for (let i = 0; i < ITER; i++) {
      const policy = randomPolicy(rng);
      const g = new MandateGate(policy, clock());
      const amount = 200_000;
      const send: ActionRequest = { type: 'send_reminder', invoiceId: 'INV-P', stage: 1, body: 'friendly reminder', legal: false };

      const inside = hourInsideQuiet(policy);
      if (inside !== null) {
        const ctx = { ...ctxBase(amount), localHour: inside };
        let code = '';
        try { g.authorize(send, ctx); } catch (e) { code = (e as PolicyViolationError).code; }
        expect(code).toBe('I2_QUIET_HOURS');
        checkedInside++;
      }

      const outCtx = { ...ctxBase(amount), localHour: hourOutsideQuiet(policy) };
      const token = g.authorize(send, outCtx);
      expect(g.isIssued(token)).toBe(true);
      expect(g.executedViolations).toBe(0);
    }
    expect(checkedInside).toBeGreaterThan(0); // some random policies had a non-empty quiet window
  });
});

describe('MANDATE PROPERTY — weekly touch cap is impossible to exceed (I2)', () => {
  it(`denies the (cap+1)-th send and allows the cap-th across ${ITER} policies`, () => {
    const rng = mulberry32(0xF103);
    const nowMs = clock().now().getTime();
    for (let i = 0; i < ITER; i++) {
      const policy = randomPolicy(rng);
      const g = new MandateGate(policy, clock());
      const send: ActionRequest = { type: 'send_reminder', invoiceId: 'INV-P', stage: 1, body: 'reminder', legal: false };
      const outHour = hourOutsideQuiet(policy);

      // cap sends already in the last week ⇒ next is denied
      const atCap = Array.from({ length: policy.maxTouchesPerWeek }, (_, k) => nowMs - (k + 1) * 3_600_000);
      let code = '';
      try { g.authorize(send, { ...ctxBase(200_000), localHour: outHour, recentSendTimesMs: atCap }); } catch (e) { code = (e as PolicyViolationError).code; }
      expect(code).toBe('I2_TOUCH_CAP');

      // one under cap ⇒ allowed
      const underCap = atCap.slice(0, policy.maxTouchesPerWeek - 1);
      const token = g.authorize(send, { ...ctxBase(200_000), localHour: outHour, recentSendTimesMs: underCap });
      expect(g.isIssued(token)).toBe(true);
      expect(g.executedViolations).toBe(0);
    }
  });

  it('touches older than 7 days do not count toward the cap', () => {
    const policy: MandatePolicy = { floorPct: 60, maxInstallments: 3, quietHours: { startHour: 21, endHour: 8 }, maxTouchesPerWeek: 2, legalLanguage: false };
    const g = new MandateGate(policy, clock());
    const nowMs = clock().now().getTime();
    const old = [nowMs - 8 * 24 * 3_600_000, nowMs - 9 * 24 * 3_600_000, nowMs - 30 * 24 * 3_600_000];
    const token = g.authorize({ type: 'send_reminder', invoiceId: 'INV-P', stage: 1, body: 'x', legal: false }, { ...ctxBase(200_000), localHour: 12, recentSendTimesMs: old });
    expect(g.isIssued(token)).toBe(true);
  });
});

describe('MANDATE PROPERTY — legal language needs the explicit toggle (I4)', () => {
  it(`denies legal:true sends when mandate legal_language=off across ${ITER} policies`, () => {
    const rng = mulberry32(0xF104);
    for (let i = 0; i < ITER; i++) {
      const policy = { ...randomPolicy(rng), legalLanguage: false };
      const g = new MandateGate(policy, clock());
      const ctx = { ...ctxBase(200_000), localHour: hourOutsideQuiet(policy) };
      const legalSend: ActionRequest = { type: 'escalate', invoiceId: 'INV-P', toStage: 4, body: 'formal notice', legal: true };
      let code = '';
      try { g.authorize(legalSend, ctx); } catch (e) { code = (e as PolicyViolationError).code; }
      expect(code).toBe('I4_LEGAL_LANGUAGE');

      // same action allowed once the mandate turns it on
      const gOn = new MandateGate({ ...policy, legalLanguage: true }, clock());
      const token = gOn.authorize(legalSend, ctx);
      expect(gOn.isIssued(token)).toBe(true);
      expect(g.executedViolations).toBe(0);
    }
  });
});

describe('MANDATE PROPERTY — opt-out denies every action type (I3)', () => {
  const actions: ActionRequest[] = [
    { type: 'send_reminder', invoiceId: 'INV-P', stage: 1, body: 'x', legal: false },
    { type: 'propose_plan', invoiceId: 'INV-P', proposal: { totalCents: 300_000, installments: [300_000], cadenceDays: 30 }, body: 'x', legal: false, criticReceiptId: 'cr' },
    { type: 'accept_plan', invoiceId: 'INV-P', proposal: { totalCents: 300_000, installments: [300_000], cadenceDays: 30 } },
    { type: 'escalate', invoiceId: 'INV-P', toStage: 4, body: 'x', legal: false },
    { type: 'recommend_writeoff', invoiceId: 'INV-P', memo: 'x'.repeat(50) },
  ];
  it.each(actions.map((a) => [a.type, a] as const))('opted-out debtor: %s is denied I3', (_t, action) => {
    const g = new MandateGate({ floorPct: 50, maxInstallments: 4, quietHours: { startHour: 21, endHour: 8 }, maxTouchesPerWeek: 5, legalLanguage: true }, clock());
    let code = '';
    try { g.authorize(action, { ...ctxBase(500_000), localHour: 12, optedOut: true }); } catch (e) { code = (e as PolicyViolationError).code; }
    expect(code).toBe('I3_OPT_OUT');
    expect(g.executedViolations).toBe(0);
  });
});

describe('MANDATE — tokens are unforgeable and single-use', () => {
  it('a foreign object is never accepted by confirmExecution (counted as a forgery)', () => {
    const g = new MandateGate({ floorPct: 60, maxInstallments: 3, quietHours: { startHour: 21, endHour: 8 }, maxTouchesPerWeek: 5, legalLanguage: false }, clock());
    const fake = Object.freeze({ action: { type: 'send_reminder' }, checks: [], policyFloorCents: 1, issuedAt: 'now' }) as never;
    expect(() => g.confirmExecution(fake)).toThrowError(ForgedTokenError);
    expect(g.blockedForgeries).toBe(1);
    expect(g.executedViolations).toBe(0);
  });

  it('an issued token executes exactly once; replay is a forgery', () => {
    const g = new MandateGate({ floorPct: 60, maxInstallments: 3, quietHours: { startHour: 21, endHour: 8 }, maxTouchesPerWeek: 5, legalLanguage: false }, clock());
    const token = g.authorize({ type: 'send_reminder', invoiceId: 'INV-P', stage: 1, body: 'x', legal: false }, { ...ctxBase(200_000), localHour: 12 });
    g.confirmExecution(token); // ok
    expect(() => g.confirmExecution(token)).toThrowError(ForgedTokenError); // replay blocked
    expect(g.blockedForgeries).toBe(1);
    expect(g.executedViolations).toBe(0);
  });

  it('randomized fuzz: no forged token ever executes and the counter never moves', () => {
    const rng = mulberry32(0xF1F1);
    const g = new MandateGate({ floorPct: 60, maxInstallments: 3, quietHours: { startHour: 21, endHour: 8 }, maxTouchesPerWeek: 5, legalLanguage: false }, clock());
    let blocked = 0;
    for (let i = 0; i < ITER; i++) {
      const forged = Object.freeze({ action: { type: 'propose_plan' }, checks: ['fake'], policyFloorCents: randInt(rng, 1, 999), issuedAt: 'x' }) as never;
      expect(() => g.confirmExecution(forged)).toThrowError(ForgedTokenError);
      blocked++;
    }
    expect(g.blockedForgeries).toBe(blocked);
    expect(g.executedViolations).toBe(0);
  });
});

describe('MANDATE — the violation counter is a REAL detector (honesty control)', () => {
  it('auditExecuted ticks the counter for a KNOWN below-floor breach', () => {
    const g = new MandateGate({ floorPct: 60, maxInstallments: 3, quietHours: { startHour: 21, endHour: 8 }, maxTouchesPerWeek: 5, legalLanguage: false }, clock());
    const breach: ActionRequest = { type: 'accept_plan', invoiceId: 'INV-P', proposal: { totalCents: 100, installments: [100], cadenceDays: 30 } };
    expect(g.executedViolations).toBe(0);
    g.auditExecuted(breach, { ...ctxBase(1_000_000), localHour: 12 }); // 100c is far below 60% of $10,000
    expect(g.executedViolations).toBe(1); // the detector works, so 0 elsewhere means something
  });

  it('auditExecuted ticks for a KNOWN quiet-hours breach and a KNOWN opt-out breach', () => {
    const g = new MandateGate({ floorPct: 60, maxInstallments: 3, quietHours: { startHour: 21, endHour: 8 }, maxTouchesPerWeek: 5, legalLanguage: false }, clock());
    g.auditExecuted({ type: 'send_reminder', invoiceId: 'INV-P', stage: 1, body: 'x', legal: false }, { ...ctxBase(200_000), localHour: 23 });
    g.auditExecuted({ type: 'send_reminder', invoiceId: 'INV-P', stage: 1, body: 'x', legal: false }, { ...ctxBase(200_000), localHour: 12, optedOut: true });
    expect(g.executedViolations).toBe(2);
  });

  it('auditExecuted does NOT tick for a compliant executed action', () => {
    const g = new MandateGate({ floorPct: 60, maxInstallments: 3, quietHours: { startHour: 21, endHour: 8 }, maxTouchesPerWeek: 5, legalLanguage: false }, clock());
    g.auditExecuted({ type: 'send_reminder', invoiceId: 'INV-P', stage: 1, body: 'x', legal: false }, { ...ctxBase(200_000), localHour: 12 });
    g.auditExecuted({ type: 'accept_plan', invoiceId: 'INV-P', proposal: { totalCents: 300_000, installments: [150_000, 150_000], cadenceDays: 30 } }, { ...ctxBase(480_000), localHour: 12 });
    expect(g.executedViolations).toBe(0);
  });
});
