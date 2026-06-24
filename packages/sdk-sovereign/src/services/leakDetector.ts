import { ingestLeakAlert } from './regionService';
import type { LeakAlertKind, LeakAlertSeverity } from '@projexlight/contracts';

/**
 * Leak detector pluggable interface (Y-P8-6 / FR-SOV-2).
 *
 * Sovereign regions require continuous DPI + network-policy monitoring;
 * any egress attempt, cross-region route, or policy violation must fire
 * a sovereign.leak_monitor_alert row immediately.
 *
 * This module provides the detector contract. Production wires a Cilium /
 * Falco / Istio subscriber that translates real network events into
 * AlertCandidate objects and passes them to recordCandidate(). The
 * SyntheticLeakDetector lets dev/CI exercise the alert ingest path
 * without any cluster integration.
 */

export interface AlertCandidate {
  region_id: string;
  kind: LeakAlertKind;
  severity: LeakAlertSeverity;
  incident_ref?: string | null;
  /** Free-form diagnostic context — captured in the audit chain. */
  context?: Record<string, unknown>;
}

export interface LeakDetector {
  readonly name: string;
  /** Returns true when the detector has a live subscription (Cilium / Falco / synthetic). */
  active(): boolean;
  /** Called by the host to wire the detector and start emitting candidates. */
  start(emit: (c: AlertCandidate) => Promise<void> | void): Promise<void> | void;
  /** Stop subscriptions. Idempotent. */
  stop(): Promise<void> | void;
}

let _detector: LeakDetector | null = null;

export function setLeakDetector(detector: LeakDetector | null): void {
  _detector = detector;
}

export function getLeakDetector(): LeakDetector | null {
  return _detector;
}

/**
 * recordCandidate — the canonical sink the detector calls. Ingests the
 * alert into sovereign.leak_monitor_alert via regionService.ingestLeakAlert,
 * which also fires the regulated sovereign.leak.alert.v1 event.
 */
export async function recordCandidate(c: AlertCandidate): Promise<void> {
  try {
    await ingestLeakAlert({
      region_id: c.region_id,
      kind: c.kind,
      severity: c.severity,
      incident_ref: c.incident_ref ?? null,
    });
  } catch (err) {
    // A failed alert write must never crash the detector loop (and with it the
    // gateway). The most common dev cause is the region not being provisioned in
    // sovereign.region_config (FK violation) — the synthetic detector fires for a
    // default region that may not exist. Log and continue; real regions always
    // have a region_config row written on first boot.
    console.warn(
      `[leak-detector] dropped alert for region '${c.region_id}' (${c.kind}/${c.severity}): ${
        (err as Error).message
      }`,
    );
  }
}

/**
 * Start whichever detector is installed. Call from api-gateway boot.
 * No-op when no detector is registered (cloud deploy without sovereign).
 */
export async function startLeakDetector(): Promise<void> {
  if (!_detector) {
    console.log('[sovereign:leak-detector] no detector registered; skipping');
    return;
  }
  await _detector.start(recordCandidate);
  console.log(`[sovereign:leak-detector] ${_detector.name} active`);
}

export async function stopLeakDetector(): Promise<void> {
  if (_detector) await _detector.stop();
}

/**
 * SyntheticLeakDetector — periodic dummy alerts for dev/CI. Refuses to
 * run in production unless ALLOW_SYNTHETIC_LEAK_DETECTOR=true (matches
 * the synthetic-adapter pattern used elsewhere in the platform).
 */
export class SyntheticLeakDetector implements LeakDetector {
  readonly name = 'synthetic';
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly regionId: string;
  private readonly intervalMs: number;

  constructor(opts: { region_id?: string; intervalMs?: number } = {}) {
    this.regionId = opts.region_id ?? process.env.SOVEREIGN_REGION_ID ?? 'us-gov-east-1';
    this.intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
  }

  active(): boolean {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SYNTHETIC_LEAK_DETECTOR !== 'true') {
      return false;
    }
    return true;
  }

  start(emit: (c: AlertCandidate) => Promise<void> | void): void {
    if (!this.active()) return;
    this.timer = setInterval(() => {
      if (this.stopped) return;
      void emit({
        region_id: this.regionId,
        kind: 'policy-violation',
        severity: 'info',
        incident_ref: `synthetic-${Date.now()}`,
        context: { synthetic: true },
      });
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}
