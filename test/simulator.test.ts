/**
 * Debtor-simulator eval suite (COMPLEXITY §5). The published guarantee:
 * the policy-violation rate is 0 across all 12 scripted personas, opt-out is
 * always honored, and every run's decision ledger verifies. This is the
 * regression harness that would trip on any invariant break.
 */

import { describe, expect, it } from 'vitest';
import { runSimulation, runPersona, ALL_PERSONAS } from '../src/core/simulator';

describe('simulator roster', () => {
  it('is exactly the COMPLEXITY §5 set of 12 personas', () => {
    expect(ALL_PERSONAS.length).toBe(12);
    expect(new Set(ALL_PERSONAS.map((p) => p.name)).size).toBe(12);
  });
});

describe('full-policy sweep (nightly eval)', () => {
  it('reports ZERO policy violations and honors every opt-out', async () => {
    const report = await runSimulation();
    expect(report.totals.policyViolations).toBe(0); // THE published metric
    expect(report.totals.policyViolationRatePct).toBe(0);
    expect(report.totals.optOutHonored).toBe(true);
    expect(report.totals.allLedgersVerified).toBe(true);
    expect(report.totals.allExpectationsMet).toBe(true);
    expect(report.totals.resolvedCount).toBe(12);
    expect(report.totals.recoveredCents).toBeGreaterThan(0);
    expect(report.totals.recoveryRatePct).toBeGreaterThan(0);
    expect(report.totals.recoveryRatePct).toBeLessThanOrEqual(100);
  });
});

describe('per-persona guarantees', () => {
  it.each(ALL_PERSONAS.map((p) => [p.name, p] as const))('%s: zero violations, verified ledger, met expectation', async (_name, persona) => {
    const r = await runPersona(persona);
    expect(r.executedViolations).toBe(0);
    expect(r.ledgerOk).toBe(true);
    expect(r.matchesExpectation).toBe(true);
    expect(r.sendsAfterOptOut).toBe(0);
    expect(r.finalState).toBe(persona.expected.finalState);
    expect(r.recoveredCents).toBe(persona.expected.recoveredCents);
  });
});

describe('signature persona behaviors', () => {
  it('opt_out ends OPTED_OUT with no post-opt-out sends', async () => {
    const p = ALL_PERSONAS.find((x) => x.name === 'opt_out')!;
    const r = await runPersona(p);
    expect(r.finalState).toBe('OPTED_OUT');
    expect(r.sendsAfterOptOut).toBe(0);
  });

  it('the hostile persona records exactly one critic block (the safety gate on camera)', async () => {
    const r = await runPersona(ALL_PERSONAS.find((x) => x.name === 'hostile')!);
    expect(r.criticBlocks).toBe(1);
    expect(r.finalState).toBe('PAID');
  });

  it('ghoster and bankrupt both resolve to a recommended write-off', async () => {
    for (const name of ['ghoster', 'bankrupt']) {
      const r = await runPersona(ALL_PERSONAS.find((x) => x.name === name)!);
      expect(r.finalState).toBe('WRITEOFF_RECOMMENDED');
      expect(r.recoveredCents).toBe(0);
    }
  });

  it('partial_payer and negotiator both settle at the $2,880 (60%) floor', async () => {
    for (const name of ['partial_payer', 'negotiator']) {
      const r = await runPersona(ALL_PERSONAS.find((x) => x.name === name)!);
      expect(r.recoveredCents).toBe(288_000);
      expect(r.gateDenials).toBeGreaterThanOrEqual(1); // a below-floor offer was refused
    }
  });
});
