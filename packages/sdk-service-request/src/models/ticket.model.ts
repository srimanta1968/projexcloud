export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TicketSeverity = 'trivial' | 'minor' | 'major' | 'critical';
export type TicketStatus = 'new' | 'in-progress' | 'awaiting-customer' | 'resolved' | 'closed';

export interface TicketRecord {
  ticket_id: string;
  tenant_id: string;
  encounter_id: string;
  requester_persona_id: string;
  assignee_persona_id: string | null;
  queue_id: string | null;
  priority: TicketPriority;
  severity: TicketSeverity;
  status: TicketStatus;
  sla_first_response_at: Date | null;
  sla_resolution_at: Date | null;
  first_responded_at: Date | null;
  resolved_at: Date | null;
  external_refs: Record<string, string>;
  created_at: Date;
  updated_at: Date;
}

export interface QueueRecord {
  queue_id: string;
  tenant_id: string;
  name: string;
  priority: number;
  created_at: Date;
}

export interface CreateTicketInput {
  tenant_id: string;
  requester_persona_id: string;
  queue_id?: string;
  priority?: TicketPriority;
  severity?: TicketSeverity;
  /** Optional pre-existing encounter; if absent the caller must create one via sdk-engagement first. */
  encounter_id: string;
  external_refs?: Record<string, string>;
}

/** SLA defaults per priority (ms). Tenants override via routing rule predicates. */
export const SLA_DEFAULTS_MS: Record<TicketPriority, { first_response: number; resolution: number }> = {
  low:    { first_response: 24 * 3600_000, resolution: 7 * 86400_000 },
  normal: { first_response: 8 * 3600_000,  resolution: 3 * 86400_000 },
  high:   { first_response: 1 * 3600_000,  resolution: 86400_000 },
  urgent: { first_response: 15 * 60_000,   resolution: 4 * 3600_000 },
};
