/**
 * RecoupEngine — the AR clerk orchestrator for the offline core.
 *
 * Wires COMPLEXITY §1's loop end-to-end with deterministic components:
 *   cadence sends → reply classification → strategy/EV → mandate gate →
 *   critic gate → (fake) Gmail send → (fake) Stripe links/webhooks → fee
 *   metering, with EVERY customer-visible action appended to the signed
 *   ledger and every money action passing the MandateGate choke point.
 *
 * Offline conventions (documented, not hidden):
 *   - The debtor's local hour is the injected clock's UTC hour.
 *   - Free-text drafting is deterministic (drafts.ts); production swaps in
 *     Gemini Pro behind the same seam.
 */

import { EscalationMachine, type EventName, type MachineState, type StateName } from '../machine';
import { MandateGate, PolicyViolationError, type AuthorizedAction } from '../mandate';
import { Ledger } from '../ledger';
import { IntentClassifier, DeterministicMockAdapter } from '../intent';
import { decidePlan, buildInstallments, DEFAULT_PARAMS, type NegotiationParams, type PlanDecision } from '../negotiate';
import { CriticGate, DeterministicCritic, CriticBlockedError, renderTemplate, type RenderedEmail } from '../critic';
import { FakeGmail, FakeStripe, FakeFeeMeter, type OutboundEmail } from '../actuators';
import type { Clock, Intent, IntentAdapter, Invoice, PaymentEvent, PaymentLink, PlanProposal } from '../types';
import { usd } from '../types';
import { draftResponse, parseOffer, isAcceptance, formatPlanDetails } from './drafts';

export const SUCCESS_FEE_PCT = 10;

export interface EngineOptions {
  invoice: Invoice;
  policy: unknown; // validated by the gate
  clock: Clock;
  intentAdapter?: IntentAdapter;
  params?: NegotiationParams;
}

export interface ReplyOutcome {
  handled: boolean;
  intent: Intent | 'plan_acceptance' | 'ignored';
  state: MachineState;
  note?: string;
}

export interface TickOutcome {
  acted: 'cadence_send' | 'writeoff' | 'deferred_quiet_hours' | 'noop';
  state: MachineState;
}

interface PendingProposal {
  proposal: PlanProposal;
  strategyHash: string;
  proposalHash: string;
  sendHash: string;
  firstLink: PaymentLink;
}

interface ActivePlan {
  proposal: PlanProposal;
  links: PaymentLink[];
  paid: Set<number>;
  decisionRefs: string[];
}

export class RecoupEngine {
  readonly invoice: Invoice;
  readonly clock: Clock;
  readonly machine: EscalationMachine;
  readonly gate: MandateGate;
  readonly ledger: Ledger;
  readonly criticGate: CriticGate;
  readonly gmail: FakeGmail;
  readonly stripe: FakeStripe;
  readonly feeMeter: FakeFeeMeter;

  private readonly classifier: IntentClassifier;
  private readonly params: NegotiationParams;
  private readonly startedAtMs: number;

  private contactEmail: string;
  private sendTimesMs: number[] = [];
  private optedOut = false;
  private fullLink: PaymentLink | null = null;
  private pending: PendingProposal | null = null;
  private plan: ActivePlan | null = null;
  /** linkId → decision-chain entry hashes that put this link in play (I5). */
  private readonly linkRefs = new Map<string, string[]>();
  private recoveredCentsTotal = 0;

  constructor(opts: EngineOptions) {
    this.invoice = opts.invoice;
    this.clock = opts.clock;
    this.machine = new EscalationMachine();
    this.gate = new MandateGate(opts.policy, opts.clock);
    this.ledger = new Ledger(opts.clock);
    this.criticGate = new CriticGate(new DeterministicCritic(opts.clock));
    this.gmail = new FakeGmail(this.gate, this.criticGate, opts.clock);
    this.stripe = new FakeStripe(opts.clock);
    this.feeMeter = new FakeFeeMeter();
    this.classifier = new IntentClassifier(opts.intentAdapter ?? new DeterministicMockAdapter());
    this.params = opts.params ?? DEFAULT_PARAMS;
    this.startedAtMs = opts.clock.now().getTime();
    this.contactEmail = opts.invoice.debtor.email;
  }

  // -- public views ---------------------------------------------------------

  get state(): MachineState {
    return this.machine.state;
  }

