/**
 * P10/E8 — security detection rules over the audit/trace streams + SIEM/XDR
 * routing, plus MDM and consent observability metric helpers.
 *
 * Detection rules match audit events (auth failures, privilege change,
 * suspicious access) and route matches to SIEM/XDR via the existing vault SIEM
 * forwarder (wired by the gateway). Metric helpers populate the Prometheus
 * registry for the MDM + consent taxonomies.
 */

import { registry } from './prometheus';

/** Minimal audit-event shape the detection rules reason over. */
export interface AuditEventLike {
  event_type: string;
  actor_kind?: string;
  actor_id?: string;
  tenant_id?: string | null;
  subject_kind?: string;
  subject_id?: string;
  payload?: Record<string, unknown>;
}

export type DetectionSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface DetectionRule {
  id: string;
  description: string;
  severity: DetectionSeverity;
  match: (event: AuditEventLike) => boolean;
}

export interface Detection {
  rule_id: string;
  severity: DetectionSeverity;
  event: AuditEventLike;
}

/** Default detection rules over audit/trace streams. */
export const DEFAULT_DETECTION_RULES: DetectionRule[] = [
  {
    id: 'auth_failure',
    description: 'Authentication failure or invalid/expired principal token',
    severity: 'medium',
    match: (e) =>
      /auth.*fail|login.*fail|invalid.*token|token.*invalid/i.test(e.event_type) ||
      e.event_type === 'security.principal_token.verification_failed.v1',
  },
  {
    id: 'privilege_change',
    description: 'Privilege / role / membership change',
    severity: 'high',
    match: (e) => /role.*assigned|role.*revoked|membership|policy\.updated|impersonation/i.test(e.event_type),
  },
  {
    id: 'break_glass_used',
    description: 'Emergency break-glass access exercised',
    severity: 'critical',
    match: (e) => e.event_type === 'security.break_glass.used.v1',
  },
  {
    id: 'consent_denied',
    description: 'Access denied for missing/revoked consent (possible probing)',
    severity: 'medium',
    match: (e) => e.event_type === 'policy.evaluated.v1' && e.payload?.consent_satisfied === false,
  },
  {
    id: 'fail_closed',
    description: 'Policy evaluator degraded — fail-closed denial',
    severity: 'high',
    match: (e) => e.event_type === 'policy.evaluated.v1' && e.payload?.degraded === true,
  },
];

const detectionCounter = registry.counter(
  'security_detections_total',
  'Count of security detections by rule + severity',
  'security',
);

export type SiemForwarder = (event: Record<string, unknown>) => void | Promise<void>;

/**
 * Evaluates an audit event against the rules; for each match increments the
 * detection counter and (best-effort) routes a normalized alert to SIEM/XDR via
 * the supplied forwarder (the gateway passes sdk-vault's forwarder).
 */
export async function runDetections(
  event: AuditEventLike,
  forwarder?: SiemForwarder | null,
  rules: DetectionRule[] = DEFAULT_DETECTION_RULES,
): Promise<Detection[]> {
  const hits: Detection[] = [];
  for (const rule of rules) {
    let matched = false;
    try {
      matched = rule.match(event);
    } catch {
      matched = false;
    }
    if (!matched) continue;
    hits.push({ rule_id: rule.id, severity: rule.severity, event });
    detectionCounter.inc({ rule: rule.id, severity: rule.severity });
    if (forwarder) {
      try {
        await forwarder({
          kind: 'security_detection',
          rule_id: rule.id,
          severity: rule.severity,
          event_type: event.event_type,
          actor_id: event.actor_id ?? null,
          tenant_id: event.tenant_id ?? null,
          subject_id: event.subject_id ?? null,
        });
      } catch {
        // SIEM delivery is best-effort; never block the audit path
      }
    }
  }
  return hits;
}

/* ── MDM + consent observability metrics (taxonomy: mdm / consent) ────────── */

export interface MdmMetricsInput {
  unresolved_candidate_links: number;
  merge_reversals: number;
  total_merges: number;
  calibration_ece: number;
  confidence_distribution?: { band: string; count: number }[];
}

const mdmUnresolved = registry.gauge('mdm_unresolved_candidate_links', 'Open EMPI candidate links', 'mdm');
const mdmReversals = registry.gauge('mdm_merge_reversals_total', 'EMPI merge reversals', 'mdm');
const mdmMerges = registry.gauge('mdm_merges_total', 'EMPI merges', 'mdm');
const mdmEce = registry.gauge('mdm_calibration_ece', 'EMPI match calibration (ECE)', 'mdm');
const mdmConfidence = registry.gauge('mdm_candidate_links_by_band', 'EMPI candidate links by confidence band', 'mdm');

/** Publishes EMPI metrics (from getEmpiMetrics()) into the Prometheus registry. */
export function recordMdmMetrics(m: MdmMetricsInput): void {
  mdmUnresolved.set({}, m.unresolved_candidate_links);
  mdmReversals.set({}, m.merge_reversals);
  mdmMerges.set({}, m.total_merges);
  mdmEce.set({}, m.calibration_ece);
  for (const d of m.confidence_distribution ?? []) mdmConfidence.set({ band: d.band }, d.count);
}

const consentChecks = registry.counter('consent_checks_total', 'Consent decisions by purpose + outcome', 'consent');

/** Records a consent decision metric (consent checked, purpose, granted). */
export function recordConsentCheck(purpose: string, granted: boolean, receiptId?: string | null): void {
  consentChecks.inc({ purpose: purpose || 'unspecified', granted: String(granted), has_receipt: String(Boolean(receiptId)) });
}
