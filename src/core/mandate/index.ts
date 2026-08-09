/**
 * Settlement-mandate middleware (COMPLEXITY §3, invariants I1/I2/I4).
 *
 * Every money/send action must pass through MandateGate.authorize() which
 * returns an *unforgeable* AuthorizedAction token (tracked in a module-private
 * WeakSet). Actuators call gate.confirmExecution(token) before acting; a token
 * that was never issued by the gate throws and is counted as a blocked forgery
 * — it can never execute. Below-floor or out-of-hours actions are therefore
 * STRUCTURALLY impossible, not merely discouraged.
 *
 * Violation semantics:
 *   - deniedCount / blockedForgeries: attempts the gate stopped (expected > 0
 *     in adversarial tests).
 *   - executedViolations: policy-breaking actions that actually executed.
 *     This is the published metric and MUST provably stay 0.
 */

import type { ActionRequest, Clock, MandatePolicy, PlanProposal, QuietHours } from '../types';

// ---------------------------------------------------------------------------
// Policy validation (machine-validated mandate)
// ---------------------------------------------------------------------------

export class PolicyValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid mandate policy: ${problems.join('; ')}`);
    this.name = 'PolicyValidationError';
  }
}

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

export function validatePolicy(p: unknown): MandatePolicy {
  const problems: string[] = [];
  const o = (p ?? {}) as Record<string, unknown>;

  const floorPct = o.floorPct;
  if (typeof floorPct !== 'number' || !Number.isFinite(floorPct)) problems.push('floorPct must be a finite number');
  else if (floorPct <= 0 || floorPct > 100) problems.push('floorPct must be in (0, 100]');

  const maxInstallments = o.maxInstallments;
  if (!isInt(maxInstallments)) problems.push('maxInstallments must be an integer');
  else if (maxInstallments < 1 || maxInstallments > 12) problems.push('maxInstallments must be in [1, 12]');

  const qh = o.quietHours as QuietHours | undefined;
  if (!qh || !isInt(qh.startHour) || !isInt(qh.endHour)) problems.push('quietHours.{startHour,endHour} must be integers');
  else {
    if (qh.startHour < 0 || qh.startHour > 23) problems.push('quietHours.startHour must be in [0, 23]');
    if (qh.endHour < 0 || qh.endHour > 23) problems.push('quietHours.endHour must be in [0, 23]');
  }

  const mt = o.maxTouchesPerWeek;
  if (!isInt(mt)) problems.push('maxTouchesPerWeek must be an integer');
  else if (mt < 1 || mt > 14) problems.push('maxTouchesPerWeek must be in [1, 14]');

  if (typeof o.legalLanguage !== 'boolean') problems.push('legalLanguage must be a boolean');

  if (problems.length) throw new PolicyValidationError(problems);
  return {
    floorPct: floorPct as number,
    maxInstallments: maxInstallments as number,
    quietHours: { startHour: (qh as QuietHours).startHour, endHour: (qh as QuietHours).endHour },
    maxTouchesPerWeek: mt as number,
    legalLanguage: o.legalLanguage as boolean,
  };
}

// ---------------------------------------------------------------------------
// Quiet hours (I2)
// ---------------------------------------------------------------------------

/** start === end ⇒ empty quiet window. Window is [start, end) with wraparound. */
export function inQuietHours(hour: number, qh: QuietHours): boolean {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`bad hour ${hour}`);
  if (qh.startHour === qh.endHour) return false;
  if (qh.startHour < qh.endHour) return hour >= qh.startHour && hour < qh.endHour;
  return hour >= qh.startHour || hour < qh.endHour; // wraps midnight
}

// ---------------------------------------------------------------------------
// Proposal validation (I1)
// ---------------------------------------------------------------------------

export function validateProposalShape(p: PlanProposal): string[] {
  const problems: string[] = [];
  if (!isInt(p.totalCents) || p.totalCents <= 0) problems.push('totalCents must be a positive integer (cents)');
  if (!Array.isArray(p.installments) || p.installments.length === 0) problems.push('installments must be non-empty');
  else {
    if (p.installments.some((i) => !isInt(i) || i <= 0)) problems.push('every installment must be a positive integer (cents)');
    const sum = p.installments.reduce((a, b) => a + b, 0);
    if (sum !== p.totalCents) problems.push(`installments sum ${sum} != totalCents ${p.totalCents}`);
  }
  if (!isInt(p.cadenceDays) || p.cadenceDays < 1 || p.cadenceDays > 90) problems.push('cadenceDays must be in [1, 90]');
  return problems;
}

// ---------------------------------------------------------------------------
// Authorization tokens
// ---------------------------------------------------------------------------

export interface AuthorizedAction<A extends ActionRequest = ActionRequest> {
  readonly action: A;
  readonly checks: readonly string[]; // which invariant checks ran
  readonly policyFloorCents: number;
  readonly issuedAt: string;
}

export class PolicyViolationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

export class ForgedTokenError extends Error {
  constructor() {
    super('actuator received a token not issued by the mandate gate');
    this.name = 'ForgedTokenError';
  }
}

export interface GateContext {
  invoiceAmountCents: number;
  /** Timestamps (ms epoch) of prior outbound touches, for the weekly cap. */
  recentSendTimesMs: number[];
  /** Debtor-local hour of "now" (the engine derives it from the clock). */
  localHour: number;
  /** True once the debtor opted out — I3 makes everything undeniable-deny. */
  optedOut: boolean;
}

export interface DenialRecord {
  code: string;
  actionType: string;
  message: string;
  ts: string;
}

const SEND_TYPES: ReadonlySet<string> = new Set(['send_reminder', 'send_free_text', 'propose_plan', 'escalate']);

export class MandateGate {
  readonly policy: MandatePolicy;
  private readonly issued = new WeakSet<object>();
  private readonly clock: Clock;

  /** Attempts the gate denied. Expected non-zero in adversarial suites. */
  readonly denials: DenialRecord[] = [];
  /** Forged/unissued tokens presented to confirmExecution. Blocked, counted. */
  private _blockedForgeries = 0;
  /**
   * Policy-breaking actions that actually EXECUTED. The published metric.
   * Nothing in this module ever increments it on a deny path; property tests
   * assert it stays 0 across randomized adversarial load.
   */
  private _executedViolations = 0;

  constructor(policy: unknown, clock: Clock) {
    this.policy = validatePolicy(policy);
    this.clock = clock;
  }

  get executedViolations(): number {
    return this._executedViolations;
  }

  get blockedForgeries(): number {
    return this._blockedForgeries;
  }

  get deniedCount(): number {
    return this.denials.length;
  }

  floorCents(invoiceAmountCents: number): number {
    return Math.ceil((invoiceAmountCents * this.policy.floorPct) / 100);
  }

  private deny(code: string, action: ActionRequest, message: string): never {
    this.denials.push({ code, actionType: action.type, message, ts: this.clock.now().toISOString() });
    throw new PolicyViolationError(code, message);
  }

  /**
   * The single choke point. Returns an unforgeable token or throws
   * PolicyViolationError. No token ⇒ no actuator will act.
   */
  authorize<A extends ActionRequest>(action: A, ctx: GateContext): AuthorizedAction<A> {
    const checks: string[] = [];

    // I3 — opted-out invoices accept no further actions of any kind.
    if (ctx.optedOut) this.deny('I3_OPT_OUT', action, 'debtor opted out; all actions halted permanently');
    checks.push('I3:not-opted-out');

    if (SEND_TYPES.has(action.type)) {
      // I2 — quiet hours.
      if (inQuietHours(ctx.localHour, this.policy.quietHours)) {
        this.deny(
          'I2_QUIET_HOURS',
          action,
          `send at local hour ${ctx.localHour} falls inside quiet hours ${this.policy.quietHours.startHour}-${this.policy.quietHours.endHour}`,
        );
      }
      checks.push('I2:quiet-hours');

      // I2 — weekly touch cap.
      const nowMs = this.clock.now().getTime();
      const weekAgo = nowMs - 7 * 24 * 3_600_000;
      const touches = ctx.recentSendTimesMs.filter((t) => t > weekAgo && t <= nowMs).length;
      if (touches >= this.policy.maxTouchesPerWeek) {
        this.deny('I2_TOUCH_CAP', action, `weekly touch cap reached (${touches}/${this.policy.maxTouchesPerWeek})`);
      }
      checks.push('I2:touch-cap');

      // I4 — legal language needs the explicit mandate toggle.
      if ('legal' in action && action.legal && !this.policy.legalLanguage) {
        this.deny('I4_LEGAL_LANGUAGE', action, 'legal language is disabled by the mandate');
      }
      checks.push('I4:legal-toggle');
    }

    if (action.type === 'propose_plan' || action.type === 'accept_plan') {
      const proposal = action.proposal;
      const shapeProblems = validateProposalShape(proposal);
      if (shapeProblems.length) this.deny('I1_SHAPE', action, `malformed proposal: ${shapeProblems.join('; ')}`);
      checks.push('I1:shape');

      const floor = this.floorCents(ctx.invoiceAmountCents);
      if (proposal.totalCents < floor) {
        this.deny(
          'I1_FLOOR',
          action,
          `proposal total ${proposal.totalCents}c is below mandate floor ${floor}c (${this.policy.floorPct}% of ${ctx.invoiceAmountCents}c)`,
        );
      }
      checks.push('I1:floor');

      if (proposal.installments.length > this.policy.maxInstallments) {
        this.deny(
          'I1_INSTALLMENTS',
          action,
          `${proposal.installments.length} installments exceeds mandate max ${this.policy.maxInstallments}`,
        );
      }
      checks.push('I1:installments');
    }

    if (action.type === 'recommend_writeoff') {
      if (typeof action.memo !== 'string' || action.memo.trim().length < 40) {
        this.deny('WRITEOFF_MEMO', action, 'recommend_writeoff requires a reasoned memo (>= 40 chars)');
      }
      checks.push('writeoff:memo');
    }

    const token: AuthorizedAction<A> = Object.freeze({
      action,
      checks: Object.freeze(checks.slice()),
      policyFloorCents: this.floorCents(ctx.invoiceAmountCents),
      issuedAt: this.clock.now().toISOString(),
    });
    this.issued.add(token);
    return token;
  }

  /** True iff this exact token object came out of authorize(). */
  isIssued(token: object): boolean {
    return this.issued.has(token);
  }

  /**
   * Actuators MUST call this before acting. Forged/unissued tokens throw and
   * are counted as blocked; they can never execute.
   */
  confirmExecution(token: AuthorizedAction): void {
    if (!this.issued.has(token)) {
      this._blockedForgeries += 1;
      throw new ForgedTokenError();
    }
    // Defense in depth: a token is single-use. Replay = forgery.
    this.issued.delete(token);
  }

  /**
   * Post-hoc audit hook for tests/simulator: report an action that actually
   * executed, so an (impossible-by-construction) breach would be visible in
   * the published counter rather than hidden.
   */
  auditExecuted(action: ActionRequest, ctx: GateContext): void {
    let violated = false;
    if (ctx.optedOut) violated = true;
    if (SEND_TYPES.has(action.type) && inQuietHours(ctx.localHour, this.policy.quietHours)) violated = true;
    if ((action.type === 'propose_plan' || action.type === 'accept_plan') &&
        action.proposal.totalCents < this.floorCents(ctx.invoiceAmountCents)) violated = true;
    if ((action.type === 'propose_plan' || action.type === 'accept_plan') &&
        action.proposal.installments.length > this.policy.maxInstallments) violated = true;
    if (SEND_TYPES.has(action.type) && 'legal' in action && action.legal && !this.policy.legalLanguage) violated = true;
    if (violated) this._executedViolations += 1;
  }
}
