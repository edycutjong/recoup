/**
 * scripts/capture_evidence.ts — real live-execution evidence capture.
 *
 * Produces ≥15 PNGs into build/docs/evidence/, each a real artifact of a real
 * run:
 *   1) The /verify replay dashboard (build/verify/index.html) — full page plus
 *      the split-screen, decision-ledger, money-shot, violations-0, simulator
 *      and Merkle panels — rendered from the committed self_test data.
 *   2) "Terminal" evidence — every proof script and CLI subcommand is actually
 *      executed here, its REAL stdout captured, rendered into a dark terminal
 *      card and screenshot. Nothing is mocked or typed by hand.
 *
 * Run: npx tsx scripts/capture_evidence.ts   (or: npm run evidence)
 * Requires the dashboard to be built first (npm run verify:dashboard).
 */

import { chromium, type Browser, type Page } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'evidence');
const DASH = join(ROOT, 'verify', 'index.html');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const VITEST = join(ROOT, 'node_modules', '.bin', 'vitest');

const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*m/g, '');
const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

/** Run a command and capture combined real stdout+stderr (ANSI stripped). */
function run(bin: string, args: string[]): string {
  const res = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, maxBuffer: 16 * 1024 * 1024 });
  return stripAnsi(`${res.stdout || ''}${res.stderr || ''}`.replace(/\s+$/, ''));
}

/** Colorize output lines by meaning (success/fail/heading) for legibility. */
function colorizeLine(raw: string): string {
  const line = esc(raw);
  if (/✗|FAIL(?!\w)|\bBAD\b|error|✘/i.test(raw) && !/0 fail|failures 0|violations 0/i.test(raw)) return `<span class="l fail">${line}</span>`;
  if (/✓|PASS(?!\w)|: PASS|\bOK\b|\bYES\b|passed|violations 0|policy-violations 0|SELF-TEST: PASS|VERIFY: PASS/i.test(raw)) return `<span class="l ok">${line}</span>`;
  if (/^(RECOUP|VERIFY|BENCH|BUILD|dunningkit|USAGE|COMMANDS|EXAMPLES|PERSONAS)\b/.test(raw) || /^\s*Test Files|^\s*Tests\b/.test(raw)) return `<span class="l head">${line}</span>`;
  return `<span class="l">${line}</span>`;
}

