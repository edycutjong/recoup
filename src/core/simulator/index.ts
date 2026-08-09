/**
 * Debtor-simulator runner (COMPLEXITY §5), deterministic scripted mode.
 *
 * For each persona: fresh clock, fresh engine, replay the script, then
 * measure — recovery, time-to-resolution, policy-violation rate (MUST be 0),
 * critic catches, opt-out honor, and full ledger verification per run.
 */

import { RecoupEngine } from '../engine';
import { verifyChain } from '../ledger';
import { FixedClock } from '../types';
import { DEFAULT_POLICY, SIM_START_ISO } from '../fixtures';
import { ALL_PERSONAS, type Persona, type PersonaStep } from './personas';
import { isTerminal, type StateName } from '../machine';

export interface PersonaRunResult {
  persona: string;
  invoiceId: string;
  invoicedCents: number;
  recoveredCents: number;
  finalState: StateName;
  resolved: boolean;
  daysToResolution: number | null;
  executedViolations: number;
  gateDenials: number;
  criticBlocks: number;
  sends: number;
  sendsAfterOptOut: number;
  ledgerOk: boolean;
  ledgerLength: number;
  matchesExpectation: boolean;
}

export interface SimulationReport {
  startedAtIso: string;
  personas: PersonaRunResult[];
  totals: {
    invoicedCents: number;
    recoveredCents: number;
    recoveryRatePct: number;
    resolvedCount: number;
    avgDaysToResolution: number | null;
    policyViolations: number; // the published metric — must be 0
    policyViolationRatePct: number;
    gateDenials: number;
    criticBlocks: number;
    optOutHonored: boolean;
    allLedgersVerified: boolean;
    allExpectationsMet: boolean;
  };
}

export async function runPersona(persona: Persona, policy = DEFAULT_POLICY): Promise<PersonaRunResult> {
  const clock = new FixedClock(SIM_START_ISO);
  const engine = new RecoupEngine({ invoice: persona.invoice, policy, clock });
  await engine.start();

  let day = 0;
  let daysToResolution: number | null = null;
  let optOutDay: number | null = null;
  let sendsAtOptOut = 0;

  const noteResolution = () => {
    if (daysToResolution === null && isTerminal(engine.state.name)) daysToResolution = day;
  };

  for (const step of persona.steps as PersonaStep[]) {
    if (step.day < day) throw new Error(`${persona.name}: steps out of order at day ${step.day}`);
    clock.advanceDays(step.day - day);
    day = step.day;

    switch (step.kind) {
      case 'silence':
        await engine.tick();
        break;
      case 'reply': {
        const out = await engine.handleReply(step.text);
        if (out.intent === 'opt_out' && optOutDay === null) {
          optOutDay = day;
          sendsAtOptOut = engine.sendCount;
        }
        break;
      }
      case 'pay_full': {
        const link = engine.fullBalanceLink;
        if (!link) throw new Error(`${persona.name}: engine has no full-balance link`);
        await engine.handlePaymentWebhook(engine.stripe.simulatePayment(link.linkId));
        break;
      }
      case 'pay_installment': {
        const link = engine.planLinks[step.index];
        if (!link) throw new Error(`${persona.name}: no plan link at index ${step.index} (plan links: ${engine.planLinks.length})`);
        await engine.handlePaymentWebhook(engine.stripe.simulatePayment(link.linkId));
        break;
      }
    }
    noteResolution();
  }

  const chain = verifyChain(engine.ledger.all());
  const finalState = engine.state.name;
  const sendsAfterOptOut = optOutDay === null ? 0 : engine.sendCount - sendsAtOptOut;

  return {
    persona: persona.name,
    invoiceId: persona.invoice.id,
    invoicedCents: persona.invoice.amountCents,
    recoveredCents: engine.recoveredCents,
    finalState,
    resolved: isTerminal(finalState),
    daysToResolution,
    executedViolations: engine.executedViolations,
    gateDenials: engine.gate.deniedCount,
    criticBlocks: engine.criticGate.failCount,
    sends: engine.sendCount,
    sendsAfterOptOut,
    ledgerOk: chain.ok,
    ledgerLength: chain.length,
    matchesExpectation: finalState === persona.expected.finalState && engine.recoveredCents === persona.expected.recoveredCents,
  };
}

export async function runSimulation(personas: Persona[] = ALL_PERSONAS, policy = DEFAULT_POLICY): Promise<SimulationReport> {
  const results: PersonaRunResult[] = [];
  for (const p of personas) results.push(await runPersona(p, policy));

  const invoiced = results.reduce((a, r) => a + r.invoicedCents, 0);
  const recovered = results.reduce((a, r) => a + r.recoveredCents, 0);
  const resolved = results.filter((r) => r.resolved);
  const violations = results.reduce((a, r) => a + r.executedViolations, 0);
  const days = resolved.map((r) => r.daysToResolution).filter((d): d is number => d !== null);

  return {
    startedAtIso: SIM_START_ISO,
    personas: results,
    totals: {
      invoicedCents: invoiced,
      recoveredCents: recovered,
      recoveryRatePct: invoiced === 0 ? 0 : Number(((recovered / invoiced) * 100).toFixed(1)),
      resolvedCount: resolved.length,
      avgDaysToResolution: days.length ? Number((days.reduce((a, b) => a + b, 0) / days.length).toFixed(1)) : null,
      policyViolations: violations,
      policyViolationRatePct: results.length ? Number(((results.filter((r) => r.executedViolations > 0).length / results.length) * 100).toFixed(1)) : 0,
      gateDenials: results.reduce((a, r) => a + r.gateDenials, 0),
      criticBlocks: results.reduce((a, r) => a + r.criticBlocks, 0),
      optOutHonored: results.every((r) => r.sendsAfterOptOut === 0),
      allLedgersVerified: results.every((r) => r.ledgerOk),
      allExpectationsMet: results.every((r) => r.matchesExpectation),
    },
  };
}

export { ALL_PERSONAS, PERSONAS, NEGOTIATOR_PERSONA, type Persona, type PersonaStep } from './personas';
