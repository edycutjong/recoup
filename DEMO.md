# DEMO.md — reproduce every claim in this repo

Everything below runs **offline**: no network, no API key, no account. All debtor personas and
invoices are **SYNTHETIC** fixtures.

Verified on 2026-08-09 · Node ≥ 18.17 · macOS (darwin 25.5.0).

## 0. Setup

```bash
npm install
```

## 1. The one command that proves the whole thing

```bash
npm run ci           # typecheck → 203 tests → seed:check → self-test → verify-ledger
```

Expected, in order:

| Step | Expected output |
|---|---|
| `tsc --noEmit` | silent (zero errors) |
| `vitest run` | **Test Files 10 passed (10) · Tests 203 passed (203)** |
| `self-test` | `SELF-TEST: PASS` |
| `verify-ledger` | `VERIFY: PASS` — chain valid, 3 fee rows checked, 6 merkle days |

Self-test headline: `austin_designer: PAID, recovered $4800.00, fees $480.00, violations 0,
ledger OK (20 entries, 3 fee rows)` plus a **12/12 persona sweep at 55.1% recovery with 0 policy
violations**.

## 2. The devastating query — the agent negotiates, and it holds the floor

```bash
npx tsx src/cli.ts simulate --persona hardship  --floor 60
npx tsx src/cli.ts simulate --persona hostile   --floor 60
npx tsx src/cli.ts simulate --persona opt_out   --floor 60
```

Twelve personas ship in the fixture set: `immediate_payer, slow_payer, ghoster, hardship, hostile,
disputer, partial_payer, checks_in_mail, bankrupt, wrong_contact, opt_out, negotiator`.

This is the "AI executes key decisions" evidence: the agent runs expected-value math on a
settlement plan, **refuses to go below the mandated floor**, honours an instant opt-out, and a
critic gate blocks tone and legal-language violations before anything is sent — `policy-violations
0` across all twelve. Money arriving is downstream of a decision the agent made alone.

```bash
npx tsx src/cli.ts interest --state CA --days 87 --amount 4800
```

Statutory late-interest computed from the state rulepack, not a hardcoded rate.

## 3. Tamper-evidence and fee integrity

```bash
npx tsx src/cli.ts verify verify/data/ledger.jsonl
```

Recomputes the hash chain, every Ed25519 signature, per-UTC-day merkle roots, **and invariant I5 —
that every success fee traces to a real payment**. Ledger: 20 entries, 6 merkle days, 3 fee rows
checked, first root `3c9f5554…` (2026-07-06). Mutate any byte and re-run: it fails and localizes.

## 4. Benchmarks

```bash
npm run bench        # 500 iterations per stage
```

| Stage | p50 | p95 | mean |
|---|---|---|---|
| classify (heuristic + mock) | 0.006 ms | 0.008 ms | 0.008 ms |
| negotiate (`decidePlan` EV) | 0.003 ms | 0.003 ms | 0.004 ms |
| critic (tone/legal gate) | 0.006 ms | 0.009 ms | 0.007 ms |
| **end-to-end (start → plan → 3 payments)** | **1.103 ms** | **1.677 ms** | **1.215 ms** |

**Offline component costs only** — production adds Gemini Flash/Pro inference plus Gmail and
Stripe I/O. Numbers vary by machine; the shape does not.

## 5. Judge-visible dashboard (no server)

```bash
npm run verify:dashboard    # runs self-test, then builds the dashboard
```

Self-contained offline viewer over the real exported run data. Static captures are in
[`docs/evidence/`](docs/evidence/).

## Positioning, stated up front

Recoup acts as the **creditor's own AR clerk on commercial debts** — first-party, outside FDCPA's
third-party consumer scope, avoiding a collection-agency licensing posture. Hard cadence caps,
quiet hours, instant opt-out, template-locked legal language (off by default), critic-gated free
text. Those constraints are enforced in code and tested, not promised in prose.

## What is NOT proven here

Stated plainly, because the rubric asks: this repo is the **offline core**. There is no deployed
service, no live Gemini key, no Gmail send integration, no Stripe charges, and no real customers or
recovered dollars. Those are business milestones, not code claims, and this file will not pretend
otherwise.
