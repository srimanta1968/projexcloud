import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { enqueueProjectionRefresh } from '@projexlight/sdk-projection';
import { getCached, invalidatePersona, setCached } from './reachabilityCache';

const POOL_INDEX = process.env.POOL_INDEX || 'admin';
import {
  DEFAULT_BUDGET,
  type CheckRelationshipInput,
  type CheckRelationshipResult,
  type CreateRelationshipInput,
  type RelationshipRecord,
  type UpdateRelationshipScopeInput,
} from '../models/rebac.model';

/**
 * sdk-rebac service layer per P2 §5.5 / FR-REB-1..10.
 *
 * Traversal model: BFS from subject_persona over active edges, bounded by
 * depth_cap (default 4) and visit_cap. ALLOW iff target_persona is reachable
 * via at least one edge of the requested kind within budget.
 */

export async function createRelationship(input: CreateRelationshipInput): Promise<RelationshipRecord> {
  const rows = await dataService.rows<RelationshipRecord>(
    `INSERT INTO rebac.relationship (
        kind, persona_a, persona_b, scope, consent_ref,
        expires_at, reattest_due_at, cross_tenant, status
     ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, 'active')
     RETURNING relationship_id, kind, persona_a, persona_b, scope,
               status, consent_ref, expires_at, reattest_due_at,
               cross_tenant, created_at, terminated_at`,
    [
      input.kind,
      input.persona_a,
      input.persona_b,
      JSON.stringify(input.scope ?? {}),
      input.consent_ref ?? null,
      input.expires_at ? new Date(input.expires_at) : null,
      input.reattest_due_at ? new Date(input.reattest_due_at) : null,
      input.cross_tenant ?? false,
    ],
  );
  const row = rows[0];
  await invalidatePersona(row.persona_a);
  await invalidatePersona(row.persona_b);
  // FR-IPS-2: triggering event for the projector
  await enqueueProjectionRefresh({ person_id: row.persona_a });
  await enqueueProjectionRefresh({ person_id: row.persona_b });
  // FR-REB-10 audit fan-out
  await emitEvent({
    event_type: 'rebac.relationship.created.v1',
    payload: {
      relationship_id: row.relationship_id,
      kind: row.kind,
      persona_a: row.persona_a,
      persona_b: row.persona_b,
      cross_tenant: row.cross_tenant,
    },
    pool_index: POOL_INDEX,
    actor_kind: 'service',
    actor_id: 'sdk-rebac.create',
    subject_kind: 'relationship',
    subject_id: row.relationship_id,
  });
  return row;
}

export async function updateRelationshipScope(
  relationship_id: string,
  input: UpdateRelationshipScopeInput,
): Promise<RelationshipRecord> {
  const sets: string[] = [];
  const args: unknown[] = [relationship_id];
  if (input.scope !== undefined) {
    sets.push(`scope = $${args.length + 1}::jsonb`);
    args.push(JSON.stringify(input.scope));
  }
  if (input.status !== undefined) {
    sets.push(`status = $${args.length + 1}`);
    args.push(input.status);
    if (input.status === 'terminated') {
      sets.push(`terminated_at = now()`);
    }
  }
  if (sets.length === 0) {
    const existing = await dataService.one<RelationshipRecord>(
      `SELECT * FROM rebac.relationship WHERE relationship_id = $1`,
      [relationship_id],
    );
    if (!existing) throw new Error(`Relationship ${relationship_id} not found`);
    return existing;
  }
  const rows = await dataService.rows<RelationshipRecord>(
    `UPDATE rebac.relationship SET ${sets.join(', ')}
      WHERE relationship_id = $1
      RETURNING relationship_id, kind, persona_a, persona_b, scope,
                status, consent_ref, expires_at, reattest_due_at,
                cross_tenant, created_at, terminated_at`,
    args,
  );
  if (rows.length === 0) throw new Error(`Relationship ${relationship_id} not found`);
  const row = rows[0];
  await invalidatePersona(row.persona_a);
  await invalidatePersona(row.persona_b);
  await enqueueProjectionRefresh({ person_id: row.persona_a });
  await enqueueProjectionRefresh({ person_id: row.persona_b });
  const eventType = row.status === 'terminated'
    ? 'rebac.relationship.terminated.v1'
    : 'rebac.relationship.scope.changed.v1';
  await emitEvent({
    event_type: eventType,
    payload: {
      relationship_id: row.relationship_id,
      kind: row.kind,
      persona_a: row.persona_a,
      persona_b: row.persona_b,
      status: row.status,
      scope: row.scope,
    },
    pool_index: POOL_INDEX,
    actor_kind: 'service',
    actor_id: 'sdk-rebac.scope',
    subject_kind: 'relationship',
    subject_id: row.relationship_id,
  });
  return row;
}

/**
 * Fetches neighbors of `persona` via active edges of `kind`. Returns the
 * persona at the OTHER end of each edge (relationships are undirected for
 * traversal — kind asymmetry is the responsibility of the kind taxonomy).
 */
async function neighbors(persona: string, kind: string): Promise<string[]> {
  const rows = await dataService.rows<{ other: string }>(
    `SELECT CASE WHEN persona_a = $1 THEN persona_b ELSE persona_a END AS other
       FROM rebac.relationship
      WHERE kind = $2
        AND status = 'active'
        AND (persona_a = $1 OR persona_b = $1)
        AND (expires_at IS NULL OR expires_at > now())`,
    [persona, kind],
  );
  return rows.map((r) => r.other);
}

