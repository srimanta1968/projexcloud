export interface AuditAppendRequest {
  event_type: string;
  payload: unknown;
  tenant_id?: string;
  actor?: string;
}

export interface AuditAppendResponse {
  id: string;
  seq: number;
  entry_hash: string;
  prev_hash: string | null;
  created_at: string;
}
