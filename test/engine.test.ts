/**
 * RecoupEngine end-to-end (COMPLEXITY §1 loop). Drives the whole offline core:
 * cadence → classify → EV strategy → mandate gate → critic gate → (fake) send →
 * (fake) Stripe link/webhook → fee metering, asserting invariants at each beat
 * and full ledger verification (I5/I6) on the resulting chain.
 */

import { describe, expect, it } from 'vitest';
import { RecoupEngine } from '../src/core/engine';
import { verifyChain } from '../src/core/ledger';
import { FixedClock } from '../src/core/types';
import {
  AUSTIN_DESIGNER,
  HOSTILE_HARRY,
  GHOST_LLC,
  QUICK_WIN,
  DEFAULT_POLICY,
  SIM_START_ISO,
  HARDSHIP_AMBIGUOUS_REPLY,
  ACCEPTANCE_REPLY,
  HOSTILE_REPLY,
  OPT_OUT_REPLY,
  DISPUTE_REPLY,
  BANKRUPT_REPLY,
  PARTIAL_OFFER_REPLY,
} from '../src/core/fixtures';

const clock = () => new FixedClock(SIM_START_ISO);
const engine = (over: Partial<ConstructorParameters<typeof RecoupEngine>[0]> = {}) =>
  new RecoupEngine({ invoice: AUSTIN_DESIGNER, policy: DEFAULT_POLICY, clock: clock(), ...over });

describe('RecoupEngine — the Austin hardship money shot', () => {
  it('cadence → hardship → 3×$1,600 plan → accept → pay → fee metering → PAID', async () => {
    const e = engine();
    const started = await e.start();
    expect(started.acted).toBe('cadence_send');
    expect(e.sendCount).toBe(1);

    const r1 = await e.handleReply(HARDSHIP_AMBIGUOUS_REPLY);
    expect(r1.intent).toBe('hardship');
    expect(e.state.name).toBe('AWAITING');
    // THE money shot: an ambiguous hardship reply becomes a 3×$1,600 plan inside policy.
    expect(e.pendingProposal?.installments).toEqual([160_000, 160_000, 160_000]);

    const r2 = await e.handleReply(ACCEPTANCE_REPLY);
    expect(r2.intent).toBe('plan_acceptance');
    expect(e.state.name).toBe('PLAN_ACTIVE');
    expect(e.planLinks.length).toBe(3);

    for (let i = 0; i < 3; i++) {
      await e.handlePaymentWebhook(e.stripe.simulatePayment(e.planLinks[i]!.linkId));
    }
    expect(e.state.name).toBe('PAID');
    expect(e.recoveredCents).toBe(480_000);
    expect(e.executedViolations).toBe(0);

    // Every success fee is causally linked to its payment + decision chain (I5).
    const chain = verifyChain(e.ledger.all());
    expect(chain.ok).toBe(true);
    expect(chain.feeRowsChecked).toBe(3);
    expect(e.feeMeter.fees.reduce((a, f) => a + f.feeCents, 0)).toBe(48_000); // 10% of $4,800
  });
});

describe('RecoupEngine — opt-out halts everything (I3)', () => {
  it('honors opt-out within one tick and never sends again', async () => {
    const e = engine();
    await e.start();
    const r = await e.handleReply(OPT_OUT_REPLY);
    expect(r.intent).toBe('opt_out');
    expect(e.isOptedOut).toBe(true);
    expect(e.state.name).toBe('OPTED_OUT');

    const before = e.sendCount;
    await e.tick(); // cadence timer still fires…
    expect(e.sendCount).toBe(before); // …but nothing goes out
    const again = await e.handleReply('are you there?');
    expect(again.handled).toBe(false);
    expect(e.executedViolations).toBe(0);
  });
});

describe('RecoupEngine — dispute and insolvency exits', () => {
  it('a disputed debt is flagged and handed off to the human client', async () => {
    const e = engine();
    await e.start();
    const r = await e.handleReply(DISPUTE_REPLY);
    expect(r.intent).toBe('dispute');
    expect(e.state.name).toBe('CLIENT');
    expect(e.ledger.byKind('handoff').length).toBe(1);
    expect(e.executedViolations).toBe(0);
  });

  it('a bankrupt debtor triggers a reasoned write-off instead of wasted effort', async () => {
    const e = engine({ invoice: GHOST_LLC });
    await e.start();
    const r = await e.handleReply(BANKRUPT_REPLY);
    expect(r.intent).toBe('bankrupt');
    expect(e.state.name).toBe('WRITEOFF_RECOMMENDED');
    const memo = (e.ledger.byKind('writeoff')[0]!.payload as { memo: string }).memo;
    expect(memo.length).toBeGreaterThanOrEqual(40);
  });
});

