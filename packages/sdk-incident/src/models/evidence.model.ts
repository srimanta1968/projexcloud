/**
 * sdk-incident evidence-timeline model (P15·E3, TK-3651). Mirrors
 * incident.evidence (migration 002) — the DB CHECK constraint is authoritative.
 *
 * The timeline captures the SOP narrative of an incident: when it was detected,
 * what the root cause was, how it was recovered, and how the fix was verified.
 * 'note' carries any other timeline entry that is not one of those four beats.
 */

export type EvidenceKind =
  | 'detected'
  | 'root_cause'
  | 'recovery'
  | 'verification'
  | 'note';

export const EVIDENCE_KINDS: EvidenceKind[] = [
  'detected',
  'root_cause',
  'recovery',
  'verification',
  'note',
];

/**
 * Evidence kind -> the incident column it summarises. Appending evidence of one
 * of these kinds also projects its body onto the incident record so the summary
 * fields stay in step with the timeline. 'detected'/'note' have no column
 * (detected stamps detected_at instead).
 */
export const EVIDENCE_SUMMARY_COLUMN: Record<EvidenceKind, string | null> = {
  detected: null,
  root_cause: 'root_cause',
  recovery: 'recovery',
  verification: 'verification',
  note: null,
};

export interface EvidenceRecord {
  evidence_id: string;
  tenant_id: string;
  incident_id: string;
  kind: EvidenceKind;
  body: string;
  evidence_ref: string | null;
  recorded_by_persona_id: string | null;
  occurred_at: string;
  /** sdk-audit ledger entry id — the immutability receipt for this entry. */
  audit_entry_id: string | null;
  audit_seq: string | null;
  audit_entry_hash: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AppendEvidenceInput {
  tenant_id: string;
  incident_id: string;
  kind: EvidenceKind;
  body: string;
  evidence_ref?: string | null;
  recorded_by_persona_id?: string | null;
  occurred_at?: string | null;
  metadata?: Record<string, unknown>;
}
