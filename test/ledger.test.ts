/**
 * Decision ledger (COMPLEXITY §2, invariants I5/I6): canonical JSON, hash chain,
 * Ed25519 signatures, Merkle roots, tamper detection, and the causal fee-linkage
 * that ties every success fee to a payment event AND the decision chain (I5).
 */

import { describe, expect, it } from 'vitest';
import { sign as edSign } from 'node:crypto';
import { canonicalJson, CanonicalJsonError } from '../src/core/ledger/canonical';
import {
  Ledger,
  GENESIS_HASH,
  sha256Hex,
  newSigner,
  computeEntryHash,
  merkleRoot,
  dailyMerkleRoots,
  verifyChain,
  verifyJsonl,
  parseJsonl,
} from '../src/core/ledger';
import { FixedClock } from '../src/core/types';
import type { LedgerEntry } from '../src/core/types';

const clock = () => new FixedClock('2026-07-06T10:00:00.000Z');

// ---------------------------------------------------------------------------
// Canonical JSON (I6 depends on a stable encoding)
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  it('sorts object keys and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it('is invariant to input key order', () => {
    expect(canonicalJson({ a: 1, b: { d: 4, c: 3 } })).toBe(canonicalJson({ b: { c: 3, d: 4 }, a: 1 }));
  });
  it('handles nested arrays and strings with escaping', () => {
    expect(canonicalJson({ xs: [1, 'a"b', true, null] })).toBe('{"xs":[1,"a\\"b",true,null]}');
  });
  it('omits undefined-valued properties (absent === undefined)', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
  it.each([
    ['top-level undefined', () => canonicalJson(undefined)],
    ['NaN', () => canonicalJson(Number.NaN)],
    ['Infinity', () => canonicalJson(Number.POSITIVE_INFINITY)],
    ['bigint', () => canonicalJson(10n)],
    ['function', () => canonicalJson(() => 1)],
    ['symbol', () => canonicalJson(Symbol('x'))],
    ['undefined array element', () => canonicalJson([undefined])],
  ])('rejects %s', (_l, fn) => {
    expect(fn).toThrowError(CanonicalJsonError);
  });
  it('rejects circular references', () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => canonicalJson(o)).toThrowError(CanonicalJsonError);
  });
});

// ---------------------------------------------------------------------------
// Hash chain + signatures (I6)
// ---------------------------------------------------------------------------

describe('Ledger hash chain', () => {
  it('starts from genesis and chains prevHash → entryHash', () => {
    const led = new Ledger(clock());
    expect(led.headHash).toBe(GENESIS_HASH);
    const a = led.append({ actor: 'intake', kind: 'intake', invoiceId: 'INV', payload: { n: 1 } });
    const b = led.append({ actor: 'sender', kind: 'send', invoiceId: 'INV', payload: { n: 2 } });
    expect(a.seq).toBe(0);
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.prevHash).toBe(a.entryHash);
    expect(led.headHash).toBe(b.entryHash);
  });

  it('entryHash equals SHA-256(prevHash ∥ canonical core)', () => {
    const led = new Ledger(clock());
    const e = led.append({ actor: 'intake', kind: 'intake', invoiceId: 'INV', payload: { n: 1 } });
    const { entryHash, sig, pubkey, ...core } = e;
    void sig; void pubkey;
    expect(computeEntryHash(core)).toBe(entryHash);
  });

  it('a fresh signer produces a chain that verifies standalone', () => {
    const led = new Ledger(clock(), newSigner());
    led.append({ actor: 'intake', kind: 'intake', invoiceId: 'INV', payload: { n: 1 } });
    led.append({ actor: 'sender', kind: 'send', invoiceId: 'INV', payload: { n: 2 } });
    const rep = verifyChain(led.all());
    expect(rep.ok).toBe(true);
    expect(rep.errors).toEqual([]);
    expect(rep.length).toBe(2);
  });

  it('exportJsonl → parseJsonl → verifyJsonl round-trips', () => {
    const led = new Ledger(clock());
    led.append({ actor: 'intake', kind: 'intake', invoiceId: 'INV', payload: { n: 1 } });
    led.append({ actor: 'sender', kind: 'send', invoiceId: 'INV', payload: { n: 2 } });
    const jsonl = led.exportJsonl();
    expect(parseJsonl(jsonl).length).toBe(2);
    expect(verifyJsonl(jsonl).ok).toBe(true);
  });

  it('byKind / find / tail read helpers', () => {
    const led = new Ledger(clock());
    led.append({ actor: 'intake', kind: 'intake', invoiceId: 'INV', payload: { n: 1 } });
    const s = led.append({ actor: 'sender', kind: 'send', invoiceId: 'INV', payload: { n: 2 } });
    expect(led.byKind('send').length).toBe(1);
    expect(led.find(s.entryHash)).toEqual(s);
    expect(led.tail(1)).toEqual([s]);
  });
});

