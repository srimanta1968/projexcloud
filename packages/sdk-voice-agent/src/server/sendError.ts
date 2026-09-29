import type { FastifyReply } from 'fastify';
import { SpeechError } from '@projexlight/sdk-speech';
import { VoiceAgentError } from '../models/errors';

/**
 * Sends a VoiceAgentError — or a SpeechError from the speech catalog / cost estimator a
 * voice-agent route called — as { error, details }; rethrows anything else to the gateway.
 */
export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof VoiceAgentError || err instanceof SpeechError) {
    return reply.code(err.status).send({ error: err.code, details: [err.message] });
  }
  throw err;
}