function terminalHtml(title: string, cmd: string, stdout: string): string {
  const body = stdout.split('\n').map(colorizeLine).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root{--em:#10B981;--mint:#2DD4BF;--ink:#0A1E30}
    *{box-sizing:border-box} html,body{margin:0}
    body{background:transparent;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:26px}
    .term{width:1000px;margin:0 auto;border-radius:12px;overflow:hidden;border:1px solid #1F3E5A;
      background:#07131f;box-shadow:0 24px 70px rgba(0,0,0,.5)}
    .bar{display:flex;align-items:center;gap:8px;padding:11px 15px;background:#0F2A43;border-bottom:1px solid #1F3E5A}
    .bar .dot{width:12px;height:12px;border-radius:50%}
    .r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
    .bar .t{margin-left:10px;color:#B7CBDA;font-size:12.5px;font-weight:600;letter-spacing:.2px}
    .bar .badge{margin-left:auto;color:#062018;background:linear-gradient(180deg,#f6c65a,#F0B429);font-size:10px;font-weight:700;padding:3px 9px;border-radius:999px}
    pre{margin:0;padding:18px 20px;color:#cfe0ec;font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
    .prompt{color:#5f7d92}.prompt .p{color:var(--em);font-weight:700}
    .l{display:block}.l.ok{color:var(--mint)}.l.fail{color:#ff8a8a}.l.head{color:#8fc0ff;font-weight:700}
  </style></head><body>
    <div class="term" id="term">
      <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
        <span class="t">${esc(title)}</span><span class="badge">REAL RUN · FIXTURE DATA</span></div>
      <pre><span class="prompt"><span class="p">$</span> ${esc(cmd)}</span>\n${body}</pre>
    </div>
  </body></html>`;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document.fonts.ready);
  await page.waitForTimeout(250);
}

async function shotElement(page: Page, selector: string, file: string): Promise<void> {
  const loc = page.locator(selector);
  await loc.waitFor({ state: 'visible', timeout: 8000 });
  await loc.screenshot({ path: join(OUT, file) });
  console.log(`  ✓ ${file}  ${selector}`);
}

async function shotTerminal(page: Page, title: string, cmd: string, stdout: string, file: string): Promise<void> {
  await page.setViewportSize({ width: 1060, height: 900 });
  await page.setContent(terminalHtml(title, cmd, stdout), { waitUntil: 'load' });
  await settle(page);
  await page.locator('#term').screenshot({ path: join(OUT, file) });
  console.log(`  ✓ ${file}  (${stdout.split('\n').length} lines of real stdout)`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (!existsSync(DASH)) { console.error(`evidence: ${DASH} missing — run \`npm run verify:dashboard\` first.`); process.exit(1); }

  const browser: Browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1460, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const page = await context.newPage();

  try {
    console.log('CAPTURE EVIDENCE — /verify replay dashboard');
    await page.goto('file://' + DASH, { waitUntil: 'networkidle' });
    await settle(page);

    await page.screenshot({ path: join(OUT, '01-dashboard-full.png'), fullPage: true });
    console.log('  ✓ 01-dashboard-full.png  (full page)');
    await shotElement(page, '#hero', '02-dashboard-header.png');
    await shotElement(page, '#counters', '03-counters-recovered.png');
    await shotElement(page, '#splitscreen', '04-splitscreen-thread-ledger.png');
    await shotElement(page, '#ledger', '05-decision-ledger.png');
    await shotElement(page, '#moneyshot', '06-money-shot-installment.png');
    await shotElement(page, '#violations-tile', '07-policy-violations-zero.png');
    await shotElement(page, '#simulator', '08-simulator-12-personas.png');
    await shotElement(page, '#verify', '09-merkle-verify.png');

    console.log('CAPTURE EVIDENCE — real terminal runs');
    const cliBase = ['src/cli.ts'];
    const terminals: { title: string; cmd: string; bin: string; args: string[]; file: string }[] = [
      { title: 'npm run self-test', cmd: 'npm run self-test', bin: TSX, args: ['scripts/self_test.ts'], file: '10-terminal-self-test.png' },
      { title: 'npm run verify:ledger', cmd: 'npm run verify:ledger', bin: TSX, args: ['scripts/verify_ledger.ts'], file: '11-terminal-verify-ledger.png' },
      { title: 'npm run bench', cmd: 'npm run bench', bin: TSX, args: ['scripts/bench.ts'], file: '12-terminal-bench.png' },
      { title: 'dunningkit simulate', cmd: 'npx tsx src/cli.ts simulate --persona hardship --floor 60', bin: TSX, args: [...cliBase, 'simulate', '--persona', 'hardship', '--floor', '60'], file: '13-terminal-cli-simulate.png' },
      { title: 'dunningkit interest', cmd: 'npx tsx src/cli.ts interest --state CA --days 87 --amount 4800', bin: TSX, args: [...cliBase, 'interest', '--state', 'CA', '--days', '87', '--amount', '4800'], file: '14-terminal-cli-interest.png' },
      { title: 'dunningkit simulate (opt-out / I3)', cmd: 'npx tsx src/cli.ts simulate --persona opt_out', bin: TSX, args: [...cliBase, 'simulate', '--persona', 'opt_out'], file: '15-terminal-cli-optout.png' },
      { title: 'dunningkit --help', cmd: 'npx tsx src/cli.ts --help', bin: TSX, args: [...cliBase, '--help'], file: '16-terminal-cli-help.png' },
      { title: 'npm test — 203 offline tests', cmd: 'npx vitest run', bin: VITEST, args: ['run'], file: '17-terminal-vitest.png' },
    ];

    for (const t of terminals) {
      const out = run(t.bin, t.args);
      await shotTerminal(page, t.title, t.cmd, out, t.file);
    }
  } finally {
    await browser.close();
  }

  const pngs = readdirSync(OUT).filter((f) => f.endsWith('.png')).sort();
  writeFileSync(join(OUT, 'MANIFEST.txt'), pngs.join('\n') + '\n');
  console.log(`\nEVIDENCE: ${pngs.length} PNGs in ${OUT}`);
  if (pngs.length < 15) { console.error(`EVIDENCE: FAIL — expected >= 15, got ${pngs.length}`); process.exit(1); }
  console.log('EVIDENCE: PASS');
}

main().catch((err) => { console.error('EVIDENCE: FAIL (threw)'); console.error(err); process.exit(1); });
