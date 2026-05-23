import { FastifyReply, FastifyRequest } from 'fastify';
import {
  IndexNotFoundError,
  createSavedQuery,
  ensureIndex,
  executeQuery,
  listSavedQueries,
  resolveEffectiveScopes,
} from '../../services/searchService';
import {
  validateExecuteQuery,
  validateRegisterIndex,
  validateSaveQuery,
} from '../../validators/searchValidator';

function authTenant(req: FastifyRequest, reply: FastifyReply): string | null {
  const tid = req.auth?.tenant_id;
  if (!tid) {
    reply.code(403).send({ error: 'Forbidden', details: ['JWT missing tenant_id claim'] });
    return null;
  }
  return tid;
}

function fail(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
  if (err instanceof IndexNotFoundError) {
    reply.code(404).send({ error: err.code, details: [err.message] });
    return;
  }
  req.log.error(err);
  reply.code(500).send({ error: 'InternalError' });
}

/** POST /api/search/index - register an index definition (and ensure physical index). */
export async function registerIndexHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const body = { ...(req.body as Record<string, unknown> ?? {}), tenant_id: tid };
  const v = validateRegisterIndex(body);
  if (!v.ok) { reply.code(400).send({ error: 'ValidationError', details: v.errors }); return; }
  try {
    const def = await ensureIndex(v.value);
    reply.code(201).send({ data: { definition: def } });
  } catch (err) { fail(req, reply, err); }
}

/**
 * GET /api/search?q=&entity_kind= - ABAC-filtered free-text query.
 * Body POSTable for full DSL. tenant_id and effective_scopes come from req.auth.
 */
export async function queryHandler(
  req: FastifyRequest<{ Querystring: Record<string, string> }>,
  reply: FastifyReply,
): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const incoming = (req.method === 'POST' ? req.body : req.query) as Record<string, unknown> ?? {};
  const body = { ...incoming, tenant_id: tid };
  const v = validateExecuteQuery(body);
  if (!v.ok) { reply.code(400).send({ error: 'ValidationError', details: v.errors }); return; }
  try {
    // FR-SRC-3: scopes are server-resolved from verified JWT claims, NEVER body.
    const effective_scopes = resolveEffectiveScopes(req.auth ?? {});
    const result = await executeQuery({ ...v.value, effective_scopes });
    reply.code(200).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/search/saved-queries - persist a named query for later execution. */
export async function saveQueryHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const body = { ...(req.body as Record<string, unknown> ?? {}), tenant_id: tid };
  const v = validateSaveQuery(body);
  if (!v.ok) { reply.code(400).send({ error: 'ValidationError', details: v.errors }); return; }
  try {
    const saved = await createSavedQuery(v.value);
    reply.code(201).send({ data: { saved_query: saved } });
  } catch (err) { fail(req, reply, err); }
}

/** GET /api/search/saved-queries?persona_id= - list a persona's saved queries. */
export async function listSavedQueriesHandler(
  req: FastifyRequest<{ Querystring: { persona_id?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const persona_id = req.query.persona_id;
  if (!persona_id) {
    reply.code(400).send({ error: 'ValidationError', details: ['persona_id required'] });
    return;
  }
  try {
    const queries = await listSavedQueries(tid, persona_id);
    reply.code(200).send({ data: { queries } });
  } catch (err) { fail(req, reply, err); }
}
