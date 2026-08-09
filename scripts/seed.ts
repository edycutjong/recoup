/**
 * scripts/seed.ts — deterministic fixture corpus (SEED_DATA.md).
 *
 * Emits the SYNTHETIC seed corpus (demo invoices, the shared mandate, the 50-state
 * rulepack fixtures, and the 12 scripted personas + reply corpus) and a canonical
 * SHA-256 manifest hash so the fixtures are provably reproducible.
 *
 *   npx tsx scripts/seed.ts          → writes seed.out.json and prints the hash
 *   npx tsx scripts/seed.ts --check  → re-hashes and fails if it drifted (CI guard)
 *
 * Every debtor, client, and invoice here is invented. No real debtor is ever
 * contacted from a demo account.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../src/core/ledger/canonical';
import { sha256Hex } from '../src/core/ledger';
import { FIXTURE_INVOICES, DEFAULT_POLICY } from '../src/core/fixtures';
import { RULEPACKS } from '../src/core/negotiate';
import { ALL_PERSONAS } from '../src/core/simulator';
import * as fixtures from '../src/core/fixtures';

/** Pinned manifest hash of the canonical corpus. Re-generate with `npx tsx scripts/seed.ts`. */
const EXPECTED_SEED_HASH = '7a00cb7295dd3c492294deea26259ece3ecf2b2a3539376cf1f153b1deeb2472';

/** The scripted debtor-reply corpus (deterministic; no LLM in the loop). */
const REPLY_CORPUS = {
  hardship_ambiguous: fixtures.HARDSHIP_AMBIGUOUS_REPLY,
  acceptance: fixtures.ACCEPTANCE_REPLY,
  hostile: fixtures.HOSTILE_REPLY,
  dispute: fixtures.DISPUTE_REPLY,
  opt_out: fixtures.OPT_OUT_REPLY,
  bankrupt: fixtures.BANKRUPT_REPLY,
  wrong_contact: fixtures.WRONG_CONTACT_REPLY,
  partial_offer: fixtures.PARTIAL_OFFER_REPLY,
  negotiator_opener: fixtures.NEGOTIATOR_OPENER_REPLY,
  negotiator_lowball: fixtures.NEGOTIATOR_LOWBALL_REPLY,
  promise: fixtures.PROMISE_REPLY,
  ghosty: fixtures.GHOSTY_REPLY,
  paying: fixtures.PAYING_REPLY,
};

function buildCorpus() {
  return {
    version: '0.1.0',
    synthetic: true,
    policy: DEFAULT_POLICY,
    invoices: FIXTURE_INVOICES,
    rulepacks: RULEPACKS,
    replies: REPLY_CORPUS,
    personas: ALL_PERSONAS.map((p) => ({
      name: p.name,
      description: p.description,
      invoiceId: p.invoice.id,
      steps: p.steps,
      expected: p.expected,
    })),
  };
}

function integrityProblems(corpus: ReturnType<typeof buildCorpus>): string[] {
  const problems: string[] = [];
  const invoiceIds = new Set(Object.values(corpus.invoices).map((i) => i.id));
  for (const inv of Object.values(corpus.invoices)) {
    if (!inv.synthetic) problems.push(`invoice ${inv.id} is not marked synthetic`);
    if (inv.kind !== 'b2b') problems.push(`invoice ${inv.id} is not B2B (consumer debt is out of scope)`);
  }
  if (corpus.personas.length !== 12) problems.push(`expected 12 personas, got ${corpus.personas.length}`);
  for (const p of corpus.personas) {
    if (!invoiceIds.has(p.invoiceId)) problems.push(`persona ${p.name} references unknown invoice ${p.invoiceId}`);
  }
  return problems;
}

function main(): void {
  const check = process.argv.includes('--check');
  const corpus = buildCorpus();
  const canon = canonicalJson(corpus);
  const hash = sha256Hex(canon);

  const problems = integrityProblems(corpus);
  if (problems.length) {
    console.error('SEED: FAIL — corpus integrity problems:');
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }

  if (check) {
    const ok = hash === EXPECTED_SEED_HASH;
    console.log(`seed corpus hash: ${hash}`);
    console.log(`expected:         ${EXPECTED_SEED_HASH}`);
    console.log(`SEED CHECK: ${ok ? 'PASS (fixtures are reproducible)' : 'FAIL (fixtures drifted — re-run `npx tsx scripts/seed.ts` and commit)'}`);
    process.exit(ok ? 0 : 1);
  }

  const outPath = fileURLToPath(new URL('../seed.out.json', import.meta.url));
  writeFileSync(outPath, JSON.stringify(corpus, null, 2) + '\n');
  console.log('SEED — synthetic fixture corpus written.');
  console.log(`  invoices:  ${Object.keys(corpus.invoices).join(', ')}`);
  console.log(`  rulepacks: ${Object.keys(corpus.rulepacks).join(', ')} (FIXTURE)`);
  console.log(`  personas:  ${corpus.personas.length}`);
  console.log(`  file:      ${outPath}`);
  console.log(`  hash:      ${hash}`);
  console.log('\nNext: npx tsx scripts/self_test.ts');
}

main();
