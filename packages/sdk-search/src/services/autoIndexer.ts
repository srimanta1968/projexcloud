import { indexDocument } from './indexRegistry';

/**
 * Auto-indexer per FR-SRC-4.
 *
 * Subscribes to the platform event stream and projects registered entity
 * events into OpenSearch. Registration is config-driven:
 *
 *   registerIndexProjection('persona.created.v1', {
 *     entity_kind: 'persona',
 *     id_field: 'persona_id',
 *     extract: (event) => ({ ... }),
 *     scope_tags: (event) => [event.tenant_id],
 *   });
 *
 * On every matching envelope, the auto-indexer calls indexDocument() with
 * the extracted payload + scope_tags. Production reads from Kafka via
 * @projexlight/kafka-runtime; this synthetic facade lets callers pump events
 * in-process for tests.
 */

export interface IndexProjection {
  entity_kind: string;
  id_field: string;
  extract: (event: { tenant_id?: string; payload: Record<string, unknown> }) => Record<string, unknown>;
  scope_tags?: (event: { tenant_id?: string; payload: Record<string, unknown> }) => string[];
}

const projections = new Map<string, IndexProjection>();

export function registerIndexProjection(event_type: string, projection: IndexProjection): void {
  projections.set(event_type, projection);
}

export function clearIndexProjections(): void {
  projections.clear();
}

export async function handleEventForIndex(envelope: {
  event_type: string;
  tenant_id?: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const proj = projections.get(envelope.event_type);
  if (!proj) return; // event not configured for indexing
  if (!envelope.tenant_id) return; // tenant-less events cannot land in per-tenant indexes

  const doc = proj.extract({ tenant_id: envelope.tenant_id, payload: envelope.payload });
  const doc_id = (envelope.payload[proj.id_field] ?? doc[proj.id_field]) as string | undefined;
  if (!doc_id) return;

  await indexDocument({
    tenant_id: envelope.tenant_id,
    entity_kind: proj.entity_kind,
    doc_id,
    doc,
    scope_tags: proj.scope_tags?.({ tenant_id: envelope.tenant_id, payload: envelope.payload }) ?? [],
  });
}
