/**
 * sdk-incident domain model (P15·E3). Mirrors incident.incident (migration 001)
 * — the DB CHECK constraints are authoritative, so status is
 * open/investigating/mitigated/resolved/closed/cancelled (the prose "verified"
 * step is captured by the `verification` notes column culminating in 'closed').
 */

export type IncidentStatus =
  | 'open'
  | 'investigating'
  | 'mitigated'
  | 'resolved'
  | 'closed'
  | 'cancelled';

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Allowed status transitions. An incident may be cancelled from any pre-resolved
 * state; resolved may re-open to investigating (regression) or advance to closed.
 * Terminal states (closed/cancelled) map to an empty array.
 */
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  open: ['investigating', 'mitigated', 'cancelled'],
  investigating: ['mitigated', 'resolved', 'cancelled'],
  mitigated: ['resolved', 'investigating', 'cancelled'],
  resolved: ['closed', 'investigating'],
  closed: [],
  cancelled: [],
};

export function isValidTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return INCIDENT_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Target status -> the timestamp column stamped on entry (null = none). */
export const INCIDENT_TRANSITION_TIMESTAMP: Record<IncidentStatus, string | null> = {
  open: null,
  investigating: null,
  mitigated: null,
  resolved: 'resolved_at',
  closed: 'closed_at',
  cancelled: 'closed_at',
};

export interface IncidentRecord {
  incident_id: string;
  tenant_id: string;
  incident_type: string;
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  status: IncidentStatus;
  affected_records: unknown[];
  root_cause: string | null;
  recovery: string | null;
  verification: string | null;
  owner_persona_id: string | null;
  reported_by_persona_id: string | null;
  source: string | null;
  subject_ref: string | null;
  sla_due_at: string | null;
  metadata: Record<string, unknown>;
  opened_at: string;
  detected_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateIncidentInput {
  tenant_id: string;
  incident_type: string;
  title: string;
  description?: string | null;
  severity?: IncidentSeverity;
  affected_records?: unknown[];
  owner_persona_id?: string | null;
  reported_by_persona_id?: string | null;
  source?: string | null;
  subject_ref?: string | null;
  sla_due_at?: string | null;
  detected_at?: string | null;
  metadata?: Record<string, unknown>;
}

/** Fields editable via updateIncident (excludes status — use transitionIncident). */
export interface UpdateIncidentInput {
  title?: string;
  description?: string | null;
  severity?: IncidentSeverity;
  affected_records?: unknown[];
  root_cause?: string | null;
  recovery?: string | null;
  verification?: string | null;
  owner_persona_id?: string | null;
  subject_ref?: string | null;
  sla_due_at?: string | null;
  metadata?: Record<string, unknown>;
}