  get isOptedOut(): boolean {
    return this.optedOut;
  }

  get recoveredCents(): number {
    return this.recoveredCentsTotal;
  }

  get executedViolations(): number {
    return this.gate.executedViolations;
  }

  get fullBalanceLink(): PaymentLink | null {
    return this.fullLink;
  }

  get planLinks(): PaymentLink[] {
    return this.plan ? [...this.plan.links] : [];
  }

  get pendingProposal(): PlanProposal | null {
    return this.pending ? { ...this.pending.proposal, installments: [...this.pending.proposal.installments] } : null;
  }

  get sendCount(): number {
    return this.sendTimesMs.length;
  }

  // -- lifecycle ------------------------------------------------------------

  /** Intake + mandate + first cadence touch. */
  async start(): Promise<TickOutcome> {
    this.ledger.append({
      actor: 'intake',
      kind: 'intake',
      invoiceId: this.invoice.id,
      payload: {
        amountCents: this.invoice.amountCents,
        agedDays: this.invoice.agedDays,
        state: this.invoice.state,
        debtorEntity: this.invoice.debtor.entity,
        kind: this.invoice.kind,
        synthetic: this.invoice.synthetic,
      },
    });
    this.ledger.append({
      actor: 'intake',
      kind: 'mandate_signed',
      invoiceId: this.invoice.id,
      payload: { policy: this.gate.policy },
    });
    this.fullLink = await this.stripe.createLink(this.invoice.id, 0, this.invoice.amountCents);
    this.machine.fire('START_CADENCE');
    return this.sendCadenceStage();
  }

  /**
   * Cadence timer fired with no reply: advance the ladder, or recommend a
   * write-off when the ladder is exhausted. Quiet hours defer, never violate.
   */
  async tick(): Promise<TickOutcome> {
    const s = this.machine.state;
    if (this.optedOut || ['PAID', 'CLIENT', 'WRITEOFF_RECOMMENDED', 'OPTED_OUT'].includes(s.name)) {
      return { acted: 'noop', state: this.machine.state };
    }
    if (s.name === 'CADENCE') {
      const max = this.machine.config.maxCadenceSteps;
      if ((s.cadenceStep ?? 1) >= max) {
        await this.recommendWriteoff(
          `No response after ${max} escalating touches over ${this.daysSinceStart()} days on ${usd(this.invoice.amountCents)} ` +
            `(${this.invoice.agedDays + this.daysSinceStart()} days aged). Expected value of further outreach is below effort cost; ` +
            `recommend client write-off review.`,
        );
        return { acted: 'writeoff', state: this.machine.state };
      }
      this.machine.fire('CADENCE_TICK');
      return this.sendCadenceStage();
    }
    // AWAITING/NEGOTIATING/PLAN_ACTIVE ticks are no-ops in the offline core.
    return { acted: 'noop', state: this.machine.state };
  }

  // -- inbound --------------------------------------------------------------

