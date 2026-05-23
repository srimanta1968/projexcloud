// Known-bad: imports sdk-persona from a non-resolver SDK.
// OC-4 (P3 tightening per AC-6) must flag this — sdk-persona is now
// resolver-only; everyone else must go through sdk-identity-resolver.
//
// Path is intentional: lives under packages/sdk-fake-consumer/ within the
// fixture tree so OC-4's self-match regex `/packages\/(sdk-[^/]+)\//` treats
// the file as the SDK "sdk-fake-consumer" (which is NOT in RESOLVER_ONLY's
// sdk-persona allowlist).
import { types as _personaTypes } from '@projexlight/sdk-persona';
export const x = _personaTypes;