function mutableCopy(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return JSON.parse(JSON.stringify(entries));
}

describe('Ledger tamper detection', () => {
  const build = () => {
    const led = new Ledger(clock());
    led.append({ actor: 'intake', kind: 'intake', invoiceId: 'INV', payload: { n: 1 } });
    led.append({ actor: 'sender', kind: 'send', invoiceId: 'INV', payload: { n: 2 } });
    led.append({ actor: 'treasury', kind: 'payment', invoiceId: 'INV', payload: { n: 3 } });
    return led;
  };

  it('detects a mutated payload (entry_hash mismatch)', () => {
    const arr = mutableCopy(build().all());
    (arr[1]!.payload as { n: number }).n = 999;
    const rep = verifyChain(arr);
    expect(rep.ok).toBe(false);
    expect(rep.errors.some((e) => e.includes('entry_hash mismatch'))).toBe(true);
  });

  it('detects a forged signature', () => {
    const arr = mutableCopy(build().all());
    arr[2]!.sig = Buffer.from('not a real signature over this hash____________').toString('base64');
    const rep = verifyChain(arr);
    expect(rep.ok).toBe(false);
    expect(rep.errors.some((e) => e.includes('signature'))).toBe(true);
  });

  it('detects a broken prevHash link', () => {
    const arr = mutableCopy(build().all());
    arr[2]!.prevHash = GENESIS_HASH;
    const rep = verifyChain(arr);
    expect(rep.ok).toBe(false);
    expect(rep.errors.some((e) => e.includes('prev_hash mismatch'))).toBe(true);
  });

  it('detects a re-sequenced entry', () => {
    const arr = mutableCopy(build().all());
    arr[1]!.seq = 5;
    const rep = verifyChain(arr);
    expect(rep.ok).toBe(false);
    expect(rep.errors.some((e) => e.includes('seq mismatch'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Merkle (I6)
// ---------------------------------------------------------------------------

describe('merkleRoot', () => {
  it('a single leaf is its own root', () => {
    const h = sha256Hex('leaf');
    expect(merkleRoot([h])).toBe(h);
  });
  it('two leaves hash to SHA-256(a ∥ b)', () => {
    const a = sha256Hex('a');
    const b = sha256Hex('b');
    const expected = sha256Hex(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')]));
    expect(merkleRoot([a, b])).toBe(expected);
  });
  it('duplicates the last leaf on an odd count', () => {
    const a = sha256Hex('a');
    const b = sha256Hex('b');
    const c = sha256Hex('c');
    const h_ab = sha256Hex(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')]));
    const h_cc = sha256Hex(Buffer.concat([Buffer.from(c, 'hex'), Buffer.from(c, 'hex')]));
    const expected = sha256Hex(Buffer.concat([Buffer.from(h_ab, 'hex'), Buffer.from(h_cc, 'hex')]));
    expect(merkleRoot([a, b, c])).toBe(expected);
  });
  it('throws on zero leaves', () => {
    expect(() => merkleRoot([])).toThrow();
  });
  it('groups entries into per-UTC-day roots', () => {
    const led = new Ledger(clock());
    led.append({ actor: 'intake', kind: 'intake', invoiceId: 'INV', payload: { n: 1 } });
    const roots = dailyMerkleRoots(led.all());
    expect(Object.keys(roots)).toEqual(['2026-07-06']);
    expect(roots['2026-07-06']).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// I5 — causal fee linkage
// ---------------------------------------------------------------------------

/** Builds a valid intake→send→payment chain and returns the ledger + key hashes. */
function chainWithPayment() {
  const led = new Ledger(clock());
  led.append({ actor: 'intake', kind: 'intake', invoiceId: 'INV', payload: { a: 1 } });
  const send = led.append({ actor: 'sender', kind: 'send', invoiceId: 'INV', payload: { b: 2 } });
  const pay = led.append({ actor: 'treasury', kind: 'payment', invoiceId: 'INV', payload: { c: 3 } });
  return { led, sendHash: send.entryHash, payHash: pay.entryHash };
}

describe('I5 — fee rows link to a payment AND the decision chain', () => {
  it('a well-formed fee (payment + decision refs) verifies', () => {
    const { led, sendHash, payHash } = chainWithPayment();
    led.append({ actor: 'treasury', kind: 'fee', invoiceId: 'INV', payload: { feeCents: 30 }, refs: [payHash, sendHash] });
    const rep = verifyChain(led.all());
    expect(rep.ok).toBe(true);
    expect(rep.feeRowsChecked).toBe(1);
  });

  it('rejects a fee with no payment reference', () => {
    const { led, sendHash } = chainWithPayment();
    led.append({ actor: 'treasury', kind: 'fee', invoiceId: 'INV', payload: {}, refs: [sendHash] });
    const rep = verifyChain(led.all());
    expect(rep.ok).toBe(false);
    expect(rep.errors.some((e) => e.includes('exactly one payment'))).toBe(true);
  });

  it('rejects a fee referencing two payments', () => {
    const led = new Ledger(clock());
    led.append({ actor: 'intake', kind: 'intake', invoiceId: 'INV', payload: {} });
    const send = led.append({ actor: 'sender', kind: 'send', invoiceId: 'INV', payload: {} });
    const pay1 = led.append({ actor: 'treasury', kind: 'payment', invoiceId: 'INV', payload: { i: 1 } });
    const pay2 = led.append({ actor: 'treasury', kind: 'payment', invoiceId: 'INV', payload: { i: 2 } });
    led.append({ actor: 'treasury', kind: 'fee', invoiceId: 'INV', payload: {}, refs: [pay1.entryHash, pay2.entryHash, send.entryHash] });
    const rep = verifyChain(led.all());
    expect(rep.ok).toBe(false);
    expect(rep.errors.some((e) => e.includes('got 2'))).toBe(true);
  });

  it('rejects a fee with no decision reference', () => {
    const { led, payHash } = chainWithPayment();
    led.append({ actor: 'treasury', kind: 'fee', invoiceId: 'INV', payload: {}, refs: [payHash] });
    const rep = verifyChain(led.all());
    expect(rep.ok).toBe(false);
    expect(rep.errors.some((e) => e.includes('decision'))).toBe(true);
  });

  it('rejects a fee referencing an unknown hash', () => {
    const { led, payHash } = chainWithPayment();
    led.append({ actor: 'treasury', kind: 'fee', invoiceId: 'INV', payload: {}, refs: [payHash, 'ab'.repeat(32)] });
    const rep = verifyChain(led.all());
    expect(rep.ok).toBe(false);
    expect(rep.errors.some((e) => e.includes('unknown hash'))).toBe(true);
  });

  it('rejects a fee referencing an entry for a different invoice', () => {
    const { led, sendHash, payHash } = chainWithPayment();
    led.append({ actor: 'treasury', kind: 'fee', invoiceId: 'OTHER', payload: {}, refs: [payHash, sendHash] });
    const rep = verifyChain(led.all());
    expect(rep.ok).toBe(false);
    expect(rep.errors.some((e) => e.includes('different invoice'))).toBe(true);
  });

  it('rejects a fee that references a NON-PRIOR entry (raw forged chain)', () => {
    // A valid chain can never contain a forward fee reference (the hashes would
    // be circular) — so we hand-build a broken chain to exercise the guard.
    const signer = newSigner();
    const raw = (core: Omit<LedgerEntry, 'entryHash' | 'sig' | 'pubkey'>): LedgerEntry => {
      const entryHash = computeEntryHash(core);
      const sig = edSign(null, Buffer.from(entryHash, 'hex'), signer.privateKey).toString('base64');
      return { ...core, entryHash, sig, pubkey: signer.publicKeyB64 };
    };
    const a = raw({ seq: 0, ts: '2026-07-06T10:00:00.000Z', actor: 'sender', kind: 'send', invoiceId: 'INV', payload: { d: 1 }, refs: [], prevHash: GENESIS_HASH });
    const b = raw({ seq: 2, ts: '2026-07-06T10:00:00.000Z', actor: 'treasury', kind: 'payment', invoiceId: 'INV', payload: { d: 3 }, prevHash: a.entryHash, refs: [] });
    const fee = raw({ seq: 1, ts: '2026-07-06T10:00:00.000Z', actor: 'treasury', kind: 'fee', invoiceId: 'INV', payload: { d: 2 }, prevHash: a.entryHash, refs: [b.entryHash, a.entryHash] });
    const rep = verifyChain([a, fee, b]); // fee(seq1) references payment b(seq2): non-prior
    expect(rep.ok).toBe(false);
    expect(rep.errors.some((e) => e.includes('non-prior'))).toBe(true);
  });
});
