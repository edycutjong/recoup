/**
 * The 12 scripted debtor personas (COMPLEXITY §5), DETERMINISTIC mode.
 *
 * >>> SYNTHETIC FIXTURES — every reply is scripted; no LLM in the loop. <<<
 * Production adds a Gemini role-play mode behind the same Persona shape;
 * this scripted mode is the regression harness (violation rate must read 0).
 */

import type { Invoice } from '../types';
import type { StateName } from '../machine';
import {
  AUSTIN_DESIGNER,
  HOSTILE_HARRY,
  GHOST_LLC,
  QUICK_WIN,
  HARDSHIP_AMBIGUOUS_REPLY,
  ACCEPTANCE_REPLY,
  HOSTILE_REPLY,
  DISPUTE_REPLY,
  OPT_OUT_REPLY,
  BANKRUPT_REPLY,
  WRONG_CONTACT_REPLY,
  PARTIAL_OFFER_REPLY,
  NEGOTIATOR_OPENER_REPLY,
  NEGOTIATOR_LOWBALL_REPLY,
  PROMISE_REPLY,
} from '../fixtures';

export type PersonaStep =
  | { day: number; kind: 'silence' } // cadence timer fires, debtor said nothing
  | { day: number; kind: 'reply'; text: string }
  | { day: number; kind: 'pay_full' }
  | { day: number; kind: 'pay_installment'; index: number };

export interface Persona {
  name: string;
  description: string;
  invoice: Invoice;
  steps: PersonaStep[];
  expected: {
    finalState: StateName;
    recoveredCents: number;
  };
}

