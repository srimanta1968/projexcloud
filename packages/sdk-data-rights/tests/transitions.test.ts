/**
 * FR-DR-3 / FR-DR-9 unit tests for the DSAR state machine.
 *
 * The TRANSITIONS table is the source of truth — every valid transition
 * graph edge must be in the test below; every absent edge must reject.
 * AC-9 ("DSAR end-to-end") relies on the linear path; this test pins it.
 */
import { describe, expect, it } from 'vitest';
import { TRANSITIONS } from '../src/services/dataRightsService';

const ALL_STATUSES = [
  'submitted',
  'identity-verified',
  'approval-pending',
  'grace-period',
  'executing',
  'certificate-issued',
  'audited',
  'rejected',
] as const;

describe('DSAR TRANSITIONS table', () => {
  it('every status is enumerated', () => {
    for (const s of ALL_STATUSES) {
      expect(TRANSITIONS[s]).toBeDefined();
    }
  });

  it('canonical happy path: submitted → identity-verified → approval-pending → grace-period → executing → certificate-issued → audited', () => {
    expect(TRANSITIONS.submitted).toContain('identity-verified');
    expect(TRANSITIONS['identity-verified']).toContain('approval-pending');
    expect(TRANSITIONS['approval-pending']).toContain('grace-period');
    expect(TRANSITIONS['grace-period']).toContain('executing');
    expect(TRANSITIONS.executing).toContain('certificate-issued');
    expect(TRANSITIONS['certificate-issued']).toContain('audited');
  });

  it('terminal states have no outbound edges', () => {
    expect(TRANSITIONS.audited).toEqual([]);
    expect(TRANSITIONS.rejected).toEqual([]);
  });

  it('every pre-grace state can also be rejected', () => {
    expect(TRANSITIONS.submitted).toContain('rejected');
    expect(TRANSITIONS['identity-verified']).toContain('rejected');
    expect(TRANSITIONS['approval-pending']).toContain('rejected');
  });

  it('cannot skip approval — grace-period not reachable from identity-verified directly', () => {
    expect(TRANSITIONS['identity-verified']).not.toContain('grace-period');
  });

  it('cannot retreat — certificate-issued has no path back to executing', () => {
    expect(TRANSITIONS['certificate-issued']).not.toContain('executing');
  });

  it('grace-period has only the executing edge (no rejection after grace expires)', () => {
    // Once grace begins, the request executes; a tenant who wants to cancel
    // must do so before grace. The PRD §5.4 workflow is deliberate here.
    expect(TRANSITIONS['grace-period']).toEqual(['executing']);
  });
});
