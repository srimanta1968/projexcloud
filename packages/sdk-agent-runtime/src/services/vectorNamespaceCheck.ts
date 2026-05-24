import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';

/**
 * Vector namespace isolation check (FR-ART-13..16 / AC-6).
 *
 * On runtime boot, walk `agents.vector_namespace_registry` and for every
 * registered namespace probe its backend (pgvector schema / Pinecone /
 * Qdrant / Weaviate) for rows tagged with a tenant_id that does not match
 * the namespace's owner. If any cross-tenant row is found, the runtime
 * MUST refuse to start — the leak it would otherwise enable is catastrophic
 * and irreversible.
 *
 * Healthy startup updates `verified_at` so dashboards + audit can confirm
 * the most recent successful check.
 */

const AGENT_AUDIT_POOL = process.env.AGENT_RUNTIME_AUDIT_POOL || 'admin-default';
const SYSTEM_ACTOR_ID = 'sdk-agent-runtime.namespace-check';

export type VectorBackend = 'pgvector' | 'pinecone' | 'qdrant' | 'weaviate';

export interface NamespaceRegistryRow {
  namespace: string;
  tenant_id: string;
  backend: VectorBackend;
}

export interface NamespaceProbeResult {
  /** Owning tenant from the registry — what every row in the namespace SHOULD have. */
  expected_tenant_id: string;
  /** Tenant ids found in the backend that don't match — empty when clean. */
  foreign_tenant_ids: string[];
  /** Sample row ids per foreign tenant (capped) for forensics. */
  sample_offending_ids: string[];
  /** When the backend isn't reachable / supported yet. Counts as 'unverified', not as 'leak'. */
  probe_status: 'verified' | 'unverified-backend-unsupported' | 'unverified-backend-error';
  probe_error?: string;
}

/**
 * Per-backend probe registry. Each backend ships its own probe; the default
 * pgvector implementation runs a SQL count against the per-namespace schema.
 * Other backends register at runtime via {@link registerNamespaceProbe}.
 */
export type NamespaceProbe = (row: NamespaceRegistryRow) => Promise<NamespaceProbeResult>;

const probes = new Map<VectorBackend, NamespaceProbe>();

export function registerNamespaceProbe(backend: VectorBackend, probe: NamespaceProbe): void {
  probes.set(backend, probe);
}

/**
 * Default pgvector probe. Assumes the per-namespace schema lives at
 * `vector_<namespace>` with a table `embedding` carrying a `tenant_id` UUID
 * column. Production deployments override this if their layout differs.
 */
