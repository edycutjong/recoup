/**
 * Compliance critic (COMPLEXITY §1/§4, invariant I4):
 *  - the template registry is frozen and hash-pinned (locked legal language),
 *  - the second-model critique adapter is the tone/legal oracle behind a gate,
 *  - the legal-language toggle removes only statutory reasons, never tone ones.
 */

import { describe, expect, it } from 'vitest';
import {
  DeterministicCritic,
  RubberStampCritic,
  CriticGate,
  CriticBlockedError,
  renderTemplate,
  getTemplate,
  TEMPLATES,
  TEMPLATE_HASHES,
  TemplateError,
} from '../src/core/critic';
import { draftResponse } from '../src/core/engine/drafts';
import { FixedClock } from '../src/core/types';
import { makeInvoice } from './_util';

const clock = () => new FixedClock('2026-07-06T10:00:00.000Z');
const INV = makeInvoice();

const CADENCE_VARS = {
  debtor_name: 'Dale Kirby',
  invoice_id: 'INV-1',
  amount: '$4,800.00',
  days_overdue: '87',
  payment_link: 'https://pay.example/1',
  client_name: 'Mara Voss',
};
const LEGAL_VARS = { ...CADENCE_VARS, statute_citation: 'Cal. Civ. Code §3289', interest_amount: '$114.41' };

describe('template registry is locked (I4)', () => {
  it('every template has a pinned hash', () => {
    for (const t of TEMPLATES) expect(TEMPLATE_HASHES.get(t.id)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders a cadence template, substituting all placeholders', () => {
    const r = renderTemplate('cadence_1', CADENCE_VARS);
    expect(r.legal).toBe(false);
    expect(r.templateHash).toBe(TEMPLATE_HASHES.get('cadence_1'));
    expect(r.body).toContain('Dale Kirby');
    expect(r.body).toContain('https://pay.example/1');
    expect(r.body).not.toMatch(/\{\{/); // no unresolved placeholder
    expect(r.subject).not.toMatch(/\{\{/);
  });

  it('the legal template renders and reports legal=true', () => {
    const r = renderTemplate('final_notice_legal', LEGAL_VARS);
    expect(r.legal).toBe(true);
    expect(r.body).toContain('Cal. Civ. Code §3289');
  });

  it('render is stable across calls (hash pin holds)', () => {
    expect(renderTemplate('cadence_2', CADENCE_VARS).templateHash).toBe(renderTemplate('cadence_2', CADENCE_VARS).templateHash);
  });

  it('rejects an unknown template', () => {
    expect(() => getTemplate('nope')).toThrowError(TemplateError);
  });
  it('rejects a missing variable', () => {
    const { payment_link, ...missing } = CADENCE_VARS;
    void payment_link;
    expect(() => renderTemplate('cadence_1', missing as Record<string, string>)).toThrowError(TemplateError);
  });
  it('rejects an unexpected variable', () => {
    expect(() => renderTemplate('cadence_1', { ...CADENCE_VARS, surprise: 'x' })).toThrowError(TemplateError);
  });
  it('refuses a variable that would inject another placeholder', () => {
    expect(() => renderTemplate('cadence_1', { ...CADENCE_VARS, debtor_name: 'Hi {{payment_link}}' })).toThrowError(TemplateError);
  });
});

describe('DeterministicCritic — tone gate', () => {
  const critic = () => new DeterministicCritic(clock());

  it('passes a benign draft', async () => {
    const v = await critic().review('Hi Dale, a friendly reminder about your invoice. Thanks!', { legalAllowed: false });
    expect(v.pass).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.receiptId.endsWith('_pass')).toBe(true);
  });

  it('BLOCKS the deliberately sharp hostile draft (SEED_DATA beat)', async () => {
    const sharp = draftResponse('hostile', INV, 'https://pay.example/1');
    const v = await critic().review(sharp, { intent: 'hostile', legalAllowed: false });
    expect(v.pass).toBe(false);
    expect(v.reasons.length).toBeGreaterThan(0);
    expect(v.receiptId.endsWith('_fail')).toBe(true);
  });

  it.each([
    ['abusive label', 'You are a deadbeat and everyone knows it.'],
    ['excessive exclamation', 'Please pay now!!!!'],
    ['coercion', 'Pay up or else.'],
  ])('blocks %s', async (_l, draft) => {
    expect((await critic().review(draft, { legalAllowed: false })).pass).toBe(false);
  });

  it('blocks shouting (caps ratio)', async () => {
    const v = await critic().review('THIS INVOICE REMAINS OUTSTANDING AND OVERDUE', { legalAllowed: false });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.includes('shouting'))).toBe(true);
  });

  it('records the reviewed draft hash', async () => {
    const v = await critic().review('Just a note.', { legalAllowed: false });
    expect(v.reviewedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v.model).toBe('deterministic-critic');
  });
});

describe('DeterministicCritic — legal-language toggle (I4)', () => {
  const legalDraft = 'We may pursue this through small claims and our attorney will be in touch.';

  it('blocks statutory/legal language when the mandate has legal_language=off', async () => {
    const v = await new DeterministicCritic(clock()).review(legalDraft, { legalAllowed: false });
    expect(v.pass).toBe(false);
    expect(v.reasons.some((r) => r.startsWith('I4:'))).toBe(true);
  });

  it('allows the SAME draft once legal_language is on (tone still fine)', async () => {
    const v = await new DeterministicCritic(clock()).review(legalDraft, { legalAllowed: true });
    expect(v.pass).toBe(true);
  });

  it('the toggle never excuses a tone violation', async () => {
    const v = await new DeterministicCritic(clock()).review('Pay up or else, our attorney will sue.', { legalAllowed: true });
    expect(v.pass).toBe(false); // legal is allowed, but coercion is not
  });
});

describe('CriticGate', () => {
  it('retains every receipt (pass and fail) and counts them', async () => {
    const g = new CriticGate(new DeterministicCritic(clock()));
    await g.review('Friendly note.', { legalAllowed: false });
    await g.review(draftResponse('hostile', INV, 'u'), { legalAllowed: false });
    expect(g.receipts.length).toBe(2);
    expect(g.passCount).toBe(1);
    expect(g.failCount).toBe(1);
    expect(g.adapterName).toBe('deterministic-critic');
  });

  it('requireApproval returns on pass and throws CriticBlockedError on fail', async () => {
    const g = new CriticGate(new DeterministicCritic(clock()));
    const ok = await g.requireApproval('All good here.', { legalAllowed: false });
    expect(ok.pass).toBe(true);
    expect(g.getReceipt(ok.receiptId)).toBeDefined();
    await expect(g.requireApproval(draftResponse('hostile', INV, 'u'), { legalAllowed: false })).rejects.toThrowError(CriticBlockedError);
  });

  it('a rubber-stamp critic is the ONLY way a sharp draft passes (proves the adapter is the oracle)', async () => {
    const g = new CriticGate(new RubberStampCritic(clock()));
    const v = await g.requireApproval(draftResponse('hostile', INV, 'u'), { legalAllowed: false });
    expect(v.pass).toBe(true); // only because the test-only stamp said so; the real critic never would
  });
});
