import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import { dataService } from '@projexlight/db-runtime';
import { listCapabilities, UnknownCapability } from '../services/brokerService';
import {
  approveRequest,
  ApprovalRequired,
  estimate,
  execute,
  getBalance,
  getRequest,
  InsufficientCredits,
  listLedger,
  NoCreditAccount,
  NotAwaitingApproval,
  rejectRequest,
  reserve,
  SettlementConflict,
  settle,
  UnknownRequest,
} from '../services/reservationService';
import type { SettlementOutcome } from '../services/brokerService';
import {
  BudgetPolicyInvalid,
  DailyCapExceeded,
  listBudgetPolicies,
  upsertBudgetPolicy,
  type BudgetMode,
} from '../services/budgetService';

/**
 * HTTP surface for sdk-data-credits.
 *
 * THE CONTRACT THIS FILE EXISTS TO KEEP: nothing a tenant can read names a vendor.
 * Every handler returns a view the services build by NAMING fields — never a row, and
 * never a spread of one — so a column added to `provider_binding` or a field added to
 * an internal result cannot arrive here by default. The contract test asserts it over
 * every route and every error path, because an error message naming the vendor that
 * failed is a leak with a stack trace attached.
 *
 * ERROR SHAPES, deliberate and matching the api_definitions written before these
 * handlers existed:
 *   400 VALIDATION_ERROR      — the request is missing something structural.
 *   402 INSUFFICIENT_CREDITS  — well-formed, but the account cannot cover it. Payment
 *                               Required is exactly what this is, and collapsing it
 *                               into 400 makes "you asked wrong" and "you need to top
 *                               up" indistinguishable to a client that must react
 *                               differently to each.
 *   403 DAILY_CAP_EXCEEDED    — the role's budget refuses it. Not 402: the tenant HAS
 *                               the credits; this requester may not spend them.
 *   404 *_NOT_FOUND           — no such capability, request or account.
 *   409 APPROVAL_REQUIRED /   — the resource exists and the request is well-formed,
 *       SETTLEMENT_CONFLICT /   but its STATE refuses the transition.
 *       NOT_AWAITING_APPROVAL
 *   422 VALIDATION_ERROR      — well-formed but the CONTENT is refused (a policy that
 *                               claims a cap and carries none).
 *
 * Guarded with sdk-identity's requireAuth; the gateway's default-deny gate also
 * accepts a scoped API key, deriving data-credits.<resource>.<action> from the path.
 */

interface ErrorBody {
  error: string;
  code: string;
  details: string[];
}

const fail = (reply: FastifyReply, status: number, code: string, message: string): void => {
  const body: ErrorBody = {
    error: status === 404 ? 'NotFound' : status === 409 ? 'Conflict' : 'RequestRefused',
    code,
    details: [message],
  };
  reply.code(status).send(body);
};

function tenantOf(req: FastifyRequest, reply: FastifyReply): string | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = (req.query ?? {}) as Record<string, unknown>;
  const claimed = req.auth?.tenant_id;
  const named =
    (typeof body.tenant_id === 'string' && body.tenant_id.trim()) ||
    (typeof query.tenant_id === 'string' && query.tenant_id.trim()) ||
    '';

  // The credential wins when it carries a tenant; a payload naming a different one is
  // refused rather than silently preferred either way, so a misconfigured caller fails
  // loudly instead of reading somebody else's ledger.
  if (claimed && named && named !== claimed) {
    fail(reply, 403, 'TENANT_MISMATCH', 'tenant_id does not match the authenticated tenant');
    return null;
  }
  const tenant_id = claimed || named;
  if (!tenant_id) {
    fail(reply, 400, 'VALIDATION_ERROR', 'tenant_id is required');
    return null;
  }
  return tenant_id;
}

