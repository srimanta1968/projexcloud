/**
 * Scope derivation.
 *
 * A key's authority is expressed as `<domain>.<resource>.<action>`, and the
 * scope a request requires is DERIVED FROM THE REQUEST rather than declared per
 * route. That choice is load-bearing:
 *
 *   - the alternative is ~68 SDKs x ~40 routes of hand-written scope strings,
 *     which drift the moment somebody adds a route;
 *   - and a route added without its declaration would silently demand nothing,
 *     which is exactly the failure mode a default-deny gate exists to prevent.
 *
 * Derivation means a new route is covered the moment it exists, and the scope
 * it demands is predictable from its own path without consulting a table.
 */

/** `clocks` -> `clock`, `policies` -> `policy`, `addresses` -> `address`. */
export function singularise(segment: string): string {
  if (segment.endsWith('ies')) return `${segment.slice(0, -3)}y`;
  if (segment.endsWith('ses') || segment.endsWith('xes')) return segment.slice(0, -2);
  if (segment.endsWith('s') && !segment.endsWith('ss')) return segment.slice(0, -1);
  return segment;
}

export interface ScopeRequest {
  method: string;
  url: string;
  /** Fastify's DECLARED route pattern, e.g. /api/sla/policies/:policy_id/rungs. */
  routePattern?: string;
}

/**
 * Derives the scope a request requires.
 *
 *   POST  /api/sla/clocks                   -> sla.clock.write
 *   GET   /api/sla/policies                 -> sla.policy.read
 *   POST  /api/sla/policies/:id/rungs       -> sla.policy.write
 *   POST  /api/notifications/send           -> notification.send.write
 *   GET   /api/assignment/workload/:id      -> assignment.workload.read
 *
 * The DECLARED pattern is preferred over the concrete url so the derived scope
 * is stable across requests instead of varying with an id in the path.
 */
export function scopeForRequest(req: ScopeRequest): string | null {
  const declared = req.routePattern ?? req.url.split('?')[0];
  const segments = declared
    .split('/')
    .filter((s) => s.length > 0 && !s.startsWith(':') && !s.startsWith('*'));

  // Everything tenant-callable lives under /api. A path that does not is a
  // health probe, a portal asset or an operator surface — none of which are
  // key-authorised, so there is no scope to derive.
  if (segments[0] !== 'api') return null;
  const rest = segments.slice(1);
  if (rest.length === 0) return null;

  const action = req.method === 'GET' || req.method === 'HEAD' ? 'read' : 'write';
  const domain = singularise(rest[0]);
  // When a route has no segment after its domain (`POST /api/assignment`), the
  // domain doubles as the resource so the scope still has three parts.
  const resource = rest[1] ? singularise(rest[1]) : domain;
  return `${domain}.${resource}.${action}`;
}

/**
 * True when a key's granted scopes satisfy a required one.
 *
 * Wildcards are accepted at the tail (`sla.*`, `sla.clock.*`, `*`) because an
 * operator issuing a key for a whole domain should not have to enumerate every
 * resource that domain will ever have — and if they did, the key would quietly
 * stop working the day a resource is added.
 */
export function scopeSatisfied(granted: string[], required: string): boolean {
  if (granted.includes(required) || granted.includes('*')) return true;
  const parts = required.split('.');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    if (granted.includes(`${parts.slice(0, i).join('.')}.*`)) return true;
  }
  return false;
}
