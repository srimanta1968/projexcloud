/**
 * A client-facing failure with the HTTP status and error code the routes return.
 * Codes reuse the project vocabulary (ValidationError, NotFound, Conflict,
 * InvalidTransition) so consumers handle dialer errors like every other SDK's.
 */
export class DialerError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DialerError';
  }
}

export const validationError = (message: string): DialerError => new DialerError(400, 'ValidationError', message);
export const notFound = (message: string): DialerError => new DialerError(404, 'NotFound', message);
export const conflict = (message: string): DialerError => new DialerError(409, 'Conflict', message);
export const invalidTransition = (message: string): DialerError => new DialerError(409, 'InvalidTransition', message);