const SETTLEMENT_OUTCOMES: SettlementOutcome[] = [
  'MATCHED', 'NO_MATCH', 'TECHNICAL_FAILURE', 'CACHE_HIT',
];
const BUDGET_MODES: BudgetMode[] = ['REQUEST_ONLY', 'DAILY_CAP', 'FULL'];

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const guarded = { preHandler: requireAuth };

  /** Maps a domain error to the status its api_definition promises. */
  const wrap =
    (handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        await handler(req, reply);
      } catch (err) {
        if (err instanceof UnknownCapability) {
          fail(reply, 404, err.code, err.message); return;
        }
        if (err instanceof UnknownRequest) {
          fail(reply, 404, err.code, err.message); return;
        }
        if (err instanceof NoCreditAccount) {
          fail(reply, 404, err.code, err.message); return;
        }
        if (err instanceof InsufficientCredits) {
          fail(reply, 402, err.code, err.message); return;
        }
        if (err instanceof DailyCapExceeded) {
          fail(reply, 403, err.code, err.message); return;
        }
        if (err instanceof ApprovalRequired || err instanceof NotAwaitingApproval) {
          fail(reply, 409, err.code, err.message); return;
        }
        if (err instanceof SettlementConflict) {
          fail(reply, 409, err.code, err.message); return;
        }
        if (err instanceof BudgetPolicyInvalid) {
          fail(reply, 422, 'VALIDATION_ERROR', err.message); return;
        }
        // Nothing else is shaped for a tenant. The log gets the detail — which may
        // name a vendor — and the response gets none of it.
        req.log.error(err);
        if (!reply.sent) {
          reply.code(500).send({ error: 'InternalError', code: 'INTERNAL_ERROR', details: [] });
        }
      }
    };

  /* ------------------------------------------------------- the catalog */

  app.get('/api/capabilities', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    // Outcome and price. The provider chain behind each of these is not represented
    // in this response at all — there is no field to omit, because the view is built
    // by naming what a tenant may see.
    reply.code(200).send({ data: { capabilities: await listCapabilities(tenant_id) } });
  }));

  app.get('/api/capabilities/estimate', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const q = (req.query ?? {}) as Record<string, unknown>;
    if (typeof q.capability_key !== 'string' || !q.capability_key.trim()) {
      fail(reply, 400, 'VALIDATION_ERROR', 'capability_key is required'); return;
    }
    reply.code(200).send({ data: await estimate(tenant_id, q.capability_key.trim()) });
  }));

  /* --------------------------------------------------- capability requests */

  app.post('/api/capability-requests', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.capability_key !== 'string' || !b.capability_key.trim()) {
      fail(reply, 400, 'VALIDATION_ERROR', 'capability_key is required'); return;
    }
    if (typeof b.subject_fingerprint !== 'string' || !b.subject_fingerprint.trim()) {
      // The FINGERPRINT, never the raw subject: a table of everything every tenant
      // ever looked up is a breach waiting for an excuse.
      fail(reply, 400, 'VALIDATION_ERROR', 'subject_fingerprint is required'); return;
    }
    const held = await reserve({
      tenant_id,
      capability_key: b.capability_key.trim(),
      subject_fingerprint: b.subject_fingerprint.trim(),
      requested_by_persona_id:
        typeof b.requested_by_persona_id === 'string' ? b.requested_by_persona_id : undefined,
      role_ref: typeof b.role_ref === 'string' ? b.role_ref : undefined,
      metadata: (b.metadata ?? undefined) as Record<string, unknown> | undefined,
    });
    reply.code(201).send({ data: held });
  }));

  app.get('/api/capability-requests', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const q = (req.query ?? {}) as Record<string, unknown>;
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 500);
    const rows = await dataService.rows<{
      request_id: string; capability_key: string; status: string; outcome: string | null;
      served_from_cache: boolean; created_at: Date; estimated_credits: string | null;
      settled_credits: string | null;
    }>(
      `SELECT r.request_id, c.key AS capability_key, r.status, r.outcome,
              r.served_from_cache, r.created_at,
              res.estimated_credits::text, res.settled_credits::text
         FROM data_credits.capability_request r
         JOIN data_credits.capability c ON c.capability_id = r.capability_id
         LEFT JOIN data_credits.reservation res ON res.request_id = r.request_id
        WHERE r.tenant_id = $1
          AND ($2::text IS NULL OR r.status = $2::data_credits.request_status)
        ORDER BY r.created_at DESC
        LIMIT ${limit}`,
      [tenant_id, typeof q.status === 'string' && q.status ? q.status : null],
    );
    reply.code(200).send({
      data: {
        requests: rows.map((r) => ({
          request_id: r.request_id,
          capability_key: r.capability_key,
          status: r.status,
          outcome: r.outcome,
          served_from_cache: r.served_from_cache,
          credits_reserved: Number(r.estimated_credits ?? 0),
          credits_charged: Number(r.settled_credits ?? 0),
          created_at: new Date(r.created_at).toISOString(),
        })),
      },
    });
  }));

  app.get('/api/capability-requests/:request_id', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const { request_id } = req.params as { request_id: string };
    reply.code(200).send({ data: await getRequest(tenant_id, request_id) });
  }));

  app.post('/api/capability-requests/:request_id/approve', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const { request_id } = req.params as { request_id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    // A decision may be an approval or a refusal, and a refusal MUST give the held
    // credits back — an endpoint that could only approve would leave every refused
    // request holding the tenant's balance forever.
    if (b.approved === false) {
      const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
      if (!reason) {
        fail(reply, 400, 'VALIDATION_ERROR', 'a refusal must carry a reason'); return;
      }
      reply.code(200).send({
        data: await rejectRequest({
          tenant_id, request_id, reason,
          decided_by: typeof b.decided_by === 'string' ? b.decided_by : undefined,
        }),
      });
      return;
    }
    reply.code(200).send({
      data: await approveRequest({
        tenant_id,
        request_id,
        approval_ref: typeof b.approval_ref === 'string' ? b.approval_ref : undefined,
        decided_by: typeof b.decided_by === 'string' ? b.decided_by : undefined,
      }),
    });
  }));

  app.post('/api/capability-requests/:request_id/execute', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const { request_id } = req.params as { request_id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    // `subject` is the raw value the provider needs and is NOT stored — the request
    // keeps only the fingerprint.
    reply.code(200).send({
      data: await execute({ tenant_id, request_id, subject: b.subject }),
    });
  }));

  /* --------------------------------------------------------- credits */

  app.get('/api/credits/balance', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    reply.code(200).send({ data: await getBalance(tenant_id) });
  }));

  /**
   * The MANUAL lane: hold credits for a capability the caller will execute and settle
   * itself. Distinct from POST /api/capability-requests + /execute, which is the
   * brokered lane — there the broker chooses the provider and settles for you. Both
   * hold credits the same way, and both settle through the same rules; what differs is
   * who performs the lookup.
   */
  app.post('/api/credits/reservations', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.capability_key !== 'string' || !b.capability_key.trim()) {
      fail(reply, 400, 'VALIDATION_ERROR', 'capability_key is required'); return;
    }
    if (typeof b.subject_fingerprint !== 'string' || !b.subject_fingerprint.trim()) {
      fail(reply, 400, 'VALIDATION_ERROR', 'subject_fingerprint is required'); return;
    }
    const held = await reserve({
      tenant_id,
      capability_key: b.capability_key.trim(),
      subject_fingerprint: b.subject_fingerprint.trim(),
      role_ref: typeof b.role_ref === 'string' ? b.role_ref : undefined,
      requested_by_persona_id:
        typeof b.requested_by_persona_id === 'string' ? b.requested_by_persona_id : undefined,
      metadata: (b.metadata ?? undefined) as Record<string, unknown> | undefined,
    });
    const balance = await getBalance(tenant_id);
    reply.code(201).send({ data: { ...held, balance } });
  }));

  app.post('/api/credits/reservations/:reservation_id/settle', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const { reservation_id } = req.params as { reservation_id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const outcome = b.outcome as SettlementOutcome;
    if (!SETTLEMENT_OUTCOMES.includes(outcome)) {
      fail(reply, 400, 'VALIDATION_ERROR',
        `outcome must be one of ${SETTLEMENT_OUTCOMES.join(', ')}`);
      return;
    }
    const row = await dataService.one<{ request_id: string }>(
      `SELECT request_id FROM data_credits.reservation
        WHERE reservation_id = $1 AND tenant_id = $2`,
      [reservation_id, tenant_id],
    );
    if (!row) {
      fail(reply, 404, 'RESERVATION_NOT_FOUND', `no reservation ${reservation_id}`); return;
    }
    reply.code(200).send({
      data: await settle({
        tenant_id,
        request_id: row.request_id,
        outcome,
        result: b.result ?? null,
      }),
    });
  }));

  app.get('/api/credits/ledger', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const q = (req.query ?? {}) as Record<string, unknown>;
    const entries = await listLedger({
      tenant_id,
      request_id: typeof q.request_id === 'string' && q.request_id ? q.request_id : undefined,
      limit: Number(q.limit ?? 100) || 100,
    });
    // Reservation, charge and refund per request — the export a disputed invoice
    // needs, and the true vendor cost appears in none of it.
    reply.code(200).send({ data: { entries } });
  }));

  /* --------------------------------------------------------- budgets */

  app.put('/api/credits/budgets', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.role_ref !== 'string' || !b.role_ref.trim()) {
      fail(reply, 400, 'VALIDATION_ERROR', 'role_ref is required'); return;
    }
    if (!BUDGET_MODES.includes(b.mode as BudgetMode)) {
      fail(reply, 400, 'VALIDATION_ERROR', `mode must be one of ${BUDGET_MODES.join(', ')}`);
      return;
    }
    const policy = await upsertBudgetPolicy({
      tenant_id,
      role_ref: b.role_ref.trim(),
      mode: b.mode as BudgetMode,
      daily_cap: b.daily_cap === undefined ? undefined : (b.daily_cap as number | null),
      bulk_approval_threshold:
        b.bulk_approval_threshold === undefined
          ? undefined
          : (b.bulk_approval_threshold as number | null),
      is_active: typeof b.is_active === 'boolean' ? b.is_active : undefined,
    });
    // Upsert -> 200, not 201: the caller names the role, so the same call twice is the
    // same policy rather than a second one.
    reply.code(200).send({ data: policy });
  }));

  app.get('/api/credits/budgets', guarded, wrap(async (req, reply) => {
    const tenant_id = tenantOf(req, reply);
    if (!tenant_id) return;
    reply.code(200).send({ data: { policies: await listBudgetPolicies(tenant_id) } });
  }));
}