  async handleReply(text: string): Promise<ReplyOutcome> {
    if (this.optedOut || this.machine.state.name === 'OPTED_OUT') {
      return { handled: false, intent: 'ignored', state: this.machine.state, note: 'opted out; thread halted (I3)' };
    }
    if (['PAID', 'CLIENT', 'WRITEOFF_RECOMMENDED'].includes(this.machine.state.name)) {
      return { handled: false, intent: 'ignored', state: this.machine.state, note: 'terminal state' };
    }

    // Pending-plan acceptance is checked before classification (deterministic).
    if (this.pending && this.machine.state.name === 'AWAITING' && isAcceptance(text)) {
      await this.acceptPendingPlan();
      return { handled: true, intent: 'plan_acceptance', state: this.machine.state };
    }

    const result = await this.classifier.classify(text, { invoice: this.invoice });
    const classifyEntry = this.ledger.append({
      actor: 'classifier',
      kind: 'classify',
      invoiceId: this.invoice.id,
      payload: { intent: result.intent, confidence: result.confidence, rationale: result.rationale, source: result.source, textSha256Prefix: undefined },
    });

    switch (result.intent) {
      case 'opt_out': {
        // I3: halt within this tick, permanently. No goodbye email — silence.
        this.machine.fire('OPT_OUT');
        this.optedOut = true;
        this.ledger.append({
          actor: 'strategist',
          kind: 'opt_out',
          invoiceId: this.invoice.id,
          payload: { honored: true, note: 'all outreach permanently halted within one tick' },
          refs: [classifyEntry.entryHash],
        });
        return { handled: true, intent: result.intent, state: this.machine.state };
      }
      case 'dispute': {
        this.ensureNegotiating();
        this.machine.fire('DISPUTE_FLAGGED');
        this.ledger.append({
          actor: 'strategist',
          kind: 'dispute',
          invoiceId: this.invoice.id,
          payload: { note: 'debt contested by debtor; agent will not argue merits' },
          refs: [classifyEntry.entryHash],
        });
        this.machine.fire('HANDOFF_CLIENT');
        this.ledger.append({
          actor: 'strategist',
          kind: 'handoff',
          invoiceId: this.invoice.id,
          payload: { to: 'client', reason: 'dispute requires human judgment on the merits' },
          refs: [classifyEntry.entryHash],
        });
        return { handled: true, intent: result.intent, state: this.machine.state };
      }
      case 'bankrupt': {
        this.ensureNegotiating();
        await this.recommendWriteoff(
          `Debtor states insolvency ("${text.slice(0, 120)}"). Pursuing a bankrupt counterparty is negative expected value ` +
            `and may violate the automatic stay; recommend write-off review by client.`,
          [classifyEntry.entryHash],
        );
        return { handled: true, intent: result.intent, state: this.machine.state };
      }
      case 'wrong_contact': {
        this.ensureNegotiating();
        const email = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0] ?? null;
        const oldEmail = this.contactEmail;
        if (email) this.contactEmail = email;
        this.ledger.append({
          actor: 'strategist',
          kind: 'contact_update',
          invoiceId: this.invoice.id,
          payload: { from: oldEmail, to: this.contactEmail, extracted: email !== null },
          refs: [classifyEntry.entryHash],
        });
        this.machine.fire('CONTACT_CORRECTED');
        await this.sendTemplate('wrong_contact_redirect', {
          invoice_id: this.invoice.id,
          amount: usd(this.invoice.amountCents),
          payment_link: this.requireFullLink().url,
          client_name: this.invoice.client.name,
        }, 'send_reminder', 1);
        return { handled: true, intent: result.intent, state: this.machine.state };
      }
      case 'hardship':
      case 'counter_offer': {
        this.ensureNegotiating();
        const offer = result.intent === 'counter_offer' ? parseOffer(text, this.invoice.amountCents) : { totalCents: null, installments: null };
        await this.negotiatePlan(result.intent, offer.totalCents, offer.installments, classifyEntry.entryHash);
        return { handled: true, intent: result.intent, state: this.machine.state };
      }
      case 'hostile': {
        this.ensureNegotiating();
        await this.hostileBeat(classifyEntry.entryHash);
        return { handled: true, intent: result.intent, state: this.machine.state };
      }
      case 'ghost':
      case 'promise_to_pay':
      case 'paying': {
        this.ensureNegotiating();
        await this.sendFreeText(draftResponse(result.intent, this.invoice, this.requireFullLink().url), result.intent, classifyEntry.entryHash);
        this.machine.fire('PROPOSAL_SENT'); // clerk responded; awaiting the debtor
        return { handled: true, intent: result.intent, state: this.machine.state };
      }
      default:
        return { handled: false, intent: result.intent, state: this.machine.state, note: 'no strategy for intent' };
    }
  }

  // -- payments (webhook entry point) ----------------------------------------

  async handlePaymentWebhook(evt: PaymentEvent): Promise<void> {
    if (evt.invoiceId !== this.invoice.id) throw new Error(`webhook for wrong invoice ${evt.invoiceId}`);
    if (this.machine.state.name === 'PAID') return; // idempotent-ish guard for the offline core

    const paymentEntry = this.ledger.append({
      actor: 'treasury',
      kind: 'payment',
      invoiceId: this.invoice.id,
      payload: { eventId: evt.eventId, linkId: evt.linkId, amountCents: evt.amountCents, installmentIndex: evt.installmentIndex, paidAt: evt.paidAt },
    });

    // I5: the fee row references the payment AND the decision chain that
    // caused this money to move.
    const decisionRefs = this.linkRefs.get(evt.linkId) ?? [];
    if (decisionRefs.length === 0) throw new Error(`no decision chain recorded for link ${evt.linkId} — refusing to meter an unattributable fee`);
    const fee = await this.feeMeter.meterFee(evt, SUCCESS_FEE_PCT);
    this.ledger.append({
      actor: 'treasury',
      kind: 'fee',
      invoiceId: this.invoice.id,
      payload: { feeId: fee.feeId, feeCents: fee.feeCents, pct: fee.pct, paymentEventId: evt.eventId },
      refs: [paymentEntry.entryHash, ...decisionRefs],
    });

    this.recoveredCentsTotal += evt.amountCents;

    if (this.plan && this.plan.links.some((l) => l.linkId === evt.linkId)) {
      this.plan.paid.add(evt.installmentIndex);
      if (this.plan.paid.size === this.plan.proposal.installments.length) {
        this.machine.fire('PAYMENT_FULL');
        this.ledger.append({
          actor: 'treasury',
          kind: 'note',
          invoiceId: this.invoice.id,
          payload: { note: `plan complete: ${this.plan.paid.size}/${this.plan.proposal.installments.length} installments; resolved PAID` },
          refs: [paymentEntry.entryHash],
        });
      } else {
        this.machine.fire('INSTALLMENT_PAID');
      }
      return;
    }

    // Full-balance link (or unknown link treated as full payment attribution).
    this.machine.fire('PAYMENT_FULL');
  }

  // -- actions ---------------------------------------------------------------

  async recommendWriteoff(memo: string, extraRefs: string[] = []): Promise<void> {
    const action = { type: 'recommend_writeoff' as const, invoiceId: this.invoice.id, memo };
    const auth = this.authorizeOrLedgerDeny(action);
    const policyEntry = this.ledgerPolicyCheck(auth);
    this.gate.confirmExecution(auth); // consume the token: write-off is a ledgered act, not a send
    this.machine.fire('WRITEOFF');
    this.ledger.append({
      actor: 'strategist',
      kind: 'writeoff',
      invoiceId: this.invoice.id,
      payload: { memo },
      refs: [policyEntry.entryHash, ...extraRefs],
    });
    this.gate.auditExecuted(action, this.gateCtx());
  }

  // -- internals --------------------------------------------------------------

  private requireFullLink(): PaymentLink {
    if (!this.fullLink) throw new Error('engine not started');
    return this.fullLink;
  }

  private daysSinceStart(): number {
    return Math.floor((this.clock.now().getTime() - this.startedAtMs) / 86_400_000);
  }

  private currentDaysOverdue(): number {
    return this.invoice.agedDays + this.daysSinceStart();
  }

  private localHour(): number {
    return this.clock.now().getUTCHours();
  }

  private gateCtx() {
    return {
      invoiceAmountCents: this.invoice.amountCents,
      recentSendTimesMs: [...this.sendTimesMs],
      localHour: this.localHour(),
      optedOut: this.optedOut,
    };
  }

  private ensureNegotiating(): void {
    const s = this.machine.state.name;
    if (s === 'CADENCE') this.machine.fire('REPLY_ENGAGED');
    else if (s === 'AWAITING') this.machine.fire('REPLY_RECEIVED');
    else if (s !== 'NEGOTIATING') throw new Error(`cannot negotiate from ${s}`);
  }

  private authorizeOrLedgerDeny<A extends Parameters<MandateGate['authorize']>[0]>(action: A): AuthorizedAction<A> {
    try {
      return this.gate.authorize(action, this.gateCtx()) as AuthorizedAction<A>;
    } catch (err) {
      if (err instanceof PolicyViolationError) {
        this.ledger.append({
          actor: 'mandate_gate',
          kind: 'policy_check',
          invoiceId: this.invoice.id,
          payload: { action: action.type, result: 'denied', code: err.code, message: err.message },
        });
      }
      throw err;
    }
  }

  private ledgerPolicyCheck(auth: AuthorizedAction) {
    return this.ledger.append({
      actor: 'mandate_gate',
      kind: 'policy_check',
      invoiceId: this.invoice.id,
      payload: {
        action: auth.action.type,
        result: 'authorized',
        checks: [...auth.checks],
        floorCents: auth.policyFloorCents,
      },
    });
  }

  private async sendCadenceStage(): Promise<TickOutcome> {
    const stage = this.machine.state.cadenceStep ?? 1;
    const templateId = `cadence_${Math.min(stage, 3)}`;
    try {
      await this.sendTemplate(templateId, {
        debtor_name: this.invoice.debtor.contact,
        invoice_id: this.invoice.id,
        amount: usd(this.invoice.amountCents),
        days_overdue: String(this.currentDaysOverdue()),
        payment_link: this.requireFullLink().url,
        client_name: this.invoice.client.name,
      }, 'send_reminder', stage);
      return { acted: 'cadence_send', state: this.machine.state };
    } catch (err) {
      if (err instanceof PolicyViolationError && err.code === 'I2_QUIET_HOURS') {
        this.ledger.append({
          actor: 'strategist',
          kind: 'note',
          invoiceId: this.invoice.id,
          payload: { note: `cadence send deferred: quiet hours (local hour ${this.localHour()})` },
        });
        return { acted: 'deferred_quiet_hours', state: this.machine.state };
      }
      throw err;
    }
  }

  /** Template-locked send path: render → critic receipt → gate → wire → ledger. */
  private async sendTemplate(
    templateId: string,
    vars: Record<string, string>,
    actionType: 'send_reminder' | 'escalate',
    stage: number,
  ): Promise<string> {
    const rendered: RenderedEmail = renderTemplate(templateId, vars);
    const verdict = await this.criticGate.requireApproval(rendered.body, { legalAllowed: this.gate.policy.legalLanguage });
    const criticEntry = this.ledger.append({
      actor: 'critic',
      kind: 'critic_receipt',
      invoiceId: this.invoice.id,
      payload: { receiptId: verdict.receiptId, pass: verdict.pass, reasons: verdict.reasons, reviewedSha256: verdict.reviewedSha256, model: verdict.model, templateId, templateHash: rendered.templateHash },
    });

    const action =
      actionType === 'send_reminder'
        ? { type: 'send_reminder' as const, invoiceId: this.invoice.id, stage, body: rendered.body, legal: rendered.legal }
        : { type: 'escalate' as const, invoiceId: this.invoice.id, toStage: stage, body: rendered.body, legal: rendered.legal };
    const auth = this.authorizeOrLedgerDeny(action);
    const policyEntry = this.ledgerPolicyCheck(auth);

    const outbound: OutboundEmail = { to: this.contactEmail, subject: rendered.subject, body: rendered.body, criticReceiptId: verdict.receiptId };
    const sent = await this.gmail.send(auth, outbound);
    this.sendTimesMs.push(this.clock.now().getTime());

    const sendEntry = this.ledger.append({
      actor: 'sender',
      kind: 'send',
      invoiceId: this.invoice.id,
      payload: {
        templateId,
        stage,
        to: sent.to,
        rfc822MessageId: sent.rfc822MessageId,
        msgSha256: sent.msgSha256,
        criticReceiptId: verdict.receiptId,
      },
      refs: [criticEntry.entryHash, policyEntry.entryHash],
    });
    this.gate.auditExecuted(action, this.gateCtx());

    // This send carried the full-balance link: refresh its decision chain.
    this.linkRefs.set(this.requireFullLink().linkId, [policyEntry.entryHash, sendEntry.entryHash]);
    return sendEntry.entryHash;
  }

  /** Free-text send path: critic MUST pass (I4); no template lock to lean on. */
  private async sendFreeText(body: string, intent: Intent, classifyRef: string): Promise<string> {
    const verdict = await this.criticGate.requireApproval(body, { intent, legalAllowed: this.gate.policy.legalLanguage });
    const criticEntry = this.ledger.append({
      actor: 'critic',
      kind: 'critic_receipt',
      invoiceId: this.invoice.id,
      payload: { receiptId: verdict.receiptId, pass: true, reasons: [], reviewedSha256: verdict.reviewedSha256, model: verdict.model, freeText: true },
      refs: [classifyRef],
    });
    const action = { type: 'send_free_text' as const, invoiceId: this.invoice.id, body, legal: false, criticReceiptId: verdict.receiptId };
    const auth = this.authorizeOrLedgerDeny(action);
    const policyEntry = this.ledgerPolicyCheck(auth);
    const sent = await this.gmail.send(auth, { to: this.contactEmail, subject: `Re: Invoice ${this.invoice.id}`, body, criticReceiptId: verdict.receiptId });
    this.sendTimesMs.push(this.clock.now().getTime());
    const sendEntry = this.ledger.append({
      actor: 'sender',
      kind: 'send',
      invoiceId: this.invoice.id,
      payload: { freeText: true, intent, to: sent.to, rfc822MessageId: sent.rfc822MessageId, msgSha256: sent.msgSha256, criticReceiptId: verdict.receiptId },
      refs: [criticEntry.entryHash, policyEntry.entryHash, classifyRef],
    });
    this.gate.auditExecuted(action, this.gateCtx());
    this.linkRefs.set(this.requireFullLink().linkId, [policyEntry.entryHash, sendEntry.entryHash]);
    return sendEntry.entryHash;
  }

  /**
   * The SEED_DATA hostile beat: the deterministic drafter produces a
   * too-sharp draft; the critic BLOCKS it (fail receipt on the ledger); the
   * strategist re-tones via the locked de-escalation template and sends that.
   */
  private async hostileBeat(classifyRef: string): Promise<void> {
    const sharpDraft = draftResponse('hostile', this.invoice, this.requireFullLink().url);
    const verdict = await this.criticGate.review(sharpDraft, { intent: 'hostile', legalAllowed: this.gate.policy.legalLanguage });
    this.ledger.append({
      actor: 'critic',
      kind: 'critic_receipt',
      invoiceId: this.invoice.id,
      payload: { receiptId: verdict.receiptId, pass: verdict.pass, reasons: verdict.reasons, reviewedSha256: verdict.reviewedSha256, model: verdict.model, blockedDraft: true },
      refs: [classifyRef],
    });
    if (verdict.pass) throw new Error('critic unexpectedly passed the sharp draft — deterministic critic rules changed?');
    this.ledger.append({
      actor: 'strategist',
      kind: 'strategy',
      invoiceId: this.invoice.id,
      payload: { note: 'draft blocked by compliance critic; re-toning via locked de-escalation template', blockedReceiptId: verdict.receiptId },
      refs: [classifyRef],
    });
    await this.sendTemplate('de_escalation', {
      debtor_name: this.invoice.debtor.contact,
      invoice_id: this.invoice.id,
      amount: usd(this.invoice.amountCents),
      payment_link: this.requireFullLink().url,
      client_name: this.invoice.client.name,
    }, 'send_reminder', this.machine.state.cadenceStep ?? 1);
    this.machine.fire('PROPOSAL_SENT');
  }

  /** Hardship/counter-offer → EV strategy → (gated) plan proposal. */
  private async negotiatePlan(
    intent: Intent,
    offeredTotalCents: number | null,
    requestedInstallments: number | null,
    classifyRef: string,
  ): Promise<void> {
    // Demo-honest denial: if the debtor's raw offer is below the floor, show
    // the gate refusing to accept it BEFORE countering within mandate.
    if (offeredTotalCents !== null && offeredTotalCents > 0) {
      const floor = this.gate.floorCents(this.invoice.amountCents);
      if (offeredTotalCents < floor) {
        try {
          this.authorizeOrLedgerDeny({
            type: 'accept_plan',
            invoiceId: this.invoice.id,
            proposal: { totalCents: offeredTotalCents, installments: buildInstallments(offeredTotalCents, 1), cadenceDays: this.params.cadenceDays },
          });
          throw new Error('gate accepted a below-floor offer — I1 broken');
        } catch (err) {
          if (!(err instanceof PolicyViolationError)) throw err;
          // denial already ledgered by authorizeOrLedgerDeny
        }
      }
    }

    const decision: PlanDecision = decidePlan(this.invoice, this.gate.policy, intent, offeredTotalCents, requestedInstallments, this.params);
    const strategyEntry = this.ledger.append({
      actor: 'negotiator',
      kind: 'strategy',
      invoiceId: this.invoice.id,
      payload: {
        intent,
        decision: decision.decision,
        ev: decision.ev,
        floorCents: decision.floorCents,
        rulepack: decision.rulepack,
        narrative: decision.narrative,
        offeredTotalCents,
        requestedInstallments,
      },
      refs: [classifyRef],
    });

    if (decision.decision !== 'propose_plan' || !decision.proposal) {
      await this.sendFreeText(draftResponse('ghost', this.invoice, this.requireFullLink().url), intent, classifyRef);
      this.machine.fire('PROPOSAL_SENT');
      return;
    }

    const proposal = decision.proposal;
    const firstLink = await this.stripe.createLink(this.invoice.id, 0, proposal.installments[0]!);

    const rendered = renderTemplate('plan_proposal', {
      debtor_name: this.invoice.debtor.contact,
      invoice_id: this.invoice.id,
      amount: usd(this.invoice.amountCents),
      plan_details: formatPlanDetails(proposal.installments, proposal.cadenceDays),
      payment_link: firstLink.url,
      client_name: this.invoice.client.name,
    });
    const verdict = await this.criticGate.requireApproval(rendered.body, { intent, legalAllowed: this.gate.policy.legalLanguage });
    const criticEntry = this.ledger.append({
      actor: 'critic',
      kind: 'critic_receipt',
      invoiceId: this.invoice.id,
      payload: { receiptId: verdict.receiptId, pass: true, reasons: [], reviewedSha256: verdict.reviewedSha256, model: verdict.model, templateId: 'plan_proposal' },
      refs: [strategyEntry.entryHash],
    });

    const action = { type: 'propose_plan' as const, invoiceId: this.invoice.id, proposal, body: rendered.body, legal: false, criticReceiptId: verdict.receiptId };
    const auth = this.authorizeOrLedgerDeny(action);
    const policyEntry = this.ledgerPolicyCheck(auth);

    const proposalEntry = this.ledger.append({
      actor: 'negotiator',
      kind: 'proposal',
      invoiceId: this.invoice.id,
      payload: { proposal, evPlanCents: decision.ev.evPlanCents, evHoldoutCents: decision.ev.evHoldoutCents },
      refs: [strategyEntry.entryHash, policyEntry.entryHash],
    });

    const sent = await this.gmail.send(auth, { to: this.contactEmail, subject: rendered.subject, body: rendered.body, criticReceiptId: verdict.receiptId });
    this.sendTimesMs.push(this.clock.now().getTime());
    const sendEntry = this.ledger.append({
      actor: 'sender',
      kind: 'send',
      invoiceId: this.invoice.id,
      payload: { templateId: 'plan_proposal', to: sent.to, rfc822MessageId: sent.rfc822MessageId, msgSha256: sent.msgSha256, criticReceiptId: verdict.receiptId },
      refs: [criticEntry.entryHash, policyEntry.entryHash, proposalEntry.entryHash],
    });
    this.gate.auditExecuted(action, this.gateCtx());

    this.machine.fire('PROPOSAL_SENT');
    this.pending = {
      proposal,
      strategyHash: strategyEntry.entryHash,
      proposalHash: proposalEntry.entryHash,
      sendHash: sendEntry.entryHash,
      firstLink,
    };
    this.linkRefs.set(firstLink.linkId, [strategyEntry.entryHash, proposalEntry.entryHash, sendEntry.entryHash]);
  }

  /** Debtor accepted the pending proposal: I1 re-check, then activate the plan. */
  private async acceptPendingPlan(): Promise<void> {
    const pending = this.pending;
    if (!pending) throw new Error('no pending proposal to accept');
    const action = { type: 'accept_plan' as const, invoiceId: this.invoice.id, proposal: pending.proposal };
    const auth = this.authorizeOrLedgerDeny(action);
    const policyEntry = this.ledgerPolicyCheck(auth);
    this.gate.confirmExecution(auth); // consume; acceptance is a ledgered act
    this.machine.fire('PLAN_ACCEPTED');

    const acceptedEntry = this.ledger.append({
      actor: 'negotiator',
      kind: 'plan_accepted',
      invoiceId: this.invoice.id,
      payload: { proposal: pending.proposal },
      refs: [pending.proposalHash, policyEntry.entryHash],
    });
    this.gate.auditExecuted(action, this.gateCtx());

    const links: PaymentLink[] = [pending.firstLink];
    for (let i = 1; i < pending.proposal.installments.length; i++) {
      links.push(await this.stripe.createLink(this.invoice.id, i, pending.proposal.installments[i]!));
    }
    const decisionRefs = [pending.strategyHash, pending.proposalHash, acceptedEntry.entryHash, pending.sendHash];
    for (const link of links) this.linkRefs.set(link.linkId, decisionRefs);

    this.plan = { proposal: pending.proposal, links, paid: new Set(), decisionRefs };
    this.pending = null;
  }
}

export type { StateName, EventName };
