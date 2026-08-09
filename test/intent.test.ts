/**
 * Reply-intent classification (COMPLEXITY §1). The flagship case is the
 * SEED_DATA engineered edge: an ambiguously-phrased hardship reply
 * ("things are tight this quarter, maybe later?") must classify as HARDSHIP,
 * not GHOST — a distinction pure keyword matching gets wrong.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyHeuristic,
  IntentClassifier,
  DeterministicMockAdapter,
  ADAPTER_CONFIDENCE_THRESHOLD,
} from '../src/core/intent';
import {
  HARDSHIP_AMBIGUOUS_REPLY,
  GHOSTY_REPLY,
  OPT_OUT_REPLY,
  DISPUTE_REPLY,
  HOSTILE_REPLY,
  BANKRUPT_REPLY,
  WRONG_CONTACT_REPLY,
  PARTIAL_OFFER_REPLY,
  PROMISE_REPLY,
  PAYING_REPLY,
} from '../src/core/fixtures';
import type { Intent } from '../src/core/types';
import { makeInvoice } from './_util';

const INV = makeInvoice();

describe('classifyHeuristic — the hardship-vs-ghosting edge (SEED_DATA)', () => {
  it('classifies the ambiguous hardship reply as HARDSHIP, not ghost', () => {
    const r = classifyHeuristic(HARDSHIP_AMBIGUOUS_REPLY);
    expect(r.intent).toBe('hardship');
    // the reply also contains a "maybe later" ghost signal; hardship must outweigh it
    expect(r.scores.ghost ?? 0).toBeGreaterThan(0);
    expect((r.scores.hardship ?? 0)).toBeGreaterThan(r.scores.ghost ?? 0);
  });

  it('a pure-deflection reply with no money signal is GHOST', () => {
    expect(classifyHeuristic(GHOSTY_REPLY).intent).toBe('ghost');
  });
});

describe('classifyHeuristic — intent coverage', () => {
  const cases: [string, string, Intent][] = [
    ['opt_out', OPT_OUT_REPLY, 'opt_out'],
    ['dispute', DISPUTE_REPLY, 'dispute'],
    ['hostile', HOSTILE_REPLY, 'hostile'],
    ['bankrupt', BANKRUPT_REPLY, 'bankrupt'],
    ['wrong_contact', WRONG_CONTACT_REPLY, 'wrong_contact'],
    ['counter_offer', PARTIAL_OFFER_REPLY, 'counter_offer'],
    ['promise_to_pay', PROMISE_REPLY, 'promise_to_pay'],
    ['paying', PAYING_REPLY, 'paying'],
  ];
  it.each(cases)('classifies %s', (_label, text, expected) => {
    expect(classifyHeuristic(text).intent).toBe(expected);
  });

  it('opt-out wins by priority even against other signals', () => {
    const r = classifyHeuristic('This is a scam, do not contact me again, unsubscribe.');
    expect(r.intent).toBe('opt_out');
  });

  it('an all-caps shout adds a hostility signal', () => {
    const r = classifyHeuristic('THIS IS COMPLETELY UNACCEPTABLE AND YOU KNOW IT');
    expect(r.intent).toBe('hostile');
    expect(r.matched.some((m) => m.includes('shouting'))).toBe(true);
  });

  it('a no-signal reply is a low-confidence ghost', () => {
    const r = classifyHeuristic('ok');
    expect(r.intent).toBe('ghost');
    expect(r.confidence).toBeLessThan(ADAPTER_CONFIDENCE_THRESHOLD);
  });

  it('confidence is in [0,1] and marked heuristic', () => {
    const r = classifyHeuristic(HARDSHIP_AMBIGUOUS_REPLY);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
    expect(r.source).toBe('heuristic');
  });
});

describe('IntentClassifier — two-stage (heuristic → adapter)', () => {
  it('keeps a high-confidence heuristic verdict without consulting the adapter', async () => {
    let consulted = false;
    const spy = new DeterministicMockAdapter();
    const orig = spy.classify.bind(spy);
    spy.classify = async (t, c) => { consulted = true; return orig(t, c); };
    const clf = new IntentClassifier(spy);
    const r = await clf.classify(OPT_OUT_REPLY, { invoice: INV });
    expect(r.intent).toBe('opt_out');
    expect(r.source).toBe('heuristic');
    expect(consulted).toBe(false);
  });

  it('defers a low-confidence reply to the adapter (pinned fixture)', async () => {
    const pinned = new Map<string, Intent>([['ok', 'paying']]);
    const clf = new IntentClassifier(new DeterministicMockAdapter(pinned));
    const r = await clf.classify('ok', { invoice: INV }); // heuristic → low-confidence ghost
    expect(r.intent).toBe('paying');
    expect(r.source).toBe('adapter');
  });

  it('with no adapter, always returns the heuristic verdict', async () => {
    const clf = new IntentClassifier(null);
    const r = await clf.classify('ok', { invoice: INV });
    expect(r.intent).toBe('ghost');
    expect(r.source).toBe('heuristic');
  });
});

describe('DeterministicMockAdapter', () => {
  it('returns a pinned classification with high confidence', async () => {
    const a = new DeterministicMockAdapter(new Map<string, Intent>([['whatever', 'dispute']]));
    const r = await a.classify('whatever', { invoice: INV });
    expect(r).toMatchObject({ intent: 'dispute', source: 'adapter' });
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });
  it('falls back to the (deterministic) heuristic when unpinned', async () => {
    const a = new DeterministicMockAdapter();
    const r = await a.classify(DISPUTE_REPLY, { invoice: INV });
    expect(r.intent).toBe('dispute');
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });
});
