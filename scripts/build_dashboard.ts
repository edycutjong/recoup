/**
 * scripts/build_dashboard.ts — inject the real offline-run data into the
 * self-contained /verify replay dashboard.
 *
 * Reads build/verify/data/dashboard.json (produced by scripts/self_test.ts)
 * and splices it verbatim into the <script type="application/json"
 * id="recoup-data"> block of build/verify/index.html, so the page renders the
 * REAL ledger/simulator/verification data straight from file:// with no fetch,
 * no server, and no external host.
 *
 * Run: npx tsx scripts/build_dashboard.ts   (or: npm run verify:dashboard,
 *      which runs self-test first to refresh the data).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const verifyDir = join(here, '..', 'verify');
const dataPath = join(verifyDir, 'data', 'dashboard.json');
const htmlPath = join(verifyDir, 'index.html');

const OPEN = '<script type="application/json" id="recoup-data">';
const CLOSE = '</script>';

function main(): void {
  if (!existsSync(dataPath)) {
    console.error(`build_dashboard: ${dataPath} missing — run \`npm run self-test\` first.`);
    process.exit(1);
  }
  if (!existsSync(htmlPath)) {
    console.error(`build_dashboard: ${htmlPath} missing.`);
    process.exit(1);
  }

  // Re-serialize so the embedded JSON is compact and provably valid, and can
  // never contain a literal </script> that would close the block early.
  const model = JSON.parse(readFileSync(dataPath, 'utf8')) as unknown;
  const json = JSON.stringify(model).replace(/<\//g, '<\\/');

  const html = readFileSync(htmlPath, 'utf8');
  const start = html.indexOf(OPEN);
  if (start === -1) throw new Error(`marker not found in index.html: ${OPEN}`);
  const bodyStart = start + OPEN.length;
  const end = html.indexOf(CLOSE, bodyStart);
  if (end === -1) throw new Error('closing </script> for #recoup-data not found');

  const next = html.slice(0, bodyStart) + json + html.slice(end);
  writeFileSync(htmlPath, next);

  const counters = (model as { counters?: Record<string, number> }).counters ?? {};
  console.log('BUILD DASHBOARD — injected real self_test data into verify/index.html');
  console.log(`  bytes embedded: ${json.length}`);
  console.log(`  recovered: $${((counters.recoveredCents ?? 0) / 100).toFixed(2)} · decisions: ${counters.decisionsLogged ?? 0} · policy violations: ${counters.policyViolations ?? 0}`);
  console.log(`  open: file://${htmlPath}`);
}

main();
