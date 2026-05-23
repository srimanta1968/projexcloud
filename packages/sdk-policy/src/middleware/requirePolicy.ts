import { FastifyReply, FastifyRequest } from 'fastify';
import { evaluatePolicy } from '../services/policyService';

/**
 * FR-POL-2: per-service guard middleware.
 *
 * Usage:
 *   app.get('/api/charts/:id', {
 *     preHandler: requirePolicy('pol_doctor_chart_read', {
 *       subject: (req) => req.auth?.sub,
 *       target:  (req) => req.params.id,
 *       context: (req) => ({ projection_version: 0, ... }),
 *     })
 *   }, handler);
 *
 * The middleware:
 *   1. Resolves subject_id (defaults to req.auth.sub from the JWT).
 *   2. Optionally resolves target_id + context from the request.
 *   3. Calls evaluatePolicy() — which checks the precomp cache first.
 *   4. Returns 403 with the policy + reason on DENY; attaches the result to
 *      req.policyDecision on ALLOW so downstream handlers can read context.
 *
 * Because evaluatePolicy() writes to policy.decision and emits
 * policy.evaluated.v1 to audit, this middleware is also the audit fan-out
 * trigger for every guarded route.
 */

declare module 'fastify' {
  interface FastifyRequest {
    policyDecision?: {
      decision: 'ALLOW' | 'DENY';
      reason: string;
      cached: boolean;
    };
  }
}

export interface RequirePolicyOptions {
  /** Resolves the subject_id. Defaults to req.auth.sub from the JWT. */
  subject?: (req: FastifyRequest) => string | undefined;
  /** Optional target resource identifier (e.g. chart_id, encounter_id). */
  target?: (req: FastifyRequest) => string | undefined;
  /** Extra context handed to the IQL/Cedar evaluator. */
  context?: (req: FastifyRequest) => Record<string, unknown>;
}

export function requirePolicy(policy_id: string, opts: RequirePolicyOptions = {}) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const subject_id = opts.subject ? opts.subject(req) : req.auth?.sub;
    if (!subject_id) {
      reply.code(401).send({
        error: 'Unauthorized',
        details: ['No subject_id resolved (Bearer JWT missing or invalid)'],
      });
      return;
    }
    const target_id = opts.target?.(req);
    const context = opts.context?.(req) ?? {};

    try {
      const result = await evaluatePolicy({ policy_id, subject_id, target_id, context });
      req.policyDecision = { decision: result.decision, reason: result.reason, cached: result.cached };
      if (result.decision === 'DENY') {
        reply.code(403).send({
          error: 'Forbidden',
          details: [result.reason],
          policy_id,
          layers_used: result.layers_used,
        });
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('not found')) {
        reply.code(500).send({
          error: 'PolicyMisconfigured',
          details: [`Policy ${policy_id} not found - admin needs to create it`],
        });
        return;
      }
      req.log.error(err);
      reply.code(500).send({ error: 'InternalError' });
    }
  };
}
