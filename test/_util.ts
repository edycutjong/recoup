/**
 * Deterministic test utilities (offline, no deps).
 *
 * A seeded PRNG stands in for fast-check: property tests draw many pseudo-random
 * policies/proposals from a FIXED seed, so failures are reproducible and the
 * suite stays network- and entropy-free (the whole core's design ethos).
 */

import type { Invoice, MandatePolicy } from '../src/core/types';

/** mulberry32 — tiny, fast, deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

/** A random but always-VALID mandate policy (passes validatePolicy). */
export function randomPolicy(rng: () => number): MandatePolicy {
  return {
    floorPct: randInt(rng, 1, 100),
    maxInstallments: randInt(rng, 1, 12),
    quietHours: { startHour: randInt(rng, 0, 23), endHour: randInt(rng, 0, 23) },
    maxTouchesPerWeek: randInt(rng, 1, 14),
    legalLanguage: rng() < 0.5,
  };
}

export function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'INV-TEST-0001',
    client: { name: 'Test Client', email: 'client@fixture.example' },
    debtor: { entity: 'Test Debtor LLC', contact: 'Pat Debtor', email: 'pat@fixture.example' },
    amountCents: 480_000,
    issuedAt: '2026-04-10T00:00:00.000Z',
    agedDays: 87,
    state: 'CA',
    kind: 'b2b',
    synthetic: true,
    ...overrides,
  };
}
