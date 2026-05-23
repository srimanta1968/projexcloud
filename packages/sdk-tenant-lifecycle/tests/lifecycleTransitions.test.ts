/**
 * Pure-function tests for the tenant-lifecycle FSM. No DB.
 *
 * The VALID_TRANSITIONS table is the source of truth for the operational
 * FSM (P4 §5.9 / FR-TLC-1, scoped to the task spec's five states). These
 * tests pin the allowed edges and confirm offboarded is terminal.
 */
import { describe, expect, it } from 'vitest';
import { VALID_TRANSITIONS, isTerminal } from '../src/services/tenantLifecycleService';
import type { TenantLifecycleState } from '../src/models/tenantLifecycle.model';

const ALL_STATES: TenantLifecycleState[] = ['active', 'suspended', 'offboarding', 'offboarded', 'sandbox'];

describe('Tenant lifecycle VALID_TRANSITIONS', () => {
  it('every state is enumerated', () => {
    for (const s of ALL_STATES) {
      expect(VALID_TRANSITIONS[s]).toBeDefined();
    }
  });

  it('active can branch to suspended, offboarding, or sandbox', () => {
    expect([...VALID_TRANSITIONS.active].sort()).toEqual(['offboarding', 'sandbox', 'suspended']);
  });

  it('suspended can be reinstated (active) or escalated to offboarding', () => {
    expect([...VALID_TRANSITIONS.suspended].sort()).toEqual(['active', 'offboarding']);
  });

  it('offboarding terminates only at offboarded (deadline-gated)', () => {
    expect(VALID_TRANSITIONS.offboarding).toEqual(['offboarded']);
  });

  it('sandbox can only flow to offboarded (no re-promote to active)', () => {
    expect(VALID_TRANSITIONS.sandbox).toEqual(['offboarded']);
  });

  it('offboarded is terminal', () => {
    expect(VALID_TRANSITIONS.offboarded).toEqual([]);
    expect(isTerminal('offboarded')).toBe(true);
  });

  it('non-terminal states are not terminal', () => {
    for (const s of ['active', 'suspended', 'offboarding', 'sandbox'] as const) {
      expect(isTerminal(s)).toBe(false);
    }
  });

  it('there is no path from offboarded back to any other state', () => {
    for (const target of ALL_STATES) {
      expect(VALID_TRANSITIONS.offboarded).not.toContain(target);
    }
  });

  it('there is no direct active → offboarded edge (must pass through offboarding)', () => {
    expect(VALID_TRANSITIONS.active).not.toContain('offboarded');
  });

  it('there is no suspended → sandbox edge (sandbox only spawned from active)', () => {
    expect(VALID_TRANSITIONS.suspended).not.toContain('sandbox');
  });

  it('every non-terminal state has at least one outgoing edge', () => {
    for (const s of ALL_STATES) {
      if (s === 'offboarded') continue;
      expect(VALID_TRANSITIONS[s].length).toBeGreaterThan(0);
    }
  });

  it('invalid transitions should not be in the table — sanity guard', () => {
    // A few hand-picked bad edges to lock the FSM shape.
    expect(VALID_TRANSITIONS.active).not.toContain('active');
    expect(VALID_TRANSITIONS.sandbox).not.toContain('active');
    expect(VALID_TRANSITIONS.sandbox).not.toContain('suspended');
    expect(VALID_TRANSITIONS.offboarding).not.toContain('active');
  });
});
