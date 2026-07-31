/**
 * @projexlight/sdk-coverage — workforce coverage, availability & capacity (P16 · EP-377).
 *
 * The package that answers ONE question honestly: who can act right now?
 *
 * Availability is a subtraction — schedule MINUS time-off MINUS holiday, intersected
 * with live presence and capacity headroom — and every term of it is kept as a
 * separate queryable fact so a routing decision can always say WHY somebody was
 * skipped. A single "available" boolean would be cheaper and useless: nobody can
 * audit it, so nobody trusts it.
 *
 * Consumed by sdk-assignment step 4 and by sdk-sla's late-coverage and on-call
 * audience resolution.
 *
 * Vertical-neutral by contract.
 */
export { migrationsDir } from './db';
export * from './services/timezone';
export * from './services/eligibilityService';
export * from './services/capacityService';
export * from './services/onCallService';
