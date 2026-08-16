/**
 * "Can this address receive mail?", asked at registration — through a seam.
 *
 * WHY A SEAM AND NOT AN IMPORT. sdk-deliverability depends on sdk-identity for
 * requireAuth, so sdk-identity importing sdk-deliverability would close a cycle.
 * This is the same problem the verification email already has, and it is solved
 * the same way: the SDK declares what it needs, the gateway wires the
 * implementation in (services/api-gateway/src/app.ts).
 *
 * DEFAULT IS ALLOW. With no checker installed — a test harness, an embedder that
 * mounts identity alone — registration behaves exactly as it did before this
 * existed. A seam that failed closed by default would turn "nobody wired it" into
 * "nobody can sign up".
 *
 * WHY REGISTRATION IS THE RIGHT PLACE. An account here is not usable until its
 * address is verified, and the address is verified by clicking a link that is
 * sent to it. An address that cannot receive mail therefore cannot ever complete
 * registration: the person would fill in the form, be told to check an inbox
 * that will never receive anything, and have no way forward and no explanation.
 * Refusing at the form — naming the domain, offering the correction — is the
 * only point at which the problem is still fixable by the person who made it.
 */

export interface AddressCheckResult {
  /** False only when the address is PROVEN unable to receive mail. */
  allowed: boolean;
  /** A sentence for the person who typed it. Present whenever allowed is false. */
  reason: string | null;
  /** deliverable | undeliverable | risky | unknown */
  verdict: string;
  /** The machine code, e.g. DOMAIN_NOT_FOUND. */
  code: string;
  /** A correction to offer, never one to apply. */
  didYouMean?: string | null;
}

export type AddressChecker = (address: string) => Promise<AddressCheckResult>;

const allowEverything: AddressChecker = async () => ({
  allowed: true, reason: null, verdict: 'unknown', code: 'NO_CHECKER_INSTALLED', didYouMean: null,
});

let _checker: AddressChecker = allowEverything;

/** Install the checker. Called once by the gateway at boot. */
export function setAddressChecker(checker: AddressChecker): void {
  _checker = checker;
}

/** Restore the default (allow everything). For tests. */
export function resetAddressChecker(): void {
  _checker = allowEverything;
}

/**
 * Ask whether registration may proceed with this address.
 *
 * NEVER THROWS AND NEVER REJECTS. A checker that fails is a checker that has
 * told us nothing, and "we could not check" must not read as "this address is
 * bad" — that would turn a DNS blip into an outage of sign-up.
 */
export async function checkRegistrationAddress(address: string): Promise<AddressCheckResult> {
  try {
    return await _checker(address);
  } catch {
    return { allowed: true, reason: null, verdict: 'unknown', code: 'CHECK_FAILED', didYouMean: null };
  }
}

/**
 * Is a verified address required before an account can be used?
 *
 * OFF BY DEFAULT, and that default is load-bearing rather than timid. Turning it
 * on refuses every EXISTING unverified account at the next login, and the API
 * test suite registers at synthetic domains and signs in immediately. It is a
 * deployment decision with a blast radius, so it is made in .env.prod
 * (EMAIL_VERIFICATION_REQUIRED=true) and never inherited from a code default.
 */
export function emailVerificationRequired(): boolean {
  return (process.env.EMAIL_VERIFICATION_REQUIRED || '').trim().toLowerCase() === 'true';
}
