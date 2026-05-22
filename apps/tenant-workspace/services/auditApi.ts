import { apiPost } from '../lib/apiClient';

export interface AuditAppendRequest {
  event_type: string;
  payload: unknown;
}

export interface AuditEntry {
  id: string;
  seq: number;
  entry_hash: string;
  prev_hash: string | null;
  created_at: string;
}

/**
 * POST /api/audit/append — adds a hash-chained entry. Requires the caller to
 * already have a JWT (set by registerUser).
 */
export async function appendAuditEntry(req: AuditAppendRequest): Promise<AuditEntry> {
  return apiPost<AuditEntry>('/api/audit/append', req);
}
