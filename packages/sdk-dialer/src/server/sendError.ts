import type { FastifyReply } from 'fastify';
import { VoiceAgentError } from '@projexlight/sdk-voice-agent';
import { DialerError } from '../models/errors';

/**
 * Sends a DialerError — or a VoiceAgentError from a placeCall the dialer made on the
 * caller's behalf — as { error, details }; rethrows anything else to the gateway.
 */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof DialerError || err instanceof VoiceAgentError) {
    return reply.code(err.status).send({ error: err.code, details: [err.message] });
  }
  throw err;
}
