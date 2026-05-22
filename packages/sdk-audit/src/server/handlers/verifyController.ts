import { FastifyReply, FastifyRequest } from 'fastify';
import { verifyChain } from '../../services/chainVerifier';

interface VerifyBody {
  pool_index?: string;
  from_seq?: number;
  to_seq?: number;
}

/**
 * POST /api/audit/verify — on-demand chain verification for a pool. Returns
 * the canonical proof object per P1-Foundation-Spine §7. Requires authn.
 */
export async function verifyHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const body = (req.body ?? {}) as VerifyBody;
    const pool_index = typeof body.pool_index === 'string' ? body.pool_index.trim() : '';
    if (!pool_index) {
      reply.code(400).send({
        error: 'ValidationError',
        details: ['pool_index is required'],
      });
      return;
    }
    const proof = await verifyChain({
      pool_index,
      from_seq: typeof body.from_seq === 'number' ? body.from_seq : undefined,
      to_seq: typeof body.to_seq === 'number' ? body.to_seq : undefined,
    });
    reply.code(proof.ok ? 200 : 409).send({ data: proof });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ error: 'InternalError' });
  }
}
