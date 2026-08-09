/**
 * scripts/bench.ts — per-stage latency benchmark (COMPLEXITY §5).
 *
 * Reports p50/p95 for each pipeline stage (classify, negotiate, critic) plus
 * end-to-end reply→resolution, using the deterministic offline components
 * (mock intent adapter, deterministic critic — no network, no real keys). These
 * are the local component costs, NOT model-inference latency.
 *
 * Run: npx tsx scripts/bench.ts   (or: npm run bench)
 */

import { IntentClassifier, DeterministicMockAdapter } from '../src/core/intent';
import { decidePlan } from '../src/core/negotiate';
import { DeterministicCritic } from '../src/core/critic';
import { RecoupEngine } from '../src/core/engine';
import { FixedClock } from '../src/core/types';
import { AUSTIN_DESIGNER, DEFAULT_POLICY, SIM_START_ISO, HARDSHIP_AMBIGUOUS_REPLY, ACCEPTANCE_REPLY } from '../src/core/fixtures';

const ITERATIONS = 500;

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * (sortedMs.length - 1)));
  return sortedMs[idx]!;
}

async function measure(label: string, iterations: number, fn: () => Promise<void> | void): Promise<{ label: string; p50: number; p95: number; mean: number }> {
  // warmup
  for (let i = 0; i < 20; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { label, p50: percentile(samples, 50), p95: percentile(samples, 95), mean };
}

async function austinFullCycle(): Promise<void> {
  const c = new FixedClock(SIM_START_ISO);
  const e = new RecoupEngine({ invoice: AUSTIN_DESIGNER, policy: DEFAULT_POLICY, clock: c });
  await e.start();
  c.advanceDays(8);
  await e.handleReply(HARDSHIP_AMBIGUOUS_REPLY);
  c.advanceDays(1);
  await e.handleReply(ACCEPTANCE_REPLY);
  for (let i = 0; i < 3; i++) {
    c.advanceDays(i === 0 ? 1 : 30);
    await e.handlePaymentWebhook(e.stripe.simulatePayment(e.planLinks[i]!.linkId));
  }
}

async function main(): Promise<void> {
  console.log(`RECOUP BENCH — offline component latency (p50/p95, ${ITERATIONS} iterations)\n`);

  const classifier = new IntentClassifier(new DeterministicMockAdapter());
  const critic = new DeterministicCritic(new FixedClock(SIM_START_ISO));
  const planBody = 'Hi Dale, here is a plan on invoice INV: 3 installments of $1,600.00, 30 days apart. First link: https://x. Reply "agreed".';

  const rows = [
    await measure('classify (heuristic+mock)', ITERATIONS, async () => { await classifier.classify(HARDSHIP_AMBIGUOUS_REPLY, { invoice: AUSTIN_DESIGNER }); }),
    await measure('negotiate (decidePlan EV)', ITERATIONS, () => { decidePlan(AUSTIN_DESIGNER, DEFAULT_POLICY, 'hardship'); }),
    await measure('critic (tone/legal gate)', ITERATIONS, async () => { await critic.review(planBody, { legalAllowed: false }); }),
    await measure('end-to-end (start→plan→3 pays)', Math.max(50, Math.floor(ITERATIONS / 5)), austinFullCycle),
  ];

  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (n: number) => `${n.toFixed(3)} ms`.padStart(11);
  console.log(`  ${pad('stage', 32)}${pad('p50', 12)}${pad('p95', 12)}${pad('mean', 12)}`);
  console.log(`  ${'-'.repeat(66)}`);
  for (const r of rows) console.log(`  ${pad(r.label, 32)}${num(r.p50)} ${num(r.p95)} ${num(r.mean)}`);
  console.log('\n  note: offline component costs only; production adds Gemini Flash/Pro inference + Gmail/Stripe I/O.');
  console.log('BENCH: done');
}

main().catch((err) => {
  console.error('BENCH: FAIL (threw)');
  console.error(err);
  process.exit(1);
});
