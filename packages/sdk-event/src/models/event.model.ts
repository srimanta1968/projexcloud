export type SessionStatus = 'scheduled' | 'live' | 'completed' | 'cancelled';
export type TicketStatus = 'issued' | 'used' | 'refunded' | 'void';

export interface SessionRecord {
  session_id: string;
  tenant_id: string;
  encounter_id: string;
  title: string;
  address_id: string | null;
  capacity: number;
  sold_count: number;
  starts_at: Date;
  ends_at: Date;
  status: SessionStatus;
  created_at: Date;
}

export interface TicketRecord {
  ticket_id: string;
  session_id: string;
  holder_persona_id: string;
  price: number | null;
  status: TicketStatus;
  qr_token: string;
  created_at: Date;
}

export interface CheckinRecord {
  checkin_id: string;
  ticket_id: string;
  device_uuid: string | null;
  checked_in_at: Date;
  checked_in_by_persona_id: string;
}

export interface CreateSessionInput {
  tenant_id: string;
  encounter_id: string;
  title: string;
  address_id?: string;
  capacity: number;
  starts_at: string;
  ends_at: string;
}

export interface IssueTicketInput {
  session_id: string;
  holder_persona_id: string;
  price?: number;
}

export interface CheckinInput {
  qr_token: string;
  device_uuid?: string;
  checked_in_by_persona_id: string;
}
