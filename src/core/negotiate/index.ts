/**
 * Negotiation engine (COMPLEXITY §3): installment-plan expected value vs
 * holdout, using statutory late interest from versioned state rulepacks.
 * Every decision returns the full calculation so the ledger row and the
 * replay UI can show the math (SEED_DATA's split-screen beat).
 */

import type { Cents, Intent, Invoice, MandatePolicy, PlanProposal } from '../types';
import { getRulepack, lateInterest, type InterestCalc, type Rulepack } from './rulepacks';

export interface NegotiationParams {
  /** P(debtor completes an agreed plan), first installment. */
  pPlanBase: number;
  /** Multiplicative decay per subsequent installment. */
  installmentDecay: number;
  /** P(debtor eventually pays in full if we hold out), by intent. */
  pHoldoutByIntent: Partial<Record<Intent, number>>;
  /** Days further we would hold out before escalating again. */
  holdoutHorizonDays: number;
  /** Default days between installments. */
  cadenceDays: number;
}

export const DEFAULT_PARAMS: NegotiationParams = {
  pPlanBase: 0.85,
  installmentDecay: 0.95,
  pHoldoutByIntent: {
    hardship: 0.35,
    counter_offer: 0.45,
    promise_to_pay: 0.5,
    ghost: 0.2,
    hostile: 0.25,
  },
  holdoutHorizonDays: 60,
  cadenceDays: 30,
};

/** Split total into n installments that sum EXACTLY; remainder goes to the earliest parts. */
export function buildInstallments(totalCents: Cents, n: number): Cents[] {
  if (!Number.isInteger(totalCents) || totalCents <= 0) throw new Error('totalCents must be a positive integer');
  if (!Number.isInteger(n) || n < 1) throw new Error('n must be >= 1');
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  const parts = Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
  if (parts.reduce((a, b) => a + b, 0) !== totalCents) throw new Error('installment split invariant broken');
  return parts;
}

export interface EvBreakdown {
  evPlanCents: number;
  evHoldoutCents: number;
  pPlanPerInstallment: number[];
  pHoldout: number;
  holdoutInterest: InterestCalc;
  holdoutNominalCents: Cents;
  formulaPlan: string;
  formulaHoldout: string;
}

export function evOfPlan(proposal: PlanProposal, params: NegotiationParams): { ev: number; ps: number[]; formula: string } {
  const ps: number[] = [];
  let ev = 0;
  proposal.installments.forEach((inst, i) => {
    const p = params.pPlanBase * Math.pow(params.installmentDecay, i);
    ps.push(Number(p.toFixed(4)));
    ev += inst * p;
  });
  const formula = proposal.installments.map((inst, i) => `${inst}c×${ps[i]}`).join(' + ');
  return { ev, ps, formula };
}

export function evOfHoldout(
  invoice: Invoice,
  intent: Intent,
  pack: Rulepack,
  params: NegotiationParams,
): { ev: number; p: number; interest: InterestCalc; nominal: Cents; formula: string } {
  const projectedAge = invoice.agedDays + params.holdoutHorizonDays;
  const interest = lateInterest(invoice.amountCents, projectedAge, pack);
  const nominal = invoice.amountCents + interest.interestCents;
  const p = params.pHoldoutByIntent[intent] ?? 0.3;
  return {
    ev: nominal * p,
    p,
    interest,
    nominal,
    formula: `(${invoice.amountCents}c + ${interest.interestCents}c interest @ ${projectedAge}d) × p=${p}`,
  };
}

export interface PlanDecision {
  decision: 'propose_plan' | 'hold_out';
  proposal: PlanProposal | null;
  ev: EvBreakdown;
  floorCents: Cents;
  rulepack: { state: string; version: string; citation: string };
  narrative: string;
}

export function floorCentsOf(invoice: Invoice, policy: MandatePolicy): Cents {
  return Math.ceil((invoice.amountCents * policy.floorPct) / 100);
}

/**
 * Core decision: given a (hardship/negotiating) debtor, is a plan worth more
 * than holding out — and if so, what plan does the mandate allow?
 *
 * `offeredTotalCents` is the debtor's counter-offer if any; the engine never
 * builds a candidate below the mandate floor (the gate re-checks — I1 twice).
 */
export function decidePlan(
  invoice: Invoice,
  policy: MandatePolicy,
  intent: Intent,
  offeredTotalCents: Cents | null = null,
  requestedInstallments: number | null = null,
  params: NegotiationParams = DEFAULT_PARAMS,
): PlanDecision {
  const pack = getRulepack(invoice.state);
  const floor = floorCentsOf(invoice, policy);

  // Candidate plan total: full balance by default; a counter-offer is clamped
  // up to the floor (never below — I1 at construction time).
  const total = offeredTotalCents === null ? invoice.amountCents : Math.max(offeredTotalCents, floor);
  const nRequested = requestedInstallments ?? policy.maxInstallments;
  const n = Math.max(1, Math.min(nRequested, policy.maxInstallments));
  const proposal: PlanProposal = {
    totalCents: total,
    installments: buildInstallments(total, n),
    cadenceDays: params.cadenceDays,
  };

  const plan = evOfPlan(proposal, params);
  const hold = evOfHoldout(invoice, intent, pack, params);

  const ev: EvBreakdown = {
    evPlanCents: Math.round(plan.ev),
    evHoldoutCents: Math.round(hold.ev),
    pPlanPerInstallment: plan.ps,
    pHoldout: hold.p,
    holdoutInterest: hold.interest,
    holdoutNominalCents: hold.nominal,
    formulaPlan: plan.formula,
    formulaHoldout: hold.formula,
  };

  const propose = plan.ev > hold.ev;
  return {
    decision: propose ? 'propose_plan' : 'hold_out',
    proposal: propose ? proposal : null,
    ev,
    floorCents: floor,
    rulepack: { state: pack.state, version: pack.version, citation: pack.citation },
    narrative: propose
      ? `EV(plan ${proposal.installments.length}×) ${Math.round(plan.ev)}c > EV(holdout) ${Math.round(hold.ev)}c → propose ${proposal.installments.map((c) => `$${(c / 100).toFixed(0)}`).join('+')}`
      : `EV(holdout) ${Math.round(hold.ev)}c ≥ EV(plan) ${Math.round(plan.ev)}c → keep chasing full balance`,
  };
}

export { getRulepack, lateInterest, RULEPACKS, type Rulepack, type InterestCalc } from './rulepacks';
