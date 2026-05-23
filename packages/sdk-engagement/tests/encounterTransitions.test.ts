/**
 * AC-1 / FR-EN-1 unit tests for the encounter state machine.
 *
 * The VALID_TRANSITIONS table is the source of truth — the canonical happy
 * path (open → in-progress → closed → sealed) plus the shortcuts the PRD
 * sanctions (open → closed for "instant" encounters like a one-shot
 * service-request ticket; closed → sealed when retention kicks in).
 */
import { describe, expect, it } from 'vitest';
import { VALID_TRANSITIONS } from '../src/services/engagementService';

const ALL_STATES = ['open', 'in-progress', 'closed', 'sealed'] as const;

describe('Encounter VALID_TRANSITIONS', () => {
  it('every state is enumerated', () => {
    for (const s of ALL_STATES) {
      expect(VALID_TRANSITIONS[s]).toBeDefined();
    }
  });

  it('canonical happy path: open → in-progress → closed → sealed', () => {
    expect(VALID_TRANSITIONS.open).toContain('in-progress');
    expect(VALID_TRANSITIONS['in-progress']).toContain('closed');
    expect(VALID_TRANSITIONS.closed).toContain('sealed');
  });

  it('sealed is terminal', () => {
    expect(VALID_TRANSITIONS.sealed).toEqual([]);
  });

  it('cannot retreat — closed has no path back to in-progress', () => {
    expect(VALID_TRANSITIONS.closed).not.toContain('in-progress');
    expect(VALID_TRANSITIONS.closed).not.toContain('open');
  });

  it('open can shortcut to closed (instant encounter like a one-shot SR ticket)', () => {
    expect(VALID_TRANSITIONS.open).toContain('closed');
  });

  it('open can shortcut to sealed (compliance hot-path: immediate retention)', () => {
    // The state machine allows this because sealing also closes; the seal
    // path triggers vault.shredKey, which is the doctrinally-important
    // side effect — guarding against "forgot to close, sealed anyway".
    expect(VALID_TRANSITIONS.open).toContain('sealed');
  });

  it('every non-terminal state can advance to sealed (every encounter is sealable)', () => {
    expect(VALID_TRANSITIONS.open).toContain('sealed');
    expect(VALID_TRANSITIONS['in-progress']).toContain('sealed');
    expect(VALID_TRANSITIONS.closed).toContain('sealed');
  });
});
