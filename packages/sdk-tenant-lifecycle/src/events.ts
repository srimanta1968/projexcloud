/**
 * Re-exports of the three tenant.lifecycle.* event types this SDK emits.
 * Registered in @projexlight/contracts/events; this file is the
 * SDK-local handle so callers can `import { TENANT_LIFECYCLE_TRANSITIONED }`
 * without typo'ing the dotted name.
 */
export const TENANT_LIFECYCLE_TRANSITIONED = 'tenant.lifecycle.transitioned.v1' as const;
export const TENANT_LIFECYCLE_SANDBOX_CREATED = 'tenant.lifecycle.sandbox.created.v1' as const;
export const TENANT_LIFECYCLE_OFFBOARDED = 'tenant.lifecycle.offboarded.v1' as const;

export type TenantLifecycleEventType =
  | typeof TENANT_LIFECYCLE_TRANSITIONED
  | typeof TENANT_LIFECYCLE_SANDBOX_CREATED
  | typeof TENANT_LIFECYCLE_OFFBOARDED;
