/**
 * Unit tests for the ticket state machine + per-priority SLA defaults.
 * The PRD's escalation flow + Zendesk/Jira bidirectional sync depends on
 * these transitions being deterministic.
 */
import { describe, expect, it } from 'vitest';
import { SLA_DEFAULTS_MS, type TicketPriority } from '../src/models/ticket.model';
import { VALID_TRANSITIONS } from '../src/services/srService';

const ALL_STATUSES = ['new', 'in-progress', 'awaiting-customer', 'resolved', 'closed'] as const;

describe('Ticket VALID_TRANSITIONS', () => {
  it('every status is enumerated', () => {
    for (const s of ALL_STATUSES) {
      expect(VALID_TRANSITIONS[s]).toBeDefined();
    }
  });

  it('canonical happy path: new → in-progress → resolved → closed', () => {
    expect(VALID_TRANSITIONS.new).toContain('in-progress');
    expect(VALID_TRANSITIONS['in-progress']).toContain('resolved');
    expect(VALID_TRANSITIONS.resolved).toContain('closed');
  });

  it('awaiting-customer is bidirectional with in-progress (customer responds → reopen)', () => {
    expect(VALID_TRANSITIONS['in-progress']).toContain('awaiting-customer');
    expect(VALID_TRANSITIONS['awaiting-customer']).toContain('in-progress');
  });

  it('closed is terminal', () => {
    expect(VALID_TRANSITIONS.closed).toEqual([]);
  });

  it('cannot skip resolution — new cannot go directly to resolved', () => {
    expect(VALID_TRANSITIONS.new).not.toContain('resolved');
  });

  it('cannot retreat from resolved back to in-progress without reopening', () => {
    expect(VALID_TRANSITIONS.resolved).not.toContain('in-progress');
    expect(VALID_TRANSITIONS.resolved).not.toContain('awaiting-customer');
  });

  it('new tickets can be closed without resolution (junk / duplicate)', () => {
    expect(VALID_TRANSITIONS.new).toContain('closed');
  });
});

describe('SLA_DEFAULTS_MS — per-priority deadlines', () => {
  it('every priority has both first_response and resolution deadlines', () => {
    const priorities: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];
    for (const p of priorities) {
      expect(SLA_DEFAULTS_MS[p].first_response).toBeGreaterThan(0);
      expect(SLA_DEFAULTS_MS[p].resolution).toBeGreaterThan(0);
    }
  });

  it('higher priority means tighter SLA — urgent < high < normal < low', () => {
    expect(SLA_DEFAULTS_MS.urgent.first_response).toBeLessThan(SLA_DEFAULTS_MS.high.first_response);
    expect(SLA_DEFAULTS_MS.high.first_response).toBeLessThan(SLA_DEFAULTS_MS.normal.first_response);
    expect(SLA_DEFAULTS_MS.normal.first_response).toBeLessThan(SLA_DEFAULTS_MS.low.first_response);

    expect(SLA_DEFAULTS_MS.urgent.resolution).toBeLessThan(SLA_DEFAULTS_MS.high.resolution);
    expect(SLA_DEFAULTS_MS.high.resolution).toBeLessThan(SLA_DEFAULTS_MS.normal.resolution);
    expect(SLA_DEFAULTS_MS.normal.resolution).toBeLessThan(SLA_DEFAULTS_MS.low.resolution);
  });

  it('first_response is always shorter than resolution (you respond before you resolve)', () => {
    for (const p of ['low', 'normal', 'high', 'urgent'] as TicketPriority[]) {
      expect(SLA_DEFAULTS_MS[p].first_response).toBeLessThanOrEqual(SLA_DEFAULTS_MS[p].resolution);
    }
  });

  it('urgent first-response is sub-hour (15 minutes per the constant)', () => {
    expect(SLA_DEFAULTS_MS.urgent.first_response).toBe(15 * 60_000);
  });

  it('low resolution is multi-day (7 days per the constant)', () => {
    expect(SLA_DEFAULTS_MS.low.resolution).toBe(7 * 86_400_000);
  });
});