export const PERSONAS: Persona[] = [
  {
    name: 'immediate_payer',
    description: 'Pays the full balance on the first touch.',
    invoice: QUICK_WIN,
    steps: [{ day: 1, kind: 'pay_full' }],
    expected: { finalState: 'PAID', recoveredCents: QUICK_WIN.amountCents },
  },
  {
    name: 'slow_payer',
    description: 'Needs the full ladder; pays after touch 3.',
    invoice: AUSTIN_DESIGNER,
    steps: [
      { day: 7, kind: 'silence' },
      { day: 14, kind: 'silence' },
      { day: 18, kind: 'pay_full' },
    ],
    expected: { finalState: 'PAID', recoveredCents: AUSTIN_DESIGNER.amountCents },
  },
  {
    name: 'ghoster',
    description: 'Never replies; ladder exhausts into a reasoned write-off memo.',
    invoice: GHOST_LLC,
    steps: [
      { day: 7, kind: 'silence' },
      { day: 14, kind: 'silence' },
      { day: 21, kind: 'silence' }, // ladder exhausted → recommend_writeoff
    ],
    expected: { finalState: 'WRITEOFF_RECOMMENDED', recoveredCents: 0 },
  },
  {
    name: 'hardship',
    description: 'The austin_designer demo path: ambiguous hardship → 3×$1,600 plan → paid.',
    invoice: AUSTIN_DESIGNER,
    steps: [
      { day: 7, kind: 'silence' },
      { day: 8, kind: 'reply', text: HARDSHIP_AMBIGUOUS_REPLY },
      { day: 9, kind: 'reply', text: ACCEPTANCE_REPLY },
      { day: 10, kind: 'pay_installment', index: 0 },
      { day: 40, kind: 'pay_installment', index: 1 },
      { day: 70, kind: 'pay_installment', index: 2 },
    ],
    expected: { finalState: 'PAID', recoveredCents: AUSTIN_DESIGNER.amountCents },
  },
  {
    name: 'hostile',
    description: 'hostile_harry beat: sharp draft blocked by critic, de-escalation sent, then pays.',
    invoice: HOSTILE_HARRY,
    steps: [
      { day: 7, kind: 'silence' },
      { day: 8, kind: 'reply', text: HOSTILE_REPLY },
      { day: 12, kind: 'reply', text: "Fine. Point made — I'm paying it now through your link." },
      { day: 13, kind: 'pay_full' },
    ],
    expected: { finalState: 'PAID', recoveredCents: HOSTILE_HARRY.amountCents },
  },
  {
    name: 'disputer',
    description: 'Contests the debt; agent flags and hands off to the human client.',
    invoice: AUSTIN_DESIGNER,
    steps: [
      { day: 7, kind: 'silence' },
      { day: 8, kind: 'reply', text: DISPUTE_REPLY },
    ],
    expected: { finalState: 'CLIENT', recoveredCents: 0 },
  },
  {
    name: 'partial_payer',
    description: 'Offers 50%; gate refuses below-floor accept; settles at the 60% floor in 3 parts.',
    invoice: AUSTIN_DESIGNER,
    steps: [
      { day: 7, kind: 'silence' },
      { day: 8, kind: 'reply', text: PARTIAL_OFFER_REPLY },
      { day: 9, kind: 'reply', text: 'Deal. Works for us.' },
      { day: 10, kind: 'pay_installment', index: 0 },
      { day: 40, kind: 'pay_installment', index: 1 },
      { day: 70, kind: 'pay_installment', index: 2 },
    ],
    expected: { finalState: 'PAID', recoveredCents: 288_000 }, // 60% of $4,800
  },
  {
    name: 'checks_in_mail',
    description: 'Serial promiser; two unverified promises before the money actually lands.',
    invoice: HOSTILE_HARRY,
    steps: [
      { day: 7, kind: 'silence' },
      { day: 8, kind: 'reply', text: PROMISE_REPLY },
      { day: 16, kind: 'reply', text: "It must have gotten lost — I'll resend next week, promise." },
      { day: 28, kind: 'pay_full' },
    ],
    expected: { finalState: 'PAID', recoveredCents: HOSTILE_HARRY.amountCents },
  },
  {
    name: 'bankrupt',
    description: 'Declares chapter 7; agent recommends write-off instead of wasting effort.',
    invoice: GHOST_LLC,
    steps: [
      { day: 7, kind: 'silence' },
      { day: 8, kind: 'reply', text: BANKRUPT_REPLY },
    ],
    expected: { finalState: 'WRITEOFF_RECOMMENDED', recoveredCents: 0 },
  },
  {
    name: 'wrong_contact',
    description: 'Redirects to AP; cadence restarts at the corrected address, then pays.',
    invoice: QUICK_WIN,
    steps: [
      { day: 7, kind: 'silence' },
      { day: 8, kind: 'reply', text: WRONG_CONTACT_REPLY },
      { day: 15, kind: 'silence' },
      { day: 16, kind: 'pay_full' },
    ],
    expected: { finalState: 'PAID', recoveredCents: QUICK_WIN.amountCents },
  },
  {
    name: 'opt_out',
    description: 'Demands contact stop; I3 halts everything within one tick, permanently.',
    invoice: HOSTILE_HARRY,
    steps: [
      { day: 3, kind: 'reply', text: OPT_OUT_REPLY },
      { day: 7, kind: 'silence' }, // timer still fires; MUST produce zero sends
      { day: 14, kind: 'silence' },
    ],
    expected: { finalState: 'OPTED_OUT', recoveredCents: 0 },
  },
];

/** Extra scripted exchange used by tests for the negotiator flow. */
export const NEGOTIATOR_PERSONA: Persona = {
  name: 'negotiator',
  description: 'Asks for 5 installments (clamped to 3), lowballs 40% (refused), settles at floor.',
  invoice: AUSTIN_DESIGNER,
  steps: [
    { day: 7, kind: 'silence' },
    { day: 8, kind: 'reply', text: NEGOTIATOR_OPENER_REPLY },
    { day: 9, kind: 'reply', text: NEGOTIATOR_LOWBALL_REPLY },
    { day: 10, kind: 'reply', text: ACCEPTANCE_REPLY },
    { day: 11, kind: 'pay_installment', index: 0 },
    { day: 41, kind: 'pay_installment', index: 1 },
    { day: 71, kind: 'pay_installment', index: 2 },
  ],
  expected: { finalState: 'PAID', recoveredCents: 288_000 },
};

// The COMPLEXITY §5 roster is 12 personas; `ghost`-the-intent and
// `ghoster`-the-persona are distinct things. The canonical 12:
export const ALL_PERSONAS: Persona[] = [...PERSONAS, NEGOTIATOR_PERSONA];

if (ALL_PERSONAS.length !== 12) {
  throw new Error(`persona roster must be exactly 12 (got ${ALL_PERSONAS.length})`);
}
