import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MACHINE_CONFIG,
  EscalationMachine,
  EVENT_NAMES,
  InvalidTransitionError,
  STATE_NAMES,
  TERMINAL_STATES,
  TRANSITION_TABLE,
  initialState,
  isTerminal,
  transition,
  type MachineState,
} from '../src/core/machine';

const CFG = { maxCadenceSteps: 3 };

function st(name: (typeof STATE_NAMES)[number], step?: number): MachineState {
  return step === undefined ? { name } : { name, cadenceStep: step };
}

describe('escalation state machine — COMPLEXITY §4 shape', () => {
  it('starts at INTAKE', () => {
    expect(initialState()).toEqual({ name: 'INTAKE' });
  });

  it('INTAKE → CADENCE(1) on START_CADENCE', () => {
    expect(transition(st('INTAKE'), 'START_CADENCE', CFG)).toEqual({ name: 'CADENCE', cadenceStep: 1 });
  });

  it('CADENCE ticks 1→2→3 and is bounded by maxCadenceSteps', () => {
    const s2 = transition(st('CADENCE', 1), 'CADENCE_TICK', CFG);
    expect(s2).toEqual({ name: 'CADENCE', cadenceStep: 2 });
    const s3 = transition(s2, 'CADENCE_TICK', CFG);
    expect(s3).toEqual({ name: 'CADENCE', cadenceStep: 3 });
    expect(() => transition(s3, 'CADENCE_TICK', CFG)).toThrow(InvalidTransitionError);
  });

  it('CADENCE → NEGOTIATING on REPLY_ENGAGED', () => {
    expect(transition(st('CADENCE', 2), 'REPLY_ENGAGED', CFG)).toEqual({ name: 'NEGOTIATING' });
  });

  it('NEGOTIATING ↔ AWAITING loop', () => {
    const awaiting = transition(st('NEGOTIATING'), 'PROPOSAL_SENT', CFG);
    expect(awaiting).toEqual({ name: 'AWAITING' });
    expect(transition(awaiting, 'REPLY_RECEIVED', CFG)).toEqual({ name: 'NEGOTIATING' });
  });

  it('NEGOTIATING → PLAN_ACTIVE → PAID via plan completion', () => {
    const plan = transition(st('NEGOTIATING'), 'PLAN_ACCEPTED', CFG);
    expect(plan).toEqual({ name: 'PLAN_ACTIVE' });
    expect(transition(plan, 'INSTALLMENT_PAID', CFG)).toEqual({ name: 'PLAN_ACTIVE' });
    expect(transition(plan, 'PAYMENT_FULL', CFG)).toEqual({ name: 'PAID' });
  });

  it('AWAITING accepts PLAN_ACCEPTED (acceptance arrives as the awaited reply)', () => {
    expect(transition(st('AWAITING'), 'PLAN_ACCEPTED', CFG)).toEqual({ name: 'PLAN_ACTIVE' });
  });

  it('DISPUTED → CLIENT handoff', () => {
    const disputed = transition(st('CADENCE', 1), 'DISPUTE_FLAGGED', CFG);
    expect(disputed).toEqual({ name: 'DISPUTED' });
    expect(transition(disputed, 'HANDOFF_CLIENT', CFG)).toEqual({ name: 'CLIENT' });
  });

  it('WRITEOFF reachable from CADENCE, NEGOTIATING, AWAITING and PLAN_ACTIVE', () => {
    for (const from of [st('CADENCE', 3), st('NEGOTIATING'), st('AWAITING'), st('PLAN_ACTIVE')]) {
      expect(transition(from, 'WRITEOFF', CFG)).toEqual({ name: 'WRITEOFF_RECOMMENDED' });
    }
  });

  it('CONTACT_CORRECTED restarts the ladder at CADENCE(1)', () => {
    expect(transition(st('NEGOTIATING'), 'CONTACT_CORRECTED', CFG)).toEqual({ name: 'CADENCE', cadenceStep: 1 });
  });

  it('payment can land straight from CADENCE (immediate payer)', () => {
    expect(transition(st('CADENCE', 1), 'PAYMENT_FULL', CFG)).toEqual({ name: 'PAID' });
  });

  it('rejects undefined edges (INTAKE cannot receive a payment)', () => {
    expect(() => transition(st('INTAKE'), 'PAYMENT_FULL', CFG)).toThrow(InvalidTransitionError);
    expect(() => transition(st('INTAKE'), 'REPLY_ENGAGED', CFG)).toThrow(InvalidTransitionError);
    expect(() => transition(st('PLAN_ACTIVE'), 'PROPOSAL_SENT', CFG)).toThrow(InvalidTransitionError);
  });
});

describe('I3 — opt-out totality and permanence', () => {
  const nonTerminal = STATE_NAMES.filter((s) => !isTerminal(s));

  it.each(nonTerminal.map((s) => [s] as const))('OPT_OUT reaches OPTED_OUT from %s in one transition', (name) => {
    const from = name === 'CADENCE' ? st('CADENCE', 2) : st(name);
    expect(transition(from, 'OPT_OUT', CFG)).toEqual({ name: 'OPTED_OUT' });
  });

  it('OPTED_OUT is absorbing: every event rejected forever', () => {
    for (const ev of EVENT_NAMES) {
      expect(() => transition(st('OPTED_OUT'), ev, CFG)).toThrow(InvalidTransitionError);
    }
  });
});

describe('terminal states are absorbing', () => {
  it.each(TERMINAL_STATES.map((s) => [s] as const))('%s rejects every event', (name) => {
    for (const ev of EVENT_NAMES) {
      expect(() => transition(st(name), ev, CFG)).toThrow(InvalidTransitionError);
    }
  });

  it('the transition table itself contains no edge out of a terminal state', () => {
    for (const edge of TRANSITION_TABLE) {
      expect(isTerminal(edge.from)).toBe(false);
    }
  });
});

describe('EscalationMachine wrapper', () => {
  it('records the audited history of a full hardship path', () => {
    const m = new EscalationMachine(CFG);
    m.fire('START_CADENCE');
    m.fire('CADENCE_TICK');
    m.fire('REPLY_ENGAGED');
    m.fire('PROPOSAL_SENT');
    m.fire('PLAN_ACCEPTED');
    m.fire('INSTALLMENT_PAID');
    m.fire('PAYMENT_FULL');
    expect(m.state).toEqual({ name: 'PAID' });
    expect(m.history.map((h) => h.to)).toEqual([
      'CADENCE(1)',
      'CADENCE(2)',
      'NEGOTIATING',
      'AWAITING',
      'PLAN_ACTIVE',
      'PLAN_ACTIVE',
      'PAID',
    ]);
  });

  it('can() probes without mutating', () => {
    const m = new EscalationMachine(CFG);
    expect(m.can('START_CADENCE')).toBe(true);
    expect(m.can('PAYMENT_FULL')).toBe(false);
    expect(m.state).toEqual({ name: 'INTAKE' });
  });

  it('state getter returns a copy (no aliasing)', () => {
    const m = new EscalationMachine(CFG);
    const s = m.state;
    (s as { name: string }).name = 'PAID';
    expect(m.state.name).toBe('INTAKE');
  });

  it('default config caps the ladder at 3', () => {
    expect(DEFAULT_MACHINE_CONFIG.maxCadenceSteps).toBe(3);
  });
});
