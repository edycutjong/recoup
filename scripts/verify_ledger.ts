/**
 * scripts/verify_ledger.ts — the judge-facing chain verifier (COMPLEXITY §2).
 *
 * Verifies an exported decision ledger standalone: hash chain, per-entry Ed25519
 * signatures, daily Merkle roots, and the I5 causal fee-linkage (every fee row
 * references exactly one payment AND the decision chain behind it).
 *
 *   npx tsx scripts/verify_ledger.ts <ledger.jsonl>   → verify a file
 *   npx tsx scripts/verify_ledger.ts                  → generate a demo ledger and verify it
 *
 * Exit code is 0 iff the chain is valid.
 */

import { readFileSync } from 'node:fs';
import { RecoupEngine } from '../src/core/engine';
import { verifyChain, verifyJsonl, type ChainReport } from '../src/core/ledger';
import { FixedClock } from '../src/core/types';
import { AUSTIN_DESIGNER, DEFAULT_POLICY, SIM_START_ISO, HARDSHIP_AMBIGUOUS_REPLY, ACCEPTANCE_REPLY } from '../src/core/fixtures';

async function demoLedgerJsonl(): Promise<string> {
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
  return e.ledger.exportJsonl();
}

function report(rep: ChainReport): void {
  console.log(`  entries:      ${rep.length}`);
  console.log(`  chain valid:  ${rep.ok ? 'YES' : 'NO'}`);
  console.log(`  fee rows I5:  ${rep.feeRowsChecked} checked`);
  console.log('  merkle roots (per UTC day):');
  for (const [day, root] of Object.entries(rep.merkleRoots)) console.log(`    ${day}  ${root}`);
  if (rep.errors.length) {
    console.log('  errors:');
    for (const err of rep.errors) console.log(`    ✗ ${err}`);
  }
}

async function main(): Promise<void> {
  const path = process.argv[2];
  let rep: ChainReport;

  if (path) {
    console.log(`VERIFY LEDGER — ${path}\n`);
    rep = verifyJsonl(readFileSync(path, 'utf8'));
  } else {
    console.log('VERIFY LEDGER — no file given; generating the austin_designer demo ledger\n');
    const jsonl = await demoLedgerJsonl();
    rep = verifyChain(
      jsonl
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l)),
    );
  }

  report(rep);
  console.log(`\nVERIFY: ${rep.ok ? 'PASS' : 'FAIL'}`);
  process.exit(rep.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('VERIFY: FAIL (threw)');
  console.error(err);
  process.exit(1);
});