async function defaultPgvectorProbe(row: NamespaceRegistryRow): Promise<NamespaceProbeResult> {
  // The namespace is part of the schema name; SQL injection risk if a hostile
  // operator inserted a malicious namespace value. Defensive validation:
  if (!/^[a-z0-9_]{1,63}$/.test(row.namespace)) {
    return {
      expected_tenant_id: row.tenant_id,
      foreign_tenant_ids: [],
      sample_offending_ids: [],
      probe_status: 'unverified-backend-error',
      probe_error: `Namespace "${row.namespace}" violates pgvector schema name policy (lowercase a-z0-9_, max 63 chars).`,
    };
  }

  const schema = `vector_${row.namespace}`;

  // Does the schema exist? If not, treat as 'verified empty' — a fresh
  // namespace registry entry that hasn't been populated yet is fine.
  const schemaExists = await dataService.one<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
     ) AS exists`,
    [schema],
  );
  if (!schemaExists?.exists) {
    return {
      expected_tenant_id: row.tenant_id,
      foreign_tenant_ids: [],
      sample_offending_ids: [],
      probe_status: 'verified',
    };
  }

  // Find rows tagged with any tenant_id that isn't the owner.
  // We identifier-quote the schema; the value param is a real bind.
  try {
    const r = await dataService.query<{ tenant_id: string; row_id: string }>(
      `SELECT DISTINCT tenant_id::text, MIN(id::text) AS row_id
         FROM "${schema}".embedding
        WHERE tenant_id IS NOT NULL
          AND tenant_id <> $1
        GROUP BY tenant_id
        LIMIT 50`,
      [row.tenant_id],
    );
    return {
      expected_tenant_id: row.tenant_id,
      foreign_tenant_ids: r.rows.map((x) => x.tenant_id),
      sample_offending_ids: r.rows.map((x) => x.row_id),
      probe_status: 'verified',
    };
  } catch (err) {
    return {
      expected_tenant_id: row.tenant_id,
      foreign_tenant_ids: [],
      sample_offending_ids: [],
      probe_status: 'unverified-backend-error',
      probe_error: (err as Error).message,
    };
  }
}

registerNamespaceProbe('pgvector', defaultPgvectorProbe);

export interface NamespaceCheckIssue {
  namespace: string;
  backend: VectorBackend;
  expected_tenant_id: string;
  foreign_tenant_ids: string[];
  sample_offending_ids: string[];
}

export interface NamespaceCheckReport {
  checked: number;
  verified: number;
  unverified: number;
  issues: NamespaceCheckIssue[];
  unverified_namespaces: { namespace: string; backend: VectorBackend; reason: string }[];
}

/**
 * Probe every namespace; return a structured report. Side-effects: marks
 * verified_at on healthy namespaces and emits a critical audit event for
 * any namespace that fails the cross-tenant check.
 */
export async function checkVectorNamespaceIsolation(): Promise<NamespaceCheckReport> {
  const registry = await dataService.query<NamespaceRegistryRow>(
    `SELECT namespace, tenant_id::text, backend
       FROM agents.vector_namespace_registry`,
  );

  const report: NamespaceCheckReport = {
    checked: registry.rows.length,
    verified: 0,
    unverified: 0,
    issues: [],
    unverified_namespaces: [],
  };

  for (const row of registry.rows) {
    const probe = probes.get(row.backend);
    let result: NamespaceProbeResult;
    if (!probe) {
      result = {
        expected_tenant_id: row.tenant_id,
        foreign_tenant_ids: [],
        sample_offending_ids: [],
        probe_status: 'unverified-backend-unsupported',
        probe_error: `No probe registered for backend "${row.backend}".`,
      };
    } else {
      try {
        result = await probe(row);
      } catch (err) {
        result = {
          expected_tenant_id: row.tenant_id,
          foreign_tenant_ids: [],
          sample_offending_ids: [],
          probe_status: 'unverified-backend-error',
          probe_error: (err as Error).message,
        };
      }
    }

    if (result.foreign_tenant_ids.length > 0) {
      report.issues.push({
        namespace: row.namespace,
        backend: row.backend,
        expected_tenant_id: row.tenant_id,
        foreign_tenant_ids: result.foreign_tenant_ids,
        sample_offending_ids: result.sample_offending_ids,
      });
      try {
        await appendAuditEntry({
          pool_index: AGENT_AUDIT_POOL,
          event_type: 'agent.scope.exceeded.v1',
          actor_kind: 'service',
          actor_id: SYSTEM_ACTOR_ID,
          tenant_id: row.tenant_id,
          subject_kind: 'agent.vector_namespace_registry',
          subject_id: row.namespace,
          retention_class: 'regulated',
          payload: {
            kind: 'vector_namespace_cross_tenant_leak',
            namespace: row.namespace,
            backend: row.backend,
            expected_tenant_id: row.tenant_id,
            foreign_tenant_ids: result.foreign_tenant_ids,
            sample_offending_ids: result.sample_offending_ids,
          },
        });
      } catch (auditErr) {
        console.error(
          '[namespace-check] audit emit failed for namespace',
          row.namespace,
          (auditErr as Error).message,
        );
      }
    } else if (result.probe_status === 'verified') {
      report.verified += 1;
      try {
        await dataService.query(
          `UPDATE agents.vector_namespace_registry
              SET verified_at = now()
            WHERE namespace = $1`,
          [row.namespace],
        );
      } catch (markErr) {
        console.warn(
          '[namespace-check] verified_at update failed for',
          row.namespace,
          (markErr as Error).message,
        );
      }
    } else {
      report.unverified += 1;
      report.unverified_namespaces.push({
        namespace: row.namespace,
        backend: row.backend,
        reason: result.probe_error ?? result.probe_status,
      });
    }
  }
  return report;
}

/**
 * Boot-time entrypoint. Returns the report on success, throws on detected
 * cross-tenant data. Callers (api-gateway boot) treat a thrown error as a
 * hard exit — the process must NOT start when isolation is broken.
 *
 * Unverified namespaces (probe failure / unsupported backend) do NOT throw
 * by default — they're logged + recorded but don't block boot. Callers
 * that want strict mode pass {strict: true} to refuse boot on any
 * unverified namespace too.
 */
export interface AssertOptions {
  /** When true, refuse boot if any namespace cannot be verified. Default false. */
  strict?: boolean;
}

export async function assertVectorNamespaceIsolation(
  opts: AssertOptions = {},
): Promise<NamespaceCheckReport> {
  const report = await checkVectorNamespaceIsolation();

  if (report.issues.length > 0) {
    const summary = report.issues
      .map((i) => `${i.namespace} (${i.backend}) leaks ${i.foreign_tenant_ids.length} foreign tenant(s)`)
      .join('; ');
    throw new Error(
      `[namespace-check] AC-6 violation: ${report.issues.length} namespace(s) contain cross-tenant data — ${summary}`,
    );
  }

  if (opts.strict && report.unverified > 0) {
    const summary = report.unverified_namespaces
      .map((u) => `${u.namespace} (${u.backend}): ${u.reason}`)
      .join('; ');
    throw new Error(
      `[namespace-check] strict mode: ${report.unverified} unverified namespace(s) — ${summary}`,
    );
  }

  return report;
}
