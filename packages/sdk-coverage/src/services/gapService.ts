import { findRosterGaps, type RosterGap } from './onCallService';

/**
 * Coverage gaps, found BEFORE they open.
 *
 * The tense is the whole feature. A gap discovered while an incident is
 * escalating is not a warning, it is an outage — the page has already gone
 * nowhere. So this exists to be run ahead of the window, and every gap it
 * reports carries how long until it starts, which is the number that decides
 * whether somebody has time to fix the rota or needs to be woken up.
 */

export interface CoverageGap extends RosterGap {
  rotation_ref: string;
  tier: number;
  /** Negative once the gap has already opened — stated, not hidden. */
  minutes_until_start: number;
  /** True when the gap is open right now. */
  in_progress: boolean;
  /** True when it opens inside the alert lead time and has not been alerted yet. */
  imminent: boolean;
}

export interface DetectGapsInput {
  tenant_id: string;
  rotation_ref: string;
  from: Date;
  to: Date;
  tier?: number;
  /** How far ahead a gap counts as imminent. Defaults to 24h. */
  lead_minutes?: number;
  now?: Date;
}

export class GapWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GapWindowError';
  }
}

export async function detectGaps(input: DetectGapsInput): Promise<CoverageGap[]> {
  if (!(input.to > input.from)) {
    throw new GapWindowError('to must be after from');
  }
  const now = input.now ?? new Date();
  const tier = input.tier ?? 1;
  const lead = input.lead_minutes ?? 24 * 60;

  const gaps = await findRosterGaps({
    tenant_id: input.tenant_id,
    rotation_ref: input.rotation_ref,
    from: input.from,
    to: input.to,
    tier,
  });

  return gaps.map((gap) => {
    const startsMs = new Date(gap.starts_at).getTime();
    const endsMs = new Date(gap.ends_at).getTime();
    const minutes_until_start = Math.round((startsMs - now.getTime()) / 60_000);
    return {
      ...gap,
      rotation_ref: input.rotation_ref,
      tier,
      minutes_until_start,
      in_progress: startsMs <= now.getTime() && endsMs > now.getTime(),
      imminent: minutes_until_start > 0 && minutes_until_start <= lead,
    };
  });
}

/* --------------------------------------------------------- alerting */

export interface GapAlert {
  tenant_id: string;
  rotation_ref: string;
  tier: number;
  gap: CoverageGap;
}

export type GapNotifier = (alert: GapAlert) => Promise<void> | void;

let notifier: GapNotifier | null = null;

/**
 * Wire gap alerting — the gateway bridges this to sdk-notification.
 *
 * NO DEFAULT, deliberately. A no-op default would make `scanAndAlert` report
 * that it had alerted on a gap nobody was told about, which is worse than not
 * running the scan at all: the dashboard would be green precisely when the rota
 * has a hole. With no notifier the scan still RETURNS the gaps and says it
 * alerted on none, so the omission is visible in its own result.
 */
export function setGapNotifier(fn: GapNotifier | null): void {
  notifier = fn;
}

export function hasGapNotifier(): boolean {
  return notifier !== null;
}

export interface ScanResult {
  scanned_rotations: number;
  gaps: CoverageGap[];
  /** Gaps an alert was actually delivered for. */
  alerted: CoverageGap[];
  /** True when gaps were found but no notifier is wired — the caller must not read alerted=[] as "all clear". */
  alerting_unavailable: boolean;
}

export interface ScanAndAlertInput {
  tenant_id: string;
  rotation_refs: string[];
  from: Date;
  to: Date;
  tier?: number;
  lead_minutes?: number;
  now?: Date;
}

/**
 * Scans rotations for gaps and alerts on the imminent ones.
 *
 * Only IMMINENT gaps alert. A rota with a hole three weeks out is a planning
 * item, and paging somebody about it at 3am teaches them to mute the channel —
 * after which the gap that opens in an hour goes unread too. Gaps already in
 * progress are returned but not alerted here: by then the escalation ladder is
 * already failing loudly, and a second alert adds noise to an incident rather
 * than information.
 */
export async function scanAndAlert(input: ScanAndAlertInput): Promise<ScanResult> {
  const all: CoverageGap[] = [];
  for (const rotation_ref of input.rotation_refs) {
    const gaps = await detectGaps({
      tenant_id: input.tenant_id,
      rotation_ref,
      from: input.from,
      to: input.to,
      tier: input.tier,
      lead_minutes: input.lead_minutes,
      now: input.now,
    });
    all.push(...gaps);
  }

  const imminent = all.filter((g) => g.imminent);
  const alerted: CoverageGap[] = [];

  if (notifier) {
    for (const gap of imminent) {
      try {
        await notifier({ tenant_id: input.tenant_id, rotation_ref: gap.rotation_ref, tier: gap.tier, gap });
        alerted.push(gap);
      } catch {
        // A failed delivery must not stop the remaining alerts, and must not be
        // counted as delivered — the gap stays in `gaps` and out of `alerted`,
        // so the difference between the two is the honest failure signal.
      }
    }
  }

  return {
    scanned_rotations: input.rotation_refs.length,
    gaps: all,
    alerted,
    alerting_unavailable: imminent.length > 0 && !notifier,
  };
}
