import type { ApiKeyRecord } from '../models/apiKey.model';

/**
 * Per-application usage attribution.
 *
 * WHY THIS SHIPS WITH THE PER-APP MODEL RATHER THAN LATER
 * -------------------------------------------------------
 * "One key per application" is only worth the extra object if something
 * downstream can tell the applications apart. Attribution is the practical
 * argument for the whole design: without it a tenant sees one usage figure and
 * cannot answer which integration produced the spike, which is the question
 * that actually gets asked. So the emission lands in the same epic as the
 * model, not in a follow-up nobody schedules.
 *
 * The `app_id` dimension carries the application_id; a system credential
 * (sdk-command robot keys) has none and meters at tenant level, which is
 * honest rather than bucketed under a fabricated application.
 *
 * sdk-meter is reached through an injected reporter rather than a direct
 * import. sdk-api-keys sits on the authentication path of every machine call,
 * and giving it a hard dependency on the metering stack would put metering's
 * failure modes on that path. The gateway wires the real reporter at boot; the
 * default is an honest no-op.
 */

export interface KeyUsageEvent {
  tenant_id: string;
  application_id: string | null;
  key_id: string;
  route: string;
  method: string;
  status_code: number;
}

export type UsageReporter = (event: KeyUsageEvent) => void | Promise<void>;

let reporter: UsageReporter | null = null;

/** Wired at gateway boot to sdk-meter's `report`. */
export function setUsageReporter(fn: UsageReporter | null): void {
  reporter = fn;
}

/**
 * Records one authenticated request.
 *
 * Fire-and-forget by construction: the request being described has already
 * been authorised, and losing a usage tick must never turn into a failed call
 * or added latency for the caller. Errors are swallowed at this boundary
 * precisely so a metering outage cannot become an API outage.
 */
export function meterKeyUsage(
  key: ApiKeyRecord,
  method: string,
  route: string,
  status_code: number,
): void {
  if (!reporter) return;
  try {
    const result = reporter({
      tenant_id: key.tenant_id,
      application_id: key.application_id,
      key_id: key.key_id,
      route,
      method,
      status_code,
    });
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => {
        /* metering must never surface to the caller */
      });
    }
  } catch {
    /* nor may a synchronous throw in the reporter */
  }
}
