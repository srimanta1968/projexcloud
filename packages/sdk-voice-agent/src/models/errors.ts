/**
 * A client-facing failure with the HTTP status and error code the routes return.
 * Codes reuse the project vocabulary (ValidationError, Forbidden, NotFound, Conflict)
 * and add CredentialInvalid for a stack profile pointing at a missing/revoked key.
 */
export class VoiceAgentError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VoiceAgentError';
  }
}

export const validationError = (message: string): VoiceAgentError => new VoiceAgentError(400, 'ValidationError', message);
export const notFound = (message: string): VoiceAgentError => new VoiceAgentError(404, 'NotFound', message);
export const conflict = (message: string): VoiceAgentError => new VoiceAgentError(409, 'Conflict', message);
