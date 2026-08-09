/**
 * Append-only decision ledger (COMPLEXITY §2, invariants I5/I6).
 *
 *   entry_hash = SHA-256(prev_hash ∥ canonical_json(core fields))
 *
 * Each entry is Ed25519-signed (node:crypto) over the entry-hash bytes and
 * carries the signer's SPKI public key so an exported JSONL file verifies
 * standalone. Daily Merkle roots summarize each UTC day.
 *
 * I5: every 'fee' row must reference (via refs) exactly one earlier 'payment'
 * entry and at least one earlier decision entry (proposal/plan_accepted/send)
 * for the same invoice — the causal chain from decision to money to fee.
 */

import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, KeyObject } from 'node:crypto';
import { canonicalJson } from './canonical';
import type { Clock, LedgerEntry, LedgerEntryInput, LedgerKind } from '../types';

export const GENESIS_HASH = '0'.repeat(64);

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface SignerKeys {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyB64: string; // SPKI DER, base64
}

export function newSigner(): SignerKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKey,
    publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** The exact byte string hashed for an entry (kept in one place for tests). */
export function entryCore(e: Omit<LedgerEntry, 'entryHash' | 'sig' | 'pubkey'>): string {
  return canonicalJson({
    seq: e.seq,
    ts: e.ts,
    actor: e.actor,
    kind: e.kind,
    invoiceId: e.invoiceId,
    payload: e.payload,
    refs: e.refs,
    prevHash: e.prevHash,
  });
}

export function computeEntryHash(e: Omit<LedgerEntry, 'entryHash' | 'sig' | 'pubkey'>): string {
  return sha256Hex(e.prevHash + entryCore(e));
}

export class Ledger {
  private readonly entries: LedgerEntry[] = [];
  private readonly signer: SignerKeys;
  private readonly clock: Clock;

  constructor(clock: Clock, signer: SignerKeys = newSigner()) {
    this.clock = clock;
    this.signer = signer;
  }

  get length(): number {
    return this.entries.length;
  }

  get headHash(): string {
    const last = this.entries[this.entries.length - 1];
    return last ? last.entryHash : GENESIS_HASH;
  }

  append(input: LedgerEntryInput): LedgerEntry {
    const prevHash = this.headHash;
    const draft: Omit<LedgerEntry, 'entryHash' | 'sig' | 'pubkey'> = {
      seq: this.entries.length,
      ts: this.clock.now().toISOString(),
      actor: input.actor,
      kind: input.kind,
      invoiceId: input.invoiceId,
      payload: input.payload,
      refs: input.refs ? [...input.refs] : [],
      prevHash,
    };
    const entryHash = computeEntryHash(draft);
    const sig = edSign(null, Buffer.from(entryHash, 'hex'), this.signer.privateKey).toString('base64');
    const entry: LedgerEntry = Object.freeze({
      ...draft,
      entryHash,
      sig,
      pubkey: this.signer.publicKeyB64,
    });
    this.entries.push(entry);
    return entry;
  }

  /** Read-only view; the array and its rows are copies/frozen. */
  all(): LedgerEntry[] {
    return this.entries.slice();
  }

  tail(n: number): LedgerEntry[] {
    return this.entries.slice(-n);
  }

  byKind(kind: LedgerKind): LedgerEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }

  find(hash: string): LedgerEntry | undefined {
    return this.entries.find((e) => e.entryHash === hash);
  }

  exportJsonl(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n') + (this.entries.length ? '\n' : '');
  }

  dailyMerkleRoots(): Record<string, string> {
    return dailyMerkleRoots(this.entries);
  }
}

// ---------------------------------------------------------------------------
// Merkle
// ---------------------------------------------------------------------------

export function merkleRoot(leafHashesHex: string[]): string {
  if (leafHashesHex.length === 0) throw new Error('merkleRoot of zero leaves');
  let level = leafHashesHex.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1] ?? a; // odd count: duplicate last
      next.push(sha256Hex(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')])));
    }
    level = next;
  }
  return level[0]!;
}

