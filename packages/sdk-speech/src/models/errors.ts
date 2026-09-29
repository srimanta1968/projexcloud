/**
 * A client-facing failure with the HTTP status and error code the routes return.
 * Codes reuse the project vocabulary (ValidationError, NotFound, Conflict) so
 * consumers handle speech errors like every other SDK's.
 */
export class SpeechError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SpeechError';
  }
}

export const validationError = (message: string): SpeechError => new SpeechError(400, 'ValidationError', message);
export const notFound = (message: string): SpeechError => new SpeechError(404, 'NotFound', message);
export const conflict = (message: string): SpeechError => new SpeechError(409, 'Conflict', message);