describe('RecoupEngine — ghost ladder exhaustion', () => {
  it('escalates three touches then recommends a write-off', async () => {
    const c = clock();
    const e = new RecoupEngine({ invoice: GHOST_LLC, policy: DEFAULT_POLICY, clock: c });
    await e.start(); // stage 1
    c.advanceDays(7); await e.tick(); // stage 2
    c.advanceDays(7); await e.tick(); // stage 3
    c.advanceDays(7); const last = await e.tick(); // exhausted → write-off
    expect(e.sendCount).toBe(3);
    expect(last.acted).toBe('writeoff');
    expect(e.state.name).toBe('WRITEOFF_RECOMMENDED');
    expect(e.executedViolations).toBe(0);
  });
});

describe('RecoupEngine — quiet hours defer, never violate (I2)', () => {
  it('a send scheduled inside quiet hours is deferred, then goes out once clear', async () => {
    const c = new FixedClock('2026-07-06T23:00:00.000Z'); // hour 23 ∈ [21,8)
    const e = new RecoupEngine({ invoice: AUSTIN_DESIGNER, policy: DEFAULT_POLICY, clock: c });
    const started = await e.start();
    expect(started.acted).toBe('deferred_quiet_hours');
    expect(e.sendCount).toBe(0);
    expect(e.ledger.byKind('note').some((n) => JSON.stringify(n.payload).includes('quiet hours'))).toBe(true);

    c.advanceToHour(10); // next 10:00, outside quiet
    const t = await e.tick();
    expect(t.acted).toBe('cadence_send');
    expect(e.sendCount).toBe(1);
    expect(e.executedViolations).toBe(0);
  });
});

describe('RecoupEngine — immediate payer', () => {
  it('a full-balance payment resolves to PAID and meters one fee', async () => {
    const e = engine({ invoice: QUICK_WIN });
    await e.start();
    const link = e.fullBalanceLink!;
    await e.handlePaymentWebhook(e.stripe.simulatePayment(link.linkId));
    expect(e.state.name).toBe('PAID');
    expect(e.recoveredCents).toBe(120_000);
    expect(e.feeMeter.fees[0]!.feeCents).toBe(12_000);
    expect(verifyChain(e.ledger.all()).feeRowsChecked).toBe(1);
  });
});

describe('RecoupEngine — below-floor counter-offer is visibly refused, then countered at floor', () => {
  it('refuses a 50% accept and settles at the 60% floor in 3 parts', async () => {
    const e = engine();
    await e.start();
    const r = await e.handleReply(PARTIAL_OFFER_REPLY); // "50%"
    expect(r.intent).toBe('counter_offer');
    expect(e.gate.deniedCount).toBeGreaterThanOrEqual(1); // the below-floor accept was denied on the record
    expect(e.pendingProposal?.totalCents).toBe(288_000); // 60% floor
    await e.handleReply('Deal. Works for us.');
    for (let i = 0; i < 3; i++) await e.handlePaymentWebhook(e.stripe.simulatePayment(e.planLinks[i]!.linkId));
    expect(e.state.name).toBe('PAID');
    expect(e.recoveredCents).toBe(288_000);
    expect(e.executedViolations).toBe(0);
  });
});

describe('RecoupEngine — hostile draft is blocked before it can ship', () => {
  it('the too-sharp draft never reaches the wire; a de-escalation goes instead', async () => {
    const e = engine({ invoice: HOSTILE_HARRY });
    await e.start();
    const sendsBefore = e.sendCount;
    await e.handleReply(HOSTILE_REPLY);
    expect(e.criticGate.failCount).toBe(1); // the sharp draft produced a FAIL receipt
    expect(e.sendCount).toBe(sendsBefore + 1); // exactly one (de-escalation) send went out
    // the blocked draft is never among the sent bodies
    expect(e.gmail.sent.some((s) => /pay up/i.test(s.body))).toBe(false);
    expect(e.executedViolations).toBe(0);
  });
});
