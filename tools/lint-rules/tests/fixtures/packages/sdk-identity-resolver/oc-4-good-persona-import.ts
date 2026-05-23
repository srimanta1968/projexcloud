// Known-good: sdk-identity-resolver IS allowed to import sdk-persona (it's
// the sole resolver-only consumer per the OC-4 RESOLVER_ONLY allowlist that
// closes AC-6).
import { types as _personaTypes } from '@projexlight/sdk-persona';
export const x = _personaTypes;
