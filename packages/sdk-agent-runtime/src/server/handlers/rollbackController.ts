import { FastifyReply, FastifyRequest } from 'fastify';
import { rollbackRun } from '../../services/actionJournal';

interface RunIdParams {
  run_id: string;
}

interface RollbackQuery {
  to_seq?: string;
}

interface RollbackBody {
  reason?: string;
  actor_id?: string;
}

/**
 * POST /api/agent-runtime/runs/:run_id/rollback?to_seq=N — replays the
 * action journal in reverse from the latest step down to `to_seq`,
 * invoking each registered compensation handler. Default to_seq=-1 rolls
 * back the entire run. Returns RollbackSummary with per-step outcomes.
 * Gated by sku=agent-runtime.replay.
 */
export async function rollbackHandler(
  req: FastifyRequest<{
    Params: RunIdParams;
    Querystring: RollbackQuery;
    Body: RollbackBody;
  }>,
  reply: FastifyReply,
): Promise<void> {
  const { run_id } = req.params;
  if (!run_id) {
    reply.code(400).send({ success: false, error: 'Missing path param: run_id' });
    return;
  }
  let toSeq = -1;
  if (req.query?.to_seq !== undefined) {
    const parsed = parseInt(req.query.to_seq, 10);
    if (Number.isNaN(parsed) || parsed < -1) {
      reply.code(400).send({ success: false, error: 'to_seq must be an integer >= -1' });
      return;
    }
    toSeq = parsed;
  }
  const actor = req.auth?.sub ?? req.body?.actor_id ?? 'system';
  try {
    const summary = await rollbackRun({ run_id, to_seq: toSeq, actor_id: actor });
    reply.code(200).send({ success: true, data: summary });
  } catch (err) {
    req.log.error(err);
    reply.code(500).send({ success: false, error: 'Rollback failed' });
  }
}
