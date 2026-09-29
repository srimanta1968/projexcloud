import type { FastifyReply } from 'fastify';
import { DialerError } from '../models/errors';

/** Sends a DialerError as { error, details }; rethrows anything else to the gateway. */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof DialerError) {
    return reply.code(err.status).send({ error: err.code, details: [err.message] });
  }
  throw err;
}
