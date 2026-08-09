/**
 * Deterministic fixture corpus (SEED_DATA.md).
 *
 * >>> ALL DATA HERE IS SYNTHETIC — no real debtor, client, or invoice. <<<
 * Demo invoices: austin_designer ($4,800 / 87d / hardship→3×$1,600 path),
 * hostile_harry (critic-block beat), ghost_llc (write-off path), quick_win
 * (pays on touch 2). One shared default mandate policy.
 */

import type { Invoice, MandatePolicy } from './types';

export const SIM_START_ISO = '2026-07-06T10:00:00.000Z';

export const DEFAULT_POLICY: MandatePolicy = {
  floorPct: 60,
  maxInstallments: 3,
  quietHours: { startHour: 21, endHour: 8 },
  maxTouchesPerWeek: 5,
  legalLanguage: false,
};

export const AUSTIN_DESIGNER: Invoice = {
  id: 'INV-2026-0187',
  client: { name: 'Mara Voss Design', email: 'mara@fixture-voss.design' },
  debtor: { entity: 'Bluebonnet Media LLC', contact: 'Dale Kirby', email: 'dale@fixture-bluebonnet.example' },
  amountCents: 480_000, // $4,800
  issuedAt: '2026-04-10T00:00:00.000Z',
  agedDays: 87,
  state: 'CA',
  kind: 'b2b',
  synthetic: true,
};

export const HOSTILE_HARRY: Invoice = {
  id: 'INV-2026-0212',
  client: { name: 'Mara Voss Design', email: 'mara@fixture-voss.design' },
  debtor: { entity: 'Harry & Sons Renovations', contact: 'Harry Stroud', email: 'harry@fixture-stroud.example' },
  amountCents: 215_000, // $2,150
  issuedAt: '2026-05-03T00:00:00.000Z',
  agedDays: 62,
  state: 'TX',
  kind: 'b2b',
  synthetic: true,
};

export const GHOST_LLC: Invoice = {
  id: 'INV-2026-0154',
  client: { name: 'Mara Voss Design', email: 'mara@fixture-voss.design' },
  debtor: { entity: 'Vantablack Ventures LLC', contact: 'AP Department', email: 'ap@fixture-vantablack.example' },
  amountCents: 360_000, // $3,600
  issuedAt: '2026-03-08T00:00:00.000Z',
  agedDays: 120,
  state: 'NY',
  kind: 'b2b',
  synthetic: true,
};

export const QUICK_WIN: Invoice = {
  id: 'INV-2026-0243',
  client: { name: 'Mara Voss Design', email: 'mara@fixture-voss.design' },
  debtor: { entity: 'Copper Kettle Coffee Co.', contact: 'June Park', email: 'june@fixture-copperkettle.example' },
  amountCents: 120_000, // $1,200
  issuedAt: '2026-06-06T00:00:00.000Z',
  agedDays: 30,
  state: 'CA',
  kind: 'b2b',
  synthetic: true,
};

export const FIXTURE_INVOICES: Record<string, Invoice> = {
  austin_designer: AUSTIN_DESIGNER,
  hostile_harry: HOSTILE_HARRY,
  ghost_llc: GHOST_LLC,
  quick_win: QUICK_WIN,
};

/** The SEED_DATA engineered edge: hardship phrased so keyword ghost-matching fails. */
export const HARDSHIP_AMBIGUOUS_REPLY =
  'Hey — appreciate the work, honestly things are tight this quarter, maybe later? We want to make this right but cash flow is rough right now.';

export const ACCEPTANCE_REPLY = 'Agreed — that works for us. Send over the schedule.';

export const HOSTILE_REPLY =
  'Stop harassing me about this. Your emails are an absolute joke and my lawyer will hear about it if this continues.';

export const DISPUTE_REPLY = 'We dispute this invoice — the final deliverables were never approved by our team.';

export const OPT_OUT_REPLY = 'Please stop emailing me. Do not contact us again about this.';

export const BANKRUPT_REPLY = 'The company filed for chapter 7 bankruptcy last month. All creditor claims go through the trustee.';

export const WRONG_CONTACT_REPLY =
  "I left the company last year, so I'm the wrong person for this — reach out to our billing team at ap@fixture-newco.example.";

export const PARTIAL_OFFER_REPLY = "Look, we can pay half now and that's honestly the best we can do. 50% and we call it even?";

export const NEGOTIATOR_OPENER_REPLY = 'Cash is tight this season — could we do 5 monthly payments instead of one lump sum?';

export const NEGOTIATOR_LOWBALL_REPLY = 'What if we settle for 40% as a lump sum? Would you take that?';

export const PROMISE_REPLY = "The check is in the mail — should arrive by next week, I'm told.";

export const GHOSTY_REPLY = "Super busy right now — let me check with the team and I'll circle back.";

export const PAYING_REPLY = "Apologies for the delay — I'm paying it now through the link, should be done today.";
