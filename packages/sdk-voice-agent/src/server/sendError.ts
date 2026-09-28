import type { FastifyReply } from 'fastify';
import { VoiceAgentError } from '../models/errors';

/** Sends a VoiceAgentError as { error, details }; rethrows anything else to the gateway. */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof VoiceAgentError) {
    return reply.code(err.status).send({ error: err.code, details: [err.message] });
  }
  throw err;
}
