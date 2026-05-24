import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  DomainOntologyBundle,
  OntologyRef,
  OntologyStatus,
  SemanticObjectTypeRef,
  SemanticRelationTypeRef,
  CapabilityGraphEdgeRef,
} from '@projexlight/contracts';

/**
 * sdk-semantic ontology registry — registers a per-vertical bundle (Healthcare,
 * Realty, Seva v1) atomically so an agent calling plan() always sees a
 * consistent ontology snapshot.
 *
 * Register flow:
 *   1. Insert (or reuse) the ontology row
 *   2. Insert every object_type from the bundle, building a name→id map
 *   3. Insert every relation_type using the name map for endpoints
 *   4. Insert every capability_graph_edge using both name maps
 *   5. Emit semantic.ontology.registered.v1 to the audit chain
 *
 * Everything runs in a single transaction — a half-registered ontology
 * would corrupt planner output.
 */

interface OntologyRow {
  ontology_id: string;
  name: string;
  version: string;
  status: string;
  parent_ontology_id: string | null;
  bundle_ref: string;
  created_at: Date;
}

function rowToOntology(r: OntologyRow): OntologyRef {
  return {
    ontology_id: r.ontology_id,
    name: r.name,
    version: r.version,
    status: r.status as OntologyStatus,
    parent_ontology_id: r.parent_ontology_id,
    bundle_ref: r.bundle_ref,
  };
}

const SEMANTIC_AUDIT_POOL = process.env.SEMANTIC_AUDIT_POOL || 'admin-default';

export interface RegisterOntologyInput {
  bundle: DomainOntologyBundle;
  /** Where the bundle JSON lives (contracts version, Global Catalog blob, …). */
  bundle_ref: string;
  /** Whether to promote to status='active' on register. */
  activate?: boolean;
}

export interface RegisterOntologyResult {
  ontology: OntologyRef;
  object_types: SemanticObjectTypeRef[];
  relation_types: SemanticRelationTypeRef[];
  capability_edges: CapabilityGraphEdgeRef[];
}

