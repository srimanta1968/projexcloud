import { ESLintUtils, AST_NODE_TYPES } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator((name) => `https://docs.projexcloud.com/oc/${name}`);

// Mirror of EVENT_TYPE_REGISTRY keys from @projexlight/contracts. Producer code
// that uses a literal string event_type not on this list is rejected per
// FR-AUD-5. Keep this set in sync with packages/contracts/src/events.ts —
// CI's contract-diff job will fail if they drift.
const REGISTERED = new Set([
  // --- P1 ---
  'vault.key.issued.v1', 'vault.key.rotated.v1', 'vault.key.shredded.v1',
  'vault.encounter.opened.v1', 'vault.encounter.sealed.v1',
  'secrets.ref.resolved.v1', 'secrets.key.rotated.v1',
  'tenant.pool.assigned.v1', 'pool.lifecycle.changed.v1',
  'usage.event.v1',
  'audit.chain.verified.v1', 'audit.chain.break.v1',
  'audit.export.requested.v1', 'audit.export.ready.v1',
  // --- P2 ---
  'tenant.created.v1', 'tenant.subtenant.created.v1', 'reseller.created.v1', 'reseller.tenant.attached.v1',
  'tenant.bu.created.v1', 'tenant.bu.moved.v1', 'tenant.role-template.updated.v1',
  'tenant.fiscal-calendar.updated.v1',
  'identity.login.v1', 'identity.app-identity.created.v1',
  'identity.alias.merged.v1', 'identity.federation.configured.v1',
  'identity.mfa.challenged.v1', 'identity.mfa.verified.v1',
  'identity.impersonation.requested.v1', 'identity.impersonation.granted.v1', 'identity.impersonation.ended.v1',
  'consent.granted.v1', 'consent.revoked.v1', 'consent.purpose.registered.v1', 'consent.cross-tenant.granted.v1',
  'policy.evaluated.v1', 'policy.updated.v1',
  'rebac.relationship.created.v1', 'rebac.relationship.scope.changed.v1',
  'rebac.relationship.terminated.v1', 'rebac.decision.v1',
  'api-key.issued.v1', 'api-key.rotated.v1', 'api-key.revoked.v1', 'api-key.used.v1',
  'identity.projection.refreshed.v1', 'identity.projection.miss.v1',
  // --- P3 ---
  'profile.band.updated.v1', 'profile.field.shredded.v1',
  'identity.persona.created.v1', 'identity.persona.shred.v1',
  'identity.membership.created.v1', 'identity.membership.suspended.v1',
  'identity.membership.reactivated.v1', 'identity.membership.terminated.v1',
  'identity.role.assigned.v1', 'identity.role.revoked.v1',
  'identity.resolver.fallback.v1',
  'data-rights.request.submitted.v1', 'data-rights.request.transitioned.v1',
  'data-rights.executed.v1', 'data-rights.certificate.issued.v1',
  'data-rights.reconciliation.completed.v1', 'pool-residency.touched.v1',
  'geo.address.canonicalized.v1', 'geo.address.merged.v1',
  'device.registered.v1', 'device.attested.v1', 'device.revoked.v1', 'device.person-link.changed.v1',
  'feature-flag.updated.v1', 'feature-flag.rollout.updated.v1', 'feature-flag.kill-switch.flipped.v1',
  'hdk-sync.queue.replayed.v1', 'hdk-sync.conflict.resolved.v1',
  'hdk-sync.conflict.escalated-to-human.v1', 'hdk-sync.event-type-policy.registered.v1',
  'hdk-idp.device-claim.registered.v1', 'hdk-idp.offline-auth.synced.v1',
  'hdk-permissions.surface.snapshot.v1',
  // --- P4 (Operational + Billing) ---
  'media.blob.uploaded.v1', 'media.transcode.completed.v1', 'media.blob.shredded.v1',
  'notification.sent.v1', 'notification.delivered.v1', 'notification.failed.v1',
  'payment.charge.v1', 'payment.refund.v1', 'payment.distributed.v1',
  'billing.invoice.finalized.v1', 'billing.invoice.paid.v1',
  'billing.dunning.advanced.v1', 'billing.reprice.dry-run.completed.v1',
  'approval.step.decided.v1',
  // --- P5 ---
  'engagement.encounter.opened.v1', 'engagement.encounter.closed.v1', 'engagement.encounter.sealed.v1',
  'engagement.relationship.created.v1', 'engagement.relationship.terminated.v1',
  'engagement.encounter.grant.issued.v1', 'engagement.encounter.grant.revoked.v1',
  'crm.contact.created.v1', 'crm.contact.updated.v1',
  'crm.deal.created.v1', 'crm.deal.transitioned.v1', 'crm.activity.logged.v1',
  'content.item.created.v1', 'content.version.published.v1',
  'service-request.ticket.created.v1', 'service-request.ticket.transitioned.v1', 'service-request.ticket.sla.breached.v1',
  'event.session.opened.v1', 'event.ticket.issued.v1', 'event.ticket.checked-in.v1',
  'campaign.created.v1', 'campaign.segment.computed.v1', 'campaign.journey.advanced.v1',
  'social.handle.authorized.v1', 'social.interaction.ingested.v1', 'social.lead.captured.v1',
  'connector.installed.v1', 'connector.uninstalled.v1', 'connector.sync.completed.v1', 'connector.sync.conflict.v1',
  'hdk-scanner.code.captured.v1', 'hdk-image.edit.applied.v1', 'hdk-video.trim.applied.v1',
  // --- P4 audit-driven additions ---
  'tenant.lifecycle.transitioned.v1', 'tenant.lifecycle.sandbox.created.v1', 'tenant.lifecycle.offboarded.v1',
  'slack.workspace.connected.v1', 'slack.message.posted.v1', 'slack.thread.message.v1', 'slack.interaction.received.v1',
  'webhook.delivery.failed.v1', 'webhook.delivery.dlq.v1',
]);

/**
 * OC-2: any literal passed as event_type to appendAuditEntry / publishMessage
 * must be in EVENT_TYPE_REGISTRY. Catches unregistered types at lint time.
 */
export default createRule({
  name: 'oc-2-registered-event-type',
  meta: {
    type: 'problem',
    docs: { description: 'event_type literals must be in EVENT_TYPE_REGISTRY' },
    messages: { unregistered: 'OC-2: event_type "{{ value }}" is not in EVENT_TYPE_REGISTRY (contracts/events.ts)' },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      Property(node) {
        if (node.key.type !== AST_NODE_TYPES.Identifier) return;
        if (node.key.name !== 'event_type') return;
        if (node.value.type !== AST_NODE_TYPES.Literal) return;
        const v = node.value.value;
        if (typeof v !== 'string') return;
        if (REGISTERED.has(v)) return;
        if (!/^[a-z][a-z0-9._-]+\.v\d+$/.test(v)) return; // skip non-event-typeish strings
        context.report({ node, messageId: 'unregistered', data: { value: v } });
      },
    };
  },
});
