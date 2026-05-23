import type { DelegationRules } from '../models/approval.model';

/**
 * Resolve OOO / delegation for an approver per FR-APP-4.
 *
 * Walks the route.delegation_rules map. If the original persona has a
 * delegation rule whose [from, to] window covers `now`, returns the
 * delegate. Otherwise returns the original. Defends against delegation
 * cycles by limiting hops to 5.
 *
 * `now` is parameterized so tests can pin the clock.
 */
export function resolveDelegate(
  persona_id: string,
  rules: DelegationRules,
  now: Date = new Date(),
): { resolved: string; chain: string[] } {
  const chain: string[] = [persona_id];
  let current = persona_id;
  for (let i = 0; i < 5; i++) {
    const rule = rules[current];
    if (!rule) break;
    if (!coversNow(rule.from, rule.to, now)) break;
    if (chain.includes(rule.delegate_to)) break; // cycle guard
    chain.push(rule.delegate_to);
    current = rule.delegate_to;
  }
  return { resolved: current, chain };
}

function coversNow(from?: string, to?: string, now: Date = new Date()): boolean {
  const n = now.getTime();
  if (from && new Date(from).getTime() > n) return false;
  if (to && new Date(to).getTime() < n) return false;
  return true;
}
