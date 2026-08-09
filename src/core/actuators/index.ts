/**
 * Actuator ports + deterministic in-memory fakes (this session's scope:
 * offline core — no live Gmail OAuth, no live Stripe; the interfaces are the
 * production seam).
 *
 * The Gmail fake is where three invariants meet the wire:
 *   - a send REQUIRES an unforged, single-use MandateGate token (I1/I2 gate),
 *   - a send REQUIRES a PASSING critic receipt for the EXACT draft (I4 —
 *     receipt hash must equal the outbound body hash),
 *   - every send records msg_sha256 + an RFC-822-style message id for the
 *     signed outbound ledger (COMPLEXITY §2).
 */

import { createHash } from 'node:crypto';
import type { AuthorizedAction, MandateGate } from '../mandate';
import type { CriticGate } from '../critic';
import type { Cents, Clock, FeeRow, PaymentEvent, PaymentLink, SendResult } from '../types';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Ports (production seam)
// ---------------------------------------------------------------------------

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
  criticReceiptId: string;
}

export interface GmailSendPort {
  send(auth: AuthorizedAction, msg: OutboundEmail): Promise<SendResult>;
}

export interface StripePaymentLinkPort {
  createLink(invoiceId: string, installmentIndex: number, amountCents: Cents): Promise<PaymentLink>;
}

export interface StripeFeeMeterPort {
  meterFee(payment: PaymentEvent, pct: number): Promise<FeeRow>;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

export class SendRejectedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SendRejectedError';
  }
}

export interface RecordedSend extends SendResult {
  subject: string;
  body: string;
  criticReceiptId: string;
}

/** First-party send fake: the client's own mailbox, in memory. */
export class FakeGmail implements GmailSendPort {
  readonly sent: RecordedSend[] = [];
  private seq = 0;

  constructor(
    private readonly gate: MandateGate,
    private readonly critic: CriticGate,
    private readonly clock: Clock,
  ) {}

  async send(auth: AuthorizedAction, msg: OutboundEmail): Promise<SendResult> {
    // Structural gate: token must have been issued by THIS gate, unused.
    this.gate.confirmExecution(auth);

    // I4: passing receipt, and it must cover this exact draft.
    const receipt = this.critic.getReceipt(msg.criticReceiptId);
    if (!receipt) throw new SendRejectedError(`no critic receipt ${msg.criticReceiptId}`);
    if (!receipt.pass) throw new SendRejectedError(`critic receipt ${msg.criticReceiptId} is a FAIL`);
    if (receipt.reviewedSha256 !== sha256Hex(msg.body)) {
      throw new SendRejectedError('critic receipt does not match the outbound draft (body hash mismatch)');
    }

    this.seq += 1;
    const msgSha256 = sha256Hex(`${msg.to}\n${msg.subject}\n${msg.body}`);
    const result: SendResult = {
      rfc822MessageId: `<recoup-${String(this.seq).padStart(4, '0')}-${msgSha256.slice(0, 12)}@fixture.recoup.local>`,
      msgSha256,
      to: msg.to,
      sentAt: this.clock.now().toISOString(),
    };
    this.sent.push({ ...result, subject: msg.subject, body: msg.body, criticReceiptId: msg.criticReceiptId });
    return result;
  }
}

export class FakeStripe implements StripePaymentLinkPort {
  readonly links: PaymentLink[] = [];
  private linkSeq = 0;
  private evtSeq = 0;

  constructor(private readonly clock: Clock) {}

  async createLink(invoiceId: string, installmentIndex: number, amountCents: Cents): Promise<PaymentLink> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('amountCents must be a positive integer');
    this.linkSeq += 1;
    const link: PaymentLink = {
      linkId: `plink_${String(this.linkSeq).padStart(4, '0')}_${invoiceId}_${installmentIndex}`,
      url: `https://pay.fixture.recoup.local/${invoiceId}/${installmentIndex}/${this.linkSeq}`,
      invoiceId,
      installmentIndex,
      amountCents,
    };
    this.links.push(link);
    return link;
  }

  /** Deterministic webhook simulation: the debtor clicked and paid this link. */
  simulatePayment(linkId: string): PaymentEvent {
    const link = this.links.find((l) => l.linkId === linkId);
    if (!link) throw new Error(`unknown payment link ${linkId}`);
    this.evtSeq += 1;
    return {
      eventId: `evt_${String(this.evtSeq).padStart(4, '0')}_${link.invoiceId}`,
      linkId: link.linkId,
      invoiceId: link.invoiceId,
      installmentIndex: link.installmentIndex,
      amountCents: link.amountCents,
      paidAt: this.clock.now().toISOString(),
    };
  }
}

export class FakeFeeMeter implements StripeFeeMeterPort {
  readonly fees: FeeRow[] = [];
  private seq = 0;

  async meterFee(payment: PaymentEvent, pct: number): Promise<FeeRow> {
    if (pct < 0 || pct > 100) throw new Error('fee pct out of range');
    this.seq += 1;
    const fee: FeeRow = {
      feeId: `fee_${String(this.seq).padStart(4, '0')}_${payment.invoiceId}`,
      invoiceId: payment.invoiceId,
      paymentEventId: payment.eventId,
      feeCents: Math.round((payment.amountCents * pct) / 100),
      pct,
    };
    this.fees.push(fee);
    return fee;
  }
}
