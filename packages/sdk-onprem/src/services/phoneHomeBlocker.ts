import http from 'http';
import https from 'https';
import { URL } from 'url';

/**
 * Phone-home outbound blocker for strict air-gap installs (Y-P8-9 / FR-ONP-8).
 *
 * Monkey-patches http(s).request to refuse connections to non-in-cluster
 * hostnames whenever the install runs in `air_gap_mode=strict`. The
 * blocker is opt-in via installPhoneHomeBlocker() and OFF by default so
 * cloud deploys are unaffected. Once installed, it cannot be uninstalled
 * (operator-friendly: any reload restores defaults; production avoids
 * mid-run state surprises).
 *
 * Allow rules — host matches if ANY of:
 *   - ends with `.svc.cluster.local`
 *   - ends with `.svc`
 *   - bare hostname with no dots (assumed in-cluster service)
 *   - localhost / 127.0.0.1
 *   - private RFC1918 ranges (10/8, 172.16-31/12, 192.168/16)
 *   - one of the explicit `extraAllowList` hostnames
 *
 * Anything else → throws PhoneHomeBlockedError before the socket opens.
 * Calling code sees a synchronous error from request() construction; the
 * stack trace pinpoints the offending caller for triage.
 */

export class PhoneHomeBlockedError extends Error {
  readonly code = 'phone_home_blocked';
  constructor(public readonly host: string) {
    super(`phone-home blocked: ${host} is not in-cluster (FR-ONP-8 strict air-gap)`);
    this.name = 'PhoneHomeBlockedError';
  }
}

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /\.svc\.cluster\.local$/i,
  /\.svc$/i,
];

function isInCluster(host: string, extra: string[]): boolean {
  if (!host) return false;
  if (extra.includes(host)) return true;
  if (!host.includes('.') && !host.includes(':')) return true; // bare service name
  for (const p of PRIVATE_HOST_PATTERNS) {
    if (p.test(host)) return true;
  }
  return false;
}

function hostFromOptions(opts: unknown, urlArg?: unknown): string {
  // request() accepts string | URL | RequestOptions and a second URL+opts overload.
  // Cover the three common shapes.
  if (typeof urlArg === 'string') return new URL(urlArg).hostname;
  if (urlArg instanceof URL) return urlArg.hostname;
  if (typeof opts === 'string') return new URL(opts).hostname;
  if (opts instanceof URL) return opts.hostname;
  if (opts && typeof opts === 'object') {
    const o = opts as { hostname?: string; host?: string };
    return (o.hostname ?? o.host ?? '').split(':')[0];
  }
  return '';
}

let _installed = false;

export interface PhoneHomeBlockerConfig {
  /** Hostnames to add to the in-cluster allow list (e.g. the SIEM endpoint). */
  extraAllowList?: string[];
}

export function installPhoneHomeBlocker(cfg: PhoneHomeBlockerConfig = {}): void {
  if (_installed) return;
  _installed = true;
  const extra = cfg.extraAllowList ?? [];

  const wrap = <T extends { request: Function }>(mod: T, kind: 'http' | 'https'): void => {
    const original = mod.request.bind(mod);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mod as any).request = function patched(...args: unknown[]): unknown {
      const host = hostFromOptions(args[0], args[1]);
      if (host && !isInCluster(host, extra)) {
        throw new PhoneHomeBlockedError(host);
      }
      return original(...(args as Parameters<typeof original>));
    };
    console.log(`[onprem:phone-home-blocker] ${kind}.request patched`);
  };

  wrap(http, 'http');
  wrap(https, 'https');
}

/** Test-only — checks whether the blocker has been installed. */
export function _isPhoneHomeBlockerInstalled(): boolean {
  return _installed;
}
