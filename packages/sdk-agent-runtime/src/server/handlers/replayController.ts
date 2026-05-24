import { FastifyReply, FastifyRequest } from 'fastify';
import { replayRun, type ReplayOptions } from '../../services/replayEngine';

interface RunIdParams {
  run_id: string;
}

interface ReplayBody {
  current_model_snapshot_id?: string;
  dryRun?: boolean;
}

/**
 * POST /api/agent-runtime/runs/:run_id/replay — triggers deterministic
 * replay. Returns the verdict body: { kind: 'matched' | 'snapshot-drift' |
 * 'diverged', ... }. Gated by sku=agent-runtime.replay.
 */
export async function replayHandler(
  req: FastifyRequest<{ Params: RunIdParams; Body: ReplayBody }>,
  reply: FastifyReply,
): Promise<void> {
  const { run_id } = req.params;
  if (!run_id) {
    reply.code(400).send({ success: false, error: 'Missing path param: run_id' });
    return;
  }
  const opts: ReplayOptions = {
    current_model_snapshot_id: req.body?.current_model_snapshot_id,
    dryRun: req.body?.dryRun ?? true,
  };
  try {
    const verdict = await replayRun(run_id, opts);
    reply.code(200).send({ success: true, data: verdict });
  } catch (err) {
    req.log.error(err);
    const msg = (err as Error).message;
    if (msg.includes('not found') || msg.includes('no execution log entries')) {
      reply.code(404).send({ success: false, error: msg });
      return;
    }
    reply.code(500).send({ success: false, error: 'Replay failed' });
  }
}
