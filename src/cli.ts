#!/usr/bin/env -S npx tsx
/**
 * dunningkit — the unified Recoup CLI.
 *
 * A thin, honest entry point over the offline core. Every subcommand wraps an
 * EXISTING exported API (no new business logic): a persona through the machine,
 * statutory late-interest, the end-to-end self-test, the standalone ledger
 * verifier, and the latency bench.
 *
 *   npx tsx src/cli.ts --help
 *   npx tsx src/cli.ts simulate --persona hardship --floor 60
 *   npx tsx src/cli.ts interest --state CA --days 87 --amount 4800
 *   npx tsx src/cli.ts verify verify/data/ledger.jsonl
 *   npx tsx src/cli.ts self-test
 *   npx tsx src/cli.ts bench
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPersona, ALL_PERSONAS } from './core/simulator';
import { lateInterest, getRulepack } from './core/negotiate';
import { verifyJsonl, type ChainReport } from './core/ledger';
import { DEFAULT_POLICY } from './core/fixtures';
import { usd, type MandatePolicy, type UsState } from './core/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOLD = '\x1b[1m', DIM = '\x1b[2m', GRN = '\x1b[32m', RED = '\x1b[31m', CYN = '\x1b[36m', YEL = '\x1b[33m', RST = '\x1b[0m';

function parse(argv: string[]): { cmd: string; positional: string[]; flags: Record<string, string | boolean> } {
  const [cmd = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

function num(v: string | boolean | undefined, fallback: number): number {
  if (typeof v !== 'string') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// --- help ------------------------------------------------------------------

function help(): void {
  const rows: [string, string][] = [
    ['simulate --persona <name> --floor <pct>', 'run one debtor persona through the state machine'],
    ['interest --state <CA|TX|NY> --days <n> --amount <usd>', 'statutory late-interest from the state rulepack'],
    ['verify [ledger.jsonl]', 'standalone chain/sig/Merkle/I5 verify (defaults to verify/data/ledger.jsonl)'],
    ['self-test', 'offline austin_designer end-to-end proof (+ 12-persona sweep)'],
    ['bench', 'per-stage p50/p95 latency of the offline components'],
    ['help', 'this message'],
  ];
  console.log(`${BOLD}dunningkit${RST} — Recoup offline AR-clerk CLI  ${DIM}(all offline, deterministic, no network)${RST}\n`);
  console.log(`${BOLD}USAGE${RST}\n  npx tsx src/cli.ts <command> [flags]   ${DIM}(or: npm run dunningkit -- <command>)${RST}\n`);
  console.log(`${BOLD}COMMANDS${RST}`);
  for (const [sig, desc] of rows) console.log(`  ${CYN}${sig.padEnd(52)}${RST} ${desc}`);
  console.log(`\n${BOLD}EXAMPLES${RST}`);
  console.log(`  ${DIM}$${RST} npx tsx src/cli.ts simulate --persona hardship --floor 60`);
  console.log(`  ${DIM}$${RST} npx tsx src/cli.ts interest --state CA --days 87 --amount 4800`);
  console.log(`  ${DIM}$${RST} npx tsx src/cli.ts verify verify/data/ledger.jsonl`);
  console.log(`\n${BOLD}PERSONAS${RST}\n  ${ALL_PERSONAS.map((p) => p.name).join(', ')}`);
}

// --- simulate --------------------------------------------------------------

async function simulate(flags: Record<string, string | boolean>): Promise<number> {
  const name = typeof flags.persona === 'string' ? flags.persona : 'hardship';
  const persona = ALL_PERSONAS.find((p) => p.name === name);
  if (!persona) {
    console.error(`${RED}unknown persona '${name}'${RST}. available: ${ALL_PERSONAS.map((p) => p.name).join(', ')}`);
    return 2;
  }
  const floorPct = num(flags.floor, DEFAULT_POLICY.floorPct);
  const policy: MandatePolicy = { ...DEFAULT_POLICY, floorPct };

  console.log(`${BOLD}dunningkit simulate${RST} — persona ${CYN}${persona.name}${RST}  ${DIM}(mandate floor ${floorPct}% · ≤${policy.maxInstallments} installments)${RST}`);
  console.log(`  ${DIM}${persona.description}${RST}\n`);

  let r;
  try {
    r = await runPersona(persona, policy);
  } catch (err) {
    console.error(`${RED}simulation error:${RST} ${(err as Error).message}`);
    return 1;
  }

  const ok = r.executedViolations === 0 && r.ledgerOk;
  const line = (k: string, v: string) => console.log(`  ${k.padEnd(22)} ${v}`);
  line('final state', `${r.resolved ? GRN : YEL}${r.finalState}${RST}${r.resolved ? '' : ' (unresolved)'}`);
  line('invoiced', usd(r.invoicedCents));
  line('recovered', `${GRN}${usd(r.recoveredCents)}${RST}  (${((r.recoveredCents / r.invoicedCents) * 100).toFixed(1)}%)`);
  line('days to resolution', r.daysToResolution === null ? '—' : String(r.daysToResolution));
  line('sends', String(r.sends));
  line('gate denials', `${r.gateDenials} ${DIM}(expected on adversarial offers)${RST}`);
  line('critic blocks', String(r.criticBlocks));
  line('policy violations', `${r.executedViolations === 0 ? GRN : RED}${r.executedViolations}${RST}`);
  line('ledger', `${r.ledgerOk ? GRN + 'verified' : RED + 'BAD'}${RST} (${r.ledgerLength} entries)`);
  console.log(`\n  ${ok ? GRN + 'OK' : RED + 'FAIL'}${RST} — ${ok ? 'bounded: 0 executed violations, ledger verifies' : 'invariant breach detected'}`);
  return ok ? 0 : 1;
}

// --- interest --------------------------------------------------------------

function interest(flags: Record<string, string | boolean>): number {
  const state = (typeof flags.state === 'string' ? flags.state.toUpperCase() : 'CA') as UsState;
  const days = num(flags.days, 0);
  const amountUsd = num(flags.amount, 0);
  const amountCents = Math.round(amountUsd * 100);
  if (amountCents <= 0) { console.error(`${RED}--amount must be a positive USD value${RST}`); return 2; }

  let calc;
  try {
    calc = lateInterest(amountCents, days, getRulepack(state));
  } catch (err) {
    console.error(`${RED}${(err as Error).message}${RST} (states: CA, TX, NY)`);
    return 2;
  }

  console.log(`${BOLD}dunningkit interest${RST} — ${CYN}${state}${RST}  ${DIM}${calc.citation}${RST}\n`);
  const line = (k: string, v: string) => console.log(`  ${k.padEnd(22)} ${v}`);
  line('principal', usd(amountCents));
  line('days overdue', String(days));
  line('annual rate', `${calc.annualRatePct}%  ${DIM}(rulepack ${calc.rulepackVersion})${RST}`);
  line('accrual days', `${calc.accrualDays} ${DIM}(after grace)${RST}`);
  line('statutory interest', `${GRN}${usd(calc.interestCents)}${RST}`);
  line('balance + interest', `${BOLD}${usd(amountCents + calc.interestCents)}${RST}`);
  console.log(`\n  ${DIM}formula:${RST} ${calc.formula}`);
  console.log(`  ${YEL}FIXTURE rulepack — not legal advice.${RST}`);
  return 0;
}

// --- verify ----------------------------------------------------------------

function report(rep: ChainReport): void {
  const line = (k: string, v: string) => console.log(`  ${k.padEnd(16)} ${v}`);
  line('entries', String(rep.length));
  line('chain valid', rep.ok ? `${GRN}YES${RST}` : `${RED}NO${RST}`);
  line('fee rows (I5)', `${rep.feeRowsChecked} checked`);
  console.log('  merkle roots (per UTC day):');
  for (const [day, root] of Object.entries(rep.merkleRoots)) console.log(`    ${CYN}${day}${RST}  ${DIM}${root}${RST}`);
  if (rep.errors.length) { console.log(`  ${RED}errors:${RST}`); for (const e of rep.errors) console.log(`    ${RED}✗${RST} ${e}`); }
}

function verify(positional: string[]): number {
  const path = positional[0] ? resolve(process.cwd(), positional[0]) : join(ROOT, 'verify', 'data', 'ledger.jsonl');
  if (!existsSync(path)) {
    console.error(`${RED}no ledger at ${path}${RST}\n  pass a path, or run \`npm run self-test\` to export verify/data/ledger.jsonl first.`);
    return 2;
  }
  console.log(`${BOLD}dunningkit verify${RST} — ${DIM}${path}${RST}\n`);
  const rep = verifyJsonl(readFileSync(path, 'utf8'));
  report(rep);
  console.log(`\n  VERIFY: ${rep.ok ? GRN + 'PASS' : RED + 'FAIL'}${RST}`);
  return rep.ok ? 0 : 1;
}

// --- delegate (self-test / bench reuse the existing scripts verbatim) -------

function delegate(script: string, args: string[] = []): number {
  const tsx = join(ROOT, 'node_modules', '.bin', 'tsx');
  const bin = existsSync(tsx) ? tsx : 'npx';
  const argv = existsSync(tsx) ? [join(ROOT, 'scripts', script), ...args] : ['tsx', join(ROOT, 'scripts', script), ...args];
  const res = spawnSync(bin, argv, { stdio: 'inherit', cwd: ROOT });
  return res.status ?? 1;
}

// --- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const { cmd, positional, flags } = parse(process.argv.slice(2));
  let code = 0;
  switch (cmd) {
    case 'simulate': code = await simulate(flags); break;
    case 'interest': code = interest(flags); break;
    case 'verify': code = verify(positional); break;
    case 'self-test': case 'selftest': code = delegate('self_test.ts'); break;
    case 'bench': code = delegate('bench.ts'); break;
    case 'help': case '--help': case '-h': case undefined: help(); break;
    default:
      console.error(`${RED}unknown command '${cmd}'${RST}\n`); help(); code = 2;
  }
  process.exit(code);
}

main().catch((err) => { console.error(`${RED}fatal:${RST}`, err); process.exit(1); });