export async function registerOntology(input: RegisterOntologyInput): Promise<RegisterOntologyResult> {
  const { bundle, bundle_ref, activate = true } = input;
  const status: OntologyStatus = activate ? 'active' : 'draft';

  let parentId: string | null = null;
  if (bundle.parent_ontology) {
    const parent = await dataService.one<OntologyRow>(
      `SELECT ontology_id, name, version, status, parent_ontology_id, bundle_ref, created_at
         FROM semantic.ontology
        WHERE name = $1 AND version = $2`,
      [bundle.parent_ontology.name, bundle.parent_ontology.version],
    );
    if (!parent) {
      throw new Error(
        `[sdk-semantic] parent ontology not registered: ${bundle.parent_ontology.name}@${bundle.parent_ontology.version}`,
      );
    }
    parentId = parent.ontology_id;
  }

  return dataService.tx(async (q) => {
    // 1. Ontology row (upsert by name+version so re-registering an active
    //    bundle of the same version is a no-op rather than a duplicate).
    const ontologyId = randomUUID();
    const ontologyRow = await q<OntologyRow>(
      `INSERT INTO semantic.ontology
         (ontology_id, name, version, status, parent_ontology_id, bundle_ref)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name, version) DO UPDATE
         SET status = EXCLUDED.status,
             bundle_ref = EXCLUDED.bundle_ref
       RETURNING ontology_id, name, version, status, parent_ontology_id, bundle_ref, created_at`,
      [ontologyId, bundle.name, bundle.version, status, parentId, bundle_ref],
    );
    const ontology = rowToOntology(ontologyRow.rows[0]);

    // 2. Object types.
    const objectTypeIdByName = new Map<string, string>();
    const objectTypes: SemanticObjectTypeRef[] = [];
    for (const ot of bundle.object_types) {
      const objId = randomUUID();
      const r = await q<{ object_type_id: string }>(
        `INSERT INTO semantic.object_type
           (object_type_id, ontology_id, name, attribute_schema, backed_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (ontology_id, name) DO UPDATE
           SET attribute_schema = EXCLUDED.attribute_schema,
               backed_by = EXCLUDED.backed_by
         RETURNING object_type_id`,
        [objId, ontology.ontology_id, ot.name, ot.attribute_schema ?? {}, ot.backed_by],
      );
      const insertedId = r.rows[0].object_type_id;
      objectTypeIdByName.set(ot.name, insertedId);
      objectTypes.push({
        object_type_id: insertedId,
        ontology_id: ontology.ontology_id,
        name: ot.name,
        attribute_schema: (ot.attribute_schema ?? {}) as Record<string, unknown>,
        backed_by: ot.backed_by,
      });
    }

    // 3. Relation types (must come after object_types so endpoint lookups resolve).
    const relationTypeIdByName = new Map<string, string>();
    const relationTypes: SemanticRelationTypeRef[] = [];
    for (const rt of bundle.relation_types) {
      const fromId = objectTypeIdByName.get(rt.from_object_type_name);
      const toId = objectTypeIdByName.get(rt.to_object_type_name);
      if (!fromId || !toId) {
        throw new Error(
          `[sdk-semantic] relation '${rt.name}' references unknown object_type ${rt.from_object_type_name}→${rt.to_object_type_name}`,
        );
      }
      const relId = randomUUID();
      const r = await q<{ relation_type_id: string }>(
        `INSERT INTO semantic.relation_type
           (relation_type_id, ontology_id, name, from_object_type_id, to_object_type_id, cardinality, rebac_kind_mapping)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (ontology_id, name, from_object_type_id, to_object_type_id) DO UPDATE
           SET cardinality = EXCLUDED.cardinality,
               rebac_kind_mapping = EXCLUDED.rebac_kind_mapping
         RETURNING relation_type_id`,
        [relId, ontology.ontology_id, rt.name, fromId, toId, rt.cardinality, rt.rebac_kind_mapping ?? null],
      );
      const insertedId = r.rows[0].relation_type_id;
      relationTypeIdByName.set(rt.name, insertedId);
      relationTypes.push({
        relation_type_id: insertedId,
        ontology_id: ontology.ontology_id,
        name: rt.name,
        from_object_type_id: fromId,
        to_object_type_id: toId,
        cardinality: rt.cardinality,
        rebac_kind_mapping: rt.rebac_kind_mapping ?? null,
      });
    }

    // 4. Capability graph edges.
    const capabilityEdges: CapabilityGraphEdgeRef[] = [];
    for (const ce of bundle.capability_graph) {
      const objId = objectTypeIdByName.get(ce.object_type_name);
      if (!objId) {
        throw new Error(
          `[sdk-semantic] capability '${ce.tool_sku}' references unknown object_type ${ce.object_type_name}`,
        );
      }
      const requiresRelationId = ce.requires_relation_name
        ? (relationTypeIdByName.get(ce.requires_relation_name) ?? null)
        : null;
      if (ce.requires_relation_name && !requiresRelationId) {
        throw new Error(
          `[sdk-semantic] capability '${ce.tool_sku}' requires unknown relation '${ce.requires_relation_name}'`,
        );
      }

      const edgeId = randomUUID();
      const r = await q<{ edge_id: string }>(
        `INSERT INTO semantic.capability_graph_edge
           (edge_id, object_type_id, tool_sku, requires_relation, pre_conditions, post_conditions)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (object_type_id, tool_sku) DO UPDATE
           SET requires_relation = EXCLUDED.requires_relation,
               pre_conditions = EXCLUDED.pre_conditions,
               post_conditions = EXCLUDED.post_conditions
         RETURNING edge_id`,
        [edgeId, objId, ce.tool_sku, requiresRelationId, ce.pre_conditions ?? {}, ce.post_conditions ?? {}],
      );
      capabilityEdges.push({
        edge_id: r.rows[0].edge_id,
        object_type_id: objId,
        tool_sku: ce.tool_sku,
        requires_relation: requiresRelationId,
        pre_conditions: ce.pre_conditions ?? {},
        post_conditions: ce.post_conditions ?? {},
      });
    }

    // 5. Audit.
    await appendAuditEntry({
      event_type: 'semantic.ontology.registered.v1',
      payload: {
        ontology_id: ontology.ontology_id,
        name: ontology.name,
        version: ontology.version,
        status: ontology.status,
        object_types_count: objectTypes.length,
        relation_types_count: relationTypes.length,
        capability_edges_count: capabilityEdges.length,
      },
      pool_index: SEMANTIC_AUDIT_POOL,
      actor_kind: 'service',
      actor_id: 'sdk-semantic',
      retention_class: 'regulated',
    });

    return { ontology, object_types: objectTypes, relation_types: relationTypes, capability_edges: capabilityEdges };
  });
}

/**
 * Look up an active ontology by name. Returns the highest-version row in
 * status='active' (semver lexicographic — good enough for v1; future
 * patch parses semver properly). Throws when no active row exists.
 */
export async function getActiveOntology(name: string): Promise<OntologyRef> {
  const row = await dataService.one<OntologyRow>(
    `SELECT ontology_id, name, version, status, parent_ontology_id, bundle_ref, created_at
       FROM semantic.ontology
      WHERE name = $1 AND status = 'active'
      ORDER BY version DESC
      LIMIT 1`,
    [name],
  );
  if (!row) throw new Error(`[sdk-semantic] no active ontology named '${name}'`);
  return rowToOntology(row);
}

export async function listOntologies(): Promise<OntologyRef[]> {
  const rows = await dataService.rows<OntologyRow>(
    `SELECT ontology_id, name, version, status, parent_ontology_id, bundle_ref, created_at
       FROM semantic.ontology
      ORDER BY name, version`,
  );
  return rows.map(rowToOntology);
}

export async function deprecateOntology(ontology_id: string, reason: string): Promise<OntologyRef> {
  const updated = await dataService.one<OntologyRow>(
    `UPDATE semantic.ontology
        SET status = 'deprecated'
      WHERE ontology_id = $1
    RETURNING ontology_id, name, version, status, parent_ontology_id, bundle_ref, created_at`,
    [ontology_id],
  );
  if (!updated) throw new Error(`[sdk-semantic] ontology '${ontology_id}' not found`);

  await appendAuditEntry({
    event_type: 'semantic.ontology.deprecated.v1',
    payload: { ontology_id, reason },
    pool_index: SEMANTIC_AUDIT_POOL,
    actor_kind: 'service',
    actor_id: 'sdk-semantic',
    retention_class: 'regulated',
  });

  return rowToOntology(updated);
}
