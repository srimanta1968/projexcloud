/**
 * Webhook URL validator hook (G-P8-6).
 *
 * sdk-webhook stays SDK-only — no on-prem / air-gap awareness. sdk-onprem
 * registers a validator at boot that knows about the per-install air-gap
 * mode and the webhook.endpoint.in_cluster_only flag.
 *
 * The default validator allows all https:// URLs. registerEndpoint() in
 * endpointRegistry.ts calls the validator BEFORE the DB insert so the
 * client gets a clean 400 instead of an opaque CHECK violation.
 */

export interface UrlValidationResult {
  allowed: boolean;
  reason?: string;
}

export type ExternalUrlValidator = (input: {
  tenant_id: string;
  url: string;
}) => Promise<UrlValidationResult> | UrlValidationResult;

let _validator: ExternalUrlValidator = () => ({ allowed: true });

export function setExternalUrlValidator(validator: ExternalUrlValidator | null): void {
  _validator = validator ?? (() => ({ allowed: true }));
}

export async function validateExternalUrl(input: {
  tenant_id: string;
  url: string;
}): Promise<UrlValidationResult> {
  return _validator(input);
}

/** Test-only — reset to permissive default. */
export function _resetExternalUrlValidator(): void {
  _validator = () => ({ allowed: true });
}
