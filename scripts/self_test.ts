/**
 * scripts/self_test.ts — offline end-to-end proof of the Recoup core.
 *
 * Drives the austin_designer demo case with NO network and NO real keys:
 *   cadence send → ambiguous hardship reply → mandate policy check →
 *   3×$1,600 plan proposal → critic PASS → plan accepted →
 *   three fake Stripe webhooks → 10% success-fee metering,
 * then verifies the signed decision ledger (I5/I6) and runs the full 12-persona
 * simulator to confirm the published policy-violation count is 0.
 *
 * Prints the ledger tail and a final PASS/FAIL verdict (exit 1 on FAIL).
 *
 * Run: npx tsx scripts/self_test.ts   (or: npm run self-test)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecoupEngine } from '../src/core/engine';
import { verifyChain, type ChainReport } from '../src/core/ledger';
import { runSimulation, type SimulationReport } from '../src/core/simulator';
import { FixedClock, usd } from '../src/core/types';
import { AUSTIN_DESIGNER, DEFAULT_POLICY, SIM_START_ISO, HARDSHIP_AMBIGUOUS_REPLY, ACCEPTANCE_REPLY } from '../src/core/fixtures';
import type { LedgerEntry } from '../src/core/types';

const failures: string[] = [];
function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures.push(label);
}

// ---------------------------------------------------------------------------
// Judge-visibility export: the /verify replay dashboard renders THIS data.
// Everything below is derived from the real objects this script already drove
// (the engine ledger, gmail fakes, fee meter, chain report, simulator report).
// It invents nothing — build/verify/build_dashboard.ts injects it into the
// self-contained build/verify/index.html.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const dayOffset = (ts: string): number => Math.round((Date.parse(ts) - Date.parse(SIM_START_ISO)) / DAY_MS);

function decisionView(e: LedgerEntry): { title: string; detail: string } {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.kind) {
    case 'intake':
      return { title: 'Invoice intake', detail: `${usd(Number(p.amountCents))} · ${String(p.debtorEntity)} · ${p.agedDays}d aged · ${p.kind}` };
    case 'mandate_signed': {
      const pol = p.policy as typeof DEFAULT_POLICY;
      return { title: 'Mandate signed', detail: `floor ${pol.floorPct}% · ≤${pol.maxInstallments} installments · quiet ${pol.quietHours.startHour}-${pol.quietHours.endHour} · legal=${pol.legalLanguage}` };
    }
    case 'classify':
      return { title: `Classified → ${String(p.intent)}`, detail: `confidence ${p.confidence} · source ${p.source} · ${String(p.rationale).slice(0, 90)}` };
    case 'strategy':
      return { title: 'EV strategy', detail: String(p.narrative ?? p.note ?? '') };
    case 'policy_check':
      return p.result === 'denied'
        ? { title: `Policy gate — DENIED (${String(p.code)})`, detail: String(p.message ?? '') }
        : { title: 'Policy gate ✓ authorized', detail: `checks: ${(p.checks as string[] | undefined)?.join(', ') ?? ''} · floor ${usd(Number(p.floorCents))}` };
    case 'critic_receipt':
      return { title: `Critic ${p.pass ? 'PASS' : 'FAIL'}`, detail: `${String(p.model)} · reviewed sha256 ${String(p.reviewedSha256).slice(0, 12)}…${(p.reasons as string[] | undefined)?.length ? ' · ' + (p.reasons as string[]).join('; ') : ''}` };
    case 'proposal': {
      const prop = p.proposal as { installments: number[]; totalCents: number };
      return { title: `Proposal ${prop.installments.length}×${usd(prop.installments[0] ?? 0)}`, detail: `total ${usd(prop.totalCents)} · EV(plan) ${usd(Number(p.evPlanCents))} > EV(holdout) ${usd(Number(p.evHoldoutCents))}` };
    }
    case 'send':
      return { title: 'Email sent', detail: `${String(p.templateId ?? (p.freeText ? 'free-text' : 'email'))} → ${String(p.to)} · msg ${String(p.msgSha256).slice(0, 12)}…` };
    case 'plan_accepted':
      return { title: 'Plan accepted', detail: 'mandate re-checked at acceptance (I1 twice)' };
    case 'payment':
      return { title: `Payment ${usd(Number(p.amountCents))}`, detail: `installment ${Number(p.installmentIndex) + 1} · event ${String(p.eventId)}` };
    case 'fee':
      return { title: `Fee ${usd(Number(p.feeCents))} (${p.pct}%)`, detail: `causally linked to payment + decision chain (I5)` };
    case 'opt_out':
      return { title: 'Opt-out honored', detail: 'all outreach halted within one tick, permanently (I3)' };
    case 'dispute':
      return { title: 'Dispute flagged', detail: String(p.note ?? '') };
    case 'handoff':
      return { title: 'Handoff to client', detail: String(p.reason ?? '') };
    case 'writeoff':
      return { title: 'Write-off recommended', detail: String(p.memo ?? '').slice(0, 120) };
    case 'contact_update':
      return { title: 'Contact corrected', detail: `${String(p.from)} → ${String(p.to)}` };
    default:
      return { title: e.kind, detail: '' };
  }
}

function exportVerifyData(e: RecoupEngine, chain: ChainReport, sim: SimulationReport): string {
  const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'verify', 'data');
  mkdirSync(dataDir, { recursive: true });

  const entries = e.ledger.all();
  const sent = e.gmail.sent;
  const classifyEntry = entries.find((x) => x.kind === 'classify');
  const planAccepted = entries.find((x) => x.kind === 'plan_accepted');
  const payments = entries.filter((x) => x.kind === 'payment');
  const fees = entries.filter((x) => x.kind === 'fee');

  const thread = [
    sent[0] && { party: 'agent', kind: 'cadence_reminder', ts: sent[0].sentAt, day: dayOffset(sent[0].sentAt), subject: sent[0].subject, body: sent[0].body },
    classifyEntry && { party: 'debtor', kind: 'hardship_reply', ts: classifyEntry.ts, day: dayOffset(classifyEntry.ts), subject: 'Re: your reminder', body: HARDSHIP_AMBIGUOUS_REPLY },
    sent[1] && { party: 'agent', kind: 'plan_proposal', ts: sent[1].sentAt, day: dayOffset(sent[1].sentAt), subject: sent[1].subject, body: sent[1].body },
    planAccepted && { party: 'debtor', kind: 'acceptance_reply', ts: planAccepted.ts, day: dayOffset(planAccepted.ts), subject: 'Re: payment plan', body: ACCEPTANCE_REPLY },
  ].filter(Boolean);

  const installments = payments.map((p) => {
    const pay = p.payload as { amountCents: number; installmentIndex: number; eventId: string };
    const fee = fees.find((f) => (f.payload as { paymentEventId: string }).paymentEventId === pay.eventId);
    const feePay = fee?.payload as { feeCents: number } | undefined;
    return {
      n: pay.installmentIndex + 1,
      ofN: payments.length,
      amountCents: pay.amountCents,
      paidAt: p.ts,
      day: dayOffset(p.ts),
      feeCents: feePay?.feeCents ?? 0,
      paymentHash: p.entryHash,
      feeHash: fee?.entryHash ?? '',
      decisionRefs: fee ? fee.refs.filter((r) => r !== p.entryHash) : [],
    };
  });

  const model = {
    generatedAtIso: new Date().toISOString(),
    disclosure: 'FIXTURE / offline demo data — deterministic self_test run, not live production.',
    case: {
      invoiceId: e.invoice.id,
      debtorEntity: e.invoice.debtor.entity,
      debtorContact: e.invoice.debtor.contact,
      debtorEmail: e.invoice.debtor.email,
      clientName: e.invoice.client.name,
      amountCents: e.invoice.amountCents,
      agedDays: e.invoice.agedDays,
      state: e.invoice.state,
      synthetic: e.invoice.synthetic,
    },
    policy: e.gate.policy,
    thread,
    decisions: entries.map((x) => ({ seq: x.seq, ts: x.ts, day: dayOffset(x.ts), actor: x.actor, kind: x.kind, entryHash: x.entryHash, refs: x.refs, ...decisionView(x) })),
    money: {
      recoveredCents: e.recoveredCents,
      invoicedCents: e.invoice.amountCents,
      feeCents: e.feeMeter.fees.reduce((a, f) => a + f.feeCents, 0),
      feePct: 10,
      recoveryPct: Number(((e.recoveredCents / e.invoice.amountCents) * 100).toFixed(1)),
      installments,
    },
    counters: {
      recoveredCents: e.recoveredCents,
      decisionsLogged: entries.length,
      policyViolations: e.executedViolations,
      ledgerEntries: chain.length,
      feeRows: chain.feeRowsChecked,
      sends: e.sendCount,
      gateDenials: e.gate.deniedCount,
    },
    verify: {
      ok: chain.ok,
      length: chain.length,
      feeRowsChecked: chain.feeRowsChecked,
      errorCount: chain.errors.length,
      merkleRoots: chain.merkleRoots,
      verifier: 'node:crypto — Ed25519 signatures + SHA-256 hash chain',
      note: 'This report is PRE-COMPUTED. The verifier uses node:crypto and runs in Node, not the browser; re-run it yourself with the command below.',
      command: 'npm run verify:ledger',
    },
    simulator: {
      resolvedCount: sim.totals.resolvedCount,
      total: sim.personas.length,
      recoveryRatePct: sim.totals.recoveryRatePct,
      policyViolations: sim.totals.policyViolations,
      optOutHonored: sim.totals.optOutHonored,
      allLedgersVerified: sim.totals.allLedgersVerified,
      allExpectationsMet: sim.totals.allExpectationsMet,
      avgDaysToResolution: sim.totals.avgDaysToResolution,
      gateDenials: sim.totals.gateDenials,
      criticBlocks: sim.totals.criticBlocks,
      personas: sim.personas.map((r) => ({
        persona: r.persona,
        finalState: r.finalState,
        resolved: r.resolved,
        invoicedCents: r.invoicedCents,
        recoveredCents: r.recoveredCents,
        executedViolations: r.executedViolations,
        gateDenials: r.gateDenials,
        criticBlocks: r.criticBlocks,
        daysToResolution: r.daysToResolution,
      })),
    },
  };

  writeFileSync(join(dataDir, 'ledger.jsonl'), e.ledger.exportJsonl());
  writeFileSync(join(dataDir, 'verify.json'), JSON.stringify(model.verify, null, 2) + '\n');
  writeFileSync(join(dataDir, 'simulator.json'), JSON.stringify(sim, null, 2) + '\n');
  writeFileSync(join(dataDir, 'dashboard.json'), JSON.stringify(model, null, 2) + '\n');
  return dataDir;
}

function ledgerTail(entries: readonly LedgerEntry[], n: number): void {
  console.log(`\n  ledger tail (last ${n} of ${entries.length} entries):`);
  for (const e of entries.slice(-n)) {
    console.log(`    #${String(e.seq).padStart(2, '0')} ${e.kind.padEnd(14)} ${e.actor.padEnd(12)} ${e.entryHash.slice(0, 12)}…`);
  }
}

async function main(): Promise<void> {
  console.log('RECOUP SELF-TEST — offline austin_designer end-to-end\n');
  console.log(`  case: ${AUSTIN_DESIGNER.debtor.entity} owes ${usd(AUSTIN_DESIGNER.amountCents)} (${AUSTIN_DESIGNER.agedDays}d, ${AUSTIN_DESIGNER.state})`);
  console.log(`  mandate: floor ${DEFAULT_POLICY.floorPct}% · ≤${DEFAULT_POLICY.maxInstallments} installments · quiet ${DEFAULT_POLICY.quietHours.startHour}-${DEFAULT_POLICY.quietHours.endHour} · legal=${DEFAULT_POLICY.legalLanguage}\n`);

  const c = new FixedClock(SIM_START_ISO);
  const e = new RecoupEngine({ invoice: AUSTIN_DESIGNER, policy: DEFAULT_POLICY, clock: c });

  const started = await e.start();
  check(`cadence stage 1 sent (${started.acted})`, started.acted === 'cadence_send' && e.sendCount === 1);

  c.advanceDays(8);
  const r1 = await e.handleReply(HARDSHIP_AMBIGUOUS_REPLY);
  check(`hardship reply classified as hardship (not ghost) → ${r1.intent}`, r1.intent === 'hardship');

  const proposal = e.pendingProposal;
  const is3x1600 = !!proposal && proposal.installments.length === 3 && proposal.installments.every((x) => x === 160_000);
  check(`policy check → 3×$1,600 proposal within floor ${usd(e.gate.floorCents(AUSTIN_DESIGNER.amountCents))}`, is3x1600);

  const planCritic = e.criticGate.receipts.filter((r) => r.pass).slice(-1)[0];
  check('critic PASS receipt on the plan proposal', !!planCritic && planCritic.pass);

  c.advanceDays(1);
  const r2 = await e.handleReply(ACCEPTANCE_REPLY);
  check(`plan accepted → PLAN_ACTIVE with ${e.planLinks.length} installment links`, r2.intent === 'plan_acceptance' && e.planLinks.length === 3);

  for (let i = 0; i < 3; i++) {
    c.advanceDays(i === 0 ? 1 : 30);
    const evt = e.stripe.simulatePayment(e.planLinks[i]!.linkId);
    await e.handlePaymentWebhook(evt);
    console.log(`  → webhook: installment ${i + 1}/3 paid ${usd(evt.amountCents)}  (fee ${usd(e.feeMeter.fees[i]!.feeCents)})`);
  }

  check(`resolved PAID, recovered ${usd(e.recoveredCents)}`, e.state.name === 'PAID' && e.recoveredCents === 480_000);
  check(`success fees metered = ${usd(e.feeMeter.fees.reduce((a, f) => a + f.feeCents, 0))} (10%)`, e.feeMeter.fees.reduce((a, f) => a + f.feeCents, 0) === 48_000);
  check('published policy-violation count = 0', e.executedViolations === 0);

  const chain = verifyChain(e.ledger.all());
  check(`ledger verifies (I5/I6): ${chain.length} entries, ${chain.feeRowsChecked} fee rows causally linked`, chain.ok && chain.feeRowsChecked === 3);

  ledgerTail(e.ledger.all(), 8);

  console.log('\n  running the 12-persona simulator sweep…');
  const sim = await runSimulation();
  check(`simulator: violations=${sim.totals.policyViolations}, opt-out honored=${sim.totals.optOutHonored}, ledgers verified=${sim.totals.allLedgersVerified}`,
    sim.totals.policyViolations === 0 && sim.totals.optOutHonored && sim.totals.allLedgersVerified && sim.totals.allExpectationsMet);

  // Export the real run data for the /verify replay dashboard. Wrapped so a
  // filesystem hiccup can never flip the policy proof's verdict.
  try {
    const dir = exportVerifyData(e, chain, sim);
    console.log(`\n  ↳ /verify dashboard data exported → ${dir}`);
  } catch (err) {
    console.log(`\n  ↳ /verify dashboard export skipped (${(err as Error).message})`);
  }

  const pass = failures.length === 0;
  // --- final 3 lines: a self-contained verdict ---
  console.log('');
  console.log(`simulator: ${sim.totals.resolvedCount}/12 personas resolved, recovery ${sim.totals.recoveryRatePct}%, policy-violations ${sim.totals.policyViolations}`);
  console.log(`austin_designer: ${e.state.name}, recovered ${usd(e.recoveredCents)}, fees ${usd(e.feeMeter.fees.reduce((a, f) => a + f.feeCents, 0))}, violations ${e.executedViolations}, ledger ${chain.ok ? 'OK' : 'BAD'} (${chain.length} entries, ${chain.feeRowsChecked} fee rows)`);
  console.log(`SELF-TEST: ${pass ? 'PASS' : 'FAIL' + ` (${failures.length} check(s) failed: ${failures.join('; ')})`}`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('SELF-TEST: FAIL (threw)');
  console.error(err);
  process.exit(1);
});
