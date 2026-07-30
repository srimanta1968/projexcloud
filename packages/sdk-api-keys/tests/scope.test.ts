import { describe, expect, it } from 'vitest';
import { scopeForRequest, scopeSatisfied, singularise } from '../src/middleware/scope';

/**
 * Scope derivation is the only thing standing between a key and every route on
 * the platform, and it is derived rather than declared — so its edge cases are
 * the ones that decide whether a credential is over- or under-privileged.
 */

describe('singularise', () => {
  it('handles the plurals this platform actually uses', () => {
    expect(singularise('clocks')).toBe('clock');
    expect(singularise('policies')).toBe('policy');
    expect(singularise('addresses')).toBe('address');
    expect(singularise('boxes')).toBe('box');
    expect(singularise('sms-settings')).toBe('sms-setting');
  });

  it('leaves a word that only looks plural alone', () => {
    // 'access' and 'status' end in s but are not plurals; stripping the s would
    // derive a scope nobody grants, and every request would 403.
    expect(singularise('access')).toBe('access');
    expect(singularise('send')).toBe('send');
  });
});

describe('scopeForRequest', () => {
  const cases: Array<[string, string, string]> = [
    ['POST', '/api/sla/clocks', 'sla.clock.write'],
    ['GET', '/api/sla/policies', 'sla.policy.read'],
    ['POST', '/api/sla/policies/:policy_id/rungs', 'sla.policy.write'],
    ['POST', '/api/sla/breach-scan', 'sla.breach-scan.write'],
    ['POST', '/api/assignment/assign-by-task', 'assignment.assign-by-task.write'],
    ['GET', '/api/assignment/workload/:persona_id', 'assignment.workload.read'],
    ['POST', '/api/notifications/send', 'notification.send.write'],
    ['GET', '/api/applications/:application_id', 'application.application.read'],
  ];

  it.each(cases)('%s %s -> %s', (method, routePattern, expected) => {
    expect(scopeForRequest({ method, url: routePattern, routePattern })).toBe(expected);
  });

  it('is stable across concrete ids, because it reads the DECLARED pattern', () => {
    const declared = scopeForRequest({
      method: 'POST',
      url: '/api/sla/policies/8f14e45f-ceea-467a-9f4b-9c6f3b6f0a11/rungs',
      routePattern: '/api/sla/policies/:policy_id/rungs',
    });
    expect(declared).toBe('sla.policy.write');
  });

  it('uses the domain as its own resource when there is no second segment', () => {
    expect(scopeForRequest({ method: 'POST', url: '/api/assignment', routePattern: '/api/assignment' }))
      .toBe('assignment.assignment.write');
  });

  it('treats HEAD like GET', () => {
    expect(scopeForRequest({ method: 'HEAD', url: '/api/sla/clocks', routePattern: '/api/sla/clocks' }))
      .toBe('sla.clock.read');
  });

  it('derives nothing outside /api', () => {
    // Health probes, portal assets and operator surfaces are not key-authorised;
    // inventing a scope for them would imply they were.
    expect(scopeForRequest({ method: 'GET', url: '/health', routePattern: '/health' })).toBeNull();
    expect(scopeForRequest({ method: 'GET', url: '/api', routePattern: '/api' })).toBeNull();
  });

  it('ignores a query string when no declared pattern is available', () => {
    expect(scopeForRequest({ method: 'GET', url: '/api/sla/clocks?tenant_id=abc' })).toBe('sla.clock.read');
  });
});

describe('scopeSatisfied', () => {
  it('accepts an exact grant', () => {
    expect(scopeSatisfied(['sla.clock.write'], 'sla.clock.write')).toBe(true);
  });

  it('refuses a different action on the same resource', () => {
    // The single most important negative: a read key must not write.
    expect(scopeSatisfied(['sla.clock.read'], 'sla.clock.write')).toBe(false);
  });

  it('refuses a different resource in the same domain', () => {
    expect(scopeSatisfied(['sla.clock.write'], 'sla.policy.write')).toBe(false);
  });

  it('accepts domain and resource wildcards', () => {
    expect(scopeSatisfied(['sla.*'], 'sla.clock.write')).toBe(true);
    expect(scopeSatisfied(['sla.clock.*'], 'sla.clock.read')).toBe(true);
    expect(scopeSatisfied(['*'], 'anything.at.all')).toBe(true);
  });

  it('does not let a wildcard leak across domains', () => {
    expect(scopeSatisfied(['sla.*'], 'crm.contact.read')).toBe(false);
  });

  it('refuses an empty grant list', () => {
    expect(scopeSatisfied([], 'sla.clock.read')).toBe(false);
  });
});
