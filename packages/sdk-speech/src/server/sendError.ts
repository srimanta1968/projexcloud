import type { FastifyReply } from 'fastify';
import { SpeechError } from '../models/errors';

/** Sends a SpeechError as { error, details }; rethrows anything else to the gateway. */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof SpeechError) {
    return reply.code(err.status).send({ error: err.code, details: [err.message] });
  }
  throw err;
}
