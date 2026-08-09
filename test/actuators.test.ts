/**
 * Actuator fakes (COMPLEXITY §2) — the wire where three invariants meet:
 * a send needs an unforged, single-use mandate token AND a passing critic
 * receipt whose hash matches the EXACT outbound body (I4), and every send is
 * recorded with msg_sha256 + an RFC-822 message id for the signed ledger.
 */

import { describe, expect, it } from 'vitest';
import { FakeGmail, FakeStripe, FakeFeeMeter, SendRejectedError } from '../src/core/actuators';
import { MandateGate, ForgedTokenError } from '../src/core/mandate';
import { CriticGate, DeterministicCritic } from '../src/core/critic';
import { FixedClock } from '../src/core/types';
import type { ActionRequest, MandatePolicy } from '../src/core/types';

const POLICY: MandatePolicy = { floorPct: 60, maxInstallments: 3, quietHours: { startHour: 21, endHour: 8 }, maxTouchesPerWeek: 5, legalLanguage: false };
const clock = () => new FixedClock('2026-07-06T10:00:00.000Z');
const SEND: ActionRequest = { type: 'send_reminder', invoiceId: 'INV', stage: 1, body: 'body', legal: false };
const gateCtx = { invoiceAmountCents: 200_000, recentSendTimesMs: [], localHour: 10, optedOut: false };

async function setup() {
  const c = clock();
  const gate = new MandateGate(POLICY, c);
  const critic = new CriticGate(new DeterministicCritic(c));
  const gmail = new FakeGmail(gate, critic, c);
  return { gate, critic, gmail };
}

describe('FakeGmail — the send chokepoint', () => {
  it('sends when the token is valid and the receipt matches the body', async () => {
    const { gate, critic, gmail } = await setup();
    const body = 'Hi Dale, a friendly reminder about your invoice. Thanks!';
    const receipt = await critic.requireApproval(body, { legalAllowed: false });
    const token = gate.authorize(SEND, gateCtx);
    const res = await gmail.send(token, { to: 'dale@x.example', subject: 'Invoice', body, criticReceiptId: receipt.receiptId });
    expect(res.to).toBe('dale@x.example');
    expect(res.msgSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.rfc822MessageId).toMatch(/^<recoup-\d{4}-[0-9a-f]{12}@fixture\.recoup\.local>$/);
    expect(gmail.sent.length).toBe(1);
  });

  it('rejects a token this gate never issued (forgery)', async () => {
    const { gmail } = await setup();
    const foreignGate = new MandateGate(POLICY, clock());
    const foreignToken = foreignGate.authorize(SEND, gateCtx); // valid shape, wrong gate
    await expect(gmail.send(foreignToken, { to: 'x@x.example', subject: 's', body: 'b', criticReceiptId: 'cr' })).rejects.toThrowError(ForgedTokenError);
  });

  it('rejects a send with no critic receipt', async () => {
    const { gate, gmail } = await setup();
    const token = gate.authorize(SEND, gateCtx);
    await expect(gmail.send(token, { to: 'x@x.example', subject: 's', body: 'b', criticReceiptId: 'missing' })).rejects.toThrowError(SendRejectedError);
  });

  it('rejects a send carrying a FAIL receipt', async () => {
    const { gate, critic, gmail } = await setup();
    const sharp = 'Pay up or else.';
    const receipt = await critic.review(sharp, { legalAllowed: false }); // fails
    expect(receipt.pass).toBe(false);
    const token = gate.authorize(SEND, gateCtx);
    await expect(gmail.send(token, { to: 'x@x.example', subject: 's', body: sharp, criticReceiptId: receipt.receiptId })).rejects.toThrowError(SendRejectedError);
  });

  it('rejects a receipt whose hash does not match the outbound body (I4)', async () => {
    const { gate, critic, gmail } = await setup();
    const reviewed = await critic.requireApproval('Reviewed body A.', { legalAllowed: false });
    const token = gate.authorize(SEND, gateCtx);
    await expect(gmail.send(token, { to: 'x@x.example', subject: 's', body: 'DIFFERENT body B', criticReceiptId: reviewed.receiptId })).rejects.toThrowError(/body hash mismatch/);
  });
});

describe('FakeStripe', () => {
  it('creates a payment link with the expected fields', async () => {
    const s = new FakeStripe(clock());
    const link = await s.createLink('INV', 0, 480_000);
    expect(link).toMatchObject({ invoiceId: 'INV', installmentIndex: 0, amountCents: 480_000 });
    expect(link.url).toContain('INV');
    expect(s.links.length).toBe(1);
  });
  it('rejects a non-positive amount', async () => {
    await expect(new FakeStripe(clock()).createLink('INV', 0, 0)).rejects.toThrow();
  });
  it('simulatePayment mirrors the link into a payment event', async () => {
    const s = new FakeStripe(clock());
    const link = await s.createLink('INV', 1, 160_000);
    const evt = s.simulatePayment(link.linkId);
    expect(evt).toMatchObject({ linkId: link.linkId, invoiceId: 'INV', installmentIndex: 1, amountCents: 160_000 });
    expect(evt.eventId).toContain('INV');
  });
  it('throws on an unknown link', () => {
    expect(() => new FakeStripe(clock()).simulatePayment('nope')).toThrow();
  });
});

describe('FakeFeeMeter', () => {
  it('meters a 10% success fee, rounded to cents', async () => {
    const s = new FakeStripe(clock());
    const link = await s.createLink('INV', 0, 160_000);
    const fee = await new FakeFeeMeter().meterFee(s.simulatePayment(link.linkId), 10);
    expect(fee.feeCents).toBe(16_000);
    expect(fee.pct).toBe(10);
    expect(fee.invoiceId).toBe('INV');
  });
  it('rejects an out-of-range pct', async () => {
    const s = new FakeStripe(clock());
    const link = await s.createLink('INV', 0, 100);
    await expect(new FakeFeeMeter().meterFee(s.simulatePayment(link.linkId), 101)).rejects.toThrow();
  });
});