export async function checkRelationship(input: CheckRelationshipInput): Promise<CheckRelationshipResult> {
  const budget = input.budget ?? DEFAULT_BUDGET;
  const cached = await getCached(
    input.subject_persona_id,
    input.target_persona_id,
    input.kind,
    budget.depth_cap,
  );
  if (cached) {
    await logDecision(input, cached.decision, cached.reason, cached.traversal_depth);
    return cached;
  }

  let visits = 0;
  const visited = new Set<string>([input.subject_persona_id]);
  let frontier: { persona: string; depth: number }[] = [{ persona: input.subject_persona_id, depth: 0 }];
  let found = false;
  let depthReached = 0;

  while (frontier.length > 0 && !found) {
    const next: { persona: string; depth: number }[] = [];
    for (const node of frontier) {
      if (visits >= budget.visit_cap) break;
      if (node.depth >= budget.depth_cap) continue;
      const adj = await neighbors(node.persona, input.kind);
      for (const n of adj) {
        visits++;
        depthReached = Math.max(depthReached, node.depth + 1);
        if (n === input.target_persona_id) { found = true; break; }
        if (!visited.has(n)) {
          visited.add(n);
          next.push({ persona: n, depth: node.depth + 1 });
        }
      }
      if (found) break;
    }
    frontier = next;
  }

  const decision: 'allow' | 'deny' = found ? 'allow' : 'deny';
  const reason = found
    ? `Reached target_persona via ${depthReached}-hop ${input.kind} traversal within budget`
    : visits >= budget.visit_cap
      ? `Visit cap ${budget.visit_cap} exhausted without reaching target`
      : `No ${input.kind} path within depth ${budget.depth_cap}`;

  const result: Omit<CheckRelationshipResult, 'cached'> = {
    decision,
    reason,
    traversal_depth: depthReached,
    budget_used: { visits, depth: depthReached },
  };

  await setCached(
    input.subject_persona_id,
    input.target_persona_id,
    input.kind,
    budget.depth_cap,
    result,
  );
  await logDecision(input, decision, reason, depthReached);

  return { ...result, cached: false };
}

async function logDecision(
  input: CheckRelationshipInput,
  decision: 'allow' | 'deny',
  reason: string,
  traversal_depth: number,
): Promise<void> {
  // Sampled at 100% in dev; production samples per PRD §5.5 (rebac.decision.v1 sampled).
  await dataService.query(
    `INSERT INTO rebac.relationship_decision
      (subject_persona_id, target_persona_id, relationship_kind, decision, reason, traversal_depth)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.subject_persona_id, input.target_persona_id, input.kind, decision, reason, traversal_depth],
  );
  // FR-REB-10 audit fan-out (sampled per registry — operational+lww).
  await emitEvent({
    event_type: 'rebac.decision.v1',
    payload: {
      subject_persona_id: input.subject_persona_id,
      target_persona_id: input.target_persona_id,
      relationship_kind: input.kind,
      decision,
      reason,
      traversal_depth,
    },
    pool_index: POOL_INDEX,
    actor_kind: 'service',
    actor_id: 'sdk-rebac.check',
    subject_kind: 'persona',
    subject_id: input.subject_persona_id,
  });
}

/**
 * FR-REB-5: re-attestation scheduler. Returns relationships whose
 * reattest_due_at has passed and they're still active. Caller (typically a
 * cron worker) is expected to notify the owning persona or auto-suspend.
 */
export async function findOverdueReattestations(limit = 500): Promise<RelationshipRecord[]> {
  return dataService.rows<RelationshipRecord>(
    `SELECT relationship_id, kind, persona_a, persona_b, scope, status,
            consent_ref, expires_at, reattest_due_at, cross_tenant,
            created_at, terminated_at
       FROM rebac.relationship
      WHERE status = 'active'
        AND reattest_due_at IS NOT NULL
        AND reattest_due_at < now()
      ORDER BY reattest_due_at ASC
      LIMIT $1`,
    [limit],
  );
}

/**
 * FR-REB-5: starts a periodic sweep that auto-suspends overdue
 * relationships. Returns a stop() handle. The default 24h interval matches
 * healthcare PCP annual cadence (caller can pass intervalMs for other rhythms).
 */
export function startReattestationScheduler(opts: {
  enabled?: boolean;
  intervalMs?: number;
  onOverdue?: (rel: RelationshipRecord) => Promise<void> | void;
} = {}): { stop: () => void } {
  const enabled = opts.enabled !== false;
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000;
  if (!enabled) {
    return { stop: () => undefined };
  }
  const timer = setInterval(async () => {
    try {
      const overdue = await findOverdueReattestations();
      for (const rel of overdue) {
        if (opts.onOverdue) {
          await opts.onOverdue(rel);
        } else {
          // Default behavior: flag as suspended so downstream evaluators stop
          // honoring the edge until a re-attestation lands.
          await updateRelationshipScope(rel.relationship_id, { status: 'suspended' });
        }
      }
    } catch (err) {
      console.warn('[rebac.reattest] sweep failed:', (err as Error).message);
    }
  }, intervalMs);
  // Don't keep the process alive solely on this timer.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  return { stop: () => clearInterval(timer) };
}