export function dailyMerkleRoots(entries: readonly LedgerEntry[]): Record<string, string> {
  const byDay = new Map<string, string[]>();
  for (const e of entries) {
    const day = e.ts.slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(e.entryHash);
    byDay.set(day, list);
  }
  const out: Record<string, string> = {};
  for (const [day, hashes] of [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[day] = merkleRoot(hashes);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verification (I5 + I6) — works on exported JSONL, no Ledger instance needed
// ---------------------------------------------------------------------------

export interface ChainReport {
  ok: boolean;
  length: number;
  errors: string[];
  feeRowsChecked: number;
  merkleRoots: Record<string, string>;
}

const DECISION_KINDS: ReadonlySet<string> = new Set(['proposal', 'plan_accepted', 'send', 'strategy', 'policy_check']);

export function parseJsonl(jsonl: string): LedgerEntry[] {
  return jsonl
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as LedgerEntry;
      } catch {
        throw new Error(`line ${i + 1}: not valid JSON`);
      }
    });
}

export function verifyChain(entries: readonly LedgerEntry[]): ChainReport {
  const errors: string[] = [];
  let prev = GENESIS_HASH;
  const seenHashes = new Map<string, LedgerEntry>();

  entries.forEach((e, i) => {
    if (e.seq !== i) errors.push(`seq mismatch at index ${i}: got ${e.seq}`);
    if (e.prevHash !== prev) errors.push(`prev_hash mismatch at seq ${i}: expected ${prev.slice(0, 12)}…, got ${String(e.prevHash).slice(0, 12)}…`);
    let recomputed: string | undefined;
    try {
      recomputed = computeEntryHash(e);
    } catch (err) {
      errors.push(`seq ${i}: cannot canonicalize payload (${(err as Error).message})`);
    }
    if (recomputed && recomputed !== e.entryHash) errors.push(`entry_hash mismatch at seq ${i}`);
    try {
      const pub = createPublicKey({ key: Buffer.from(e.pubkey, 'base64'), type: 'spki', format: 'der' });
      const ok = edVerify(null, Buffer.from(e.entryHash, 'hex'), pub, Buffer.from(e.sig, 'base64'));
      if (!ok) errors.push(`signature invalid at seq ${i}`);
    } catch (err) {
      errors.push(`signature unverifiable at seq ${i}: ${(err as Error).message}`);
    }
    seenHashes.set(e.entryHash, e);
    prev = e.entryHash;
  });

  // I5 — fee rows causally link to a payment AND the decision chain behind it.
  let feeRowsChecked = 0;
  entries.forEach((e, i) => {
    if (e.kind !== 'fee') return;
    feeRowsChecked += 1;
    const refs = e.refs ?? [];
    const resolved = refs.map((r) => {
      const target = seenHashes.get(r);
      if (!target) {
        errors.push(`I5: fee at seq ${i} references unknown hash ${r.slice(0, 12)}…`);
        return undefined;
      }
      if (target.seq >= e.seq) {
        errors.push(`I5: fee at seq ${i} references a non-prior entry (seq ${target.seq})`);
        return undefined;
      }
      return target;
    });
    const payments = resolved.filter((t) => t?.kind === 'payment');
    const decisions = resolved.filter((t) => t && DECISION_KINDS.has(t.kind));
    if (payments.length !== 1) errors.push(`I5: fee at seq ${i} must reference exactly one payment entry (got ${payments.length})`);
    if (decisions.length < 1) errors.push(`I5: fee at seq ${i} must reference the decision chain (got 0 decision refs)`);
    const wrongInvoice = resolved.find((t) => t && t.invoiceId !== e.invoiceId);
    if (wrongInvoice) errors.push(`I5: fee at seq ${i} references entry for a different invoice (${wrongInvoice.invoiceId})`);
  });

  return {
    ok: errors.length === 0,
    length: entries.length,
    errors,
    feeRowsChecked,
    merkleRoots: entries.length ? dailyMerkleRoots(entries) : {},
  };
}

export function verifyJsonl(jsonl: string): ChainReport {
  return verifyChain(parseJsonl(jsonl));
}
