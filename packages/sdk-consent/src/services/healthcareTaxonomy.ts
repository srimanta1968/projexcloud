import { registerPurpose, checkConsent } from './consentService';
import type { CheckConsentInput, PurposeRecord, RegisterPurposeInput } from '../models/consent.model';

/**
 * P10/E3 — Healthcare purpose taxonomy: HIPAA Treatment/Payment/Operations
 * (+research/marketing) and 42 CFR Part 2 substance-use segmented consent.
 * Architecture v3.2 §11A.5 / §11A.10.
 */

/** HIPAA TPO + research/marketing purpose definitions (category 'hipaa_tpo'). */
export const HIPAA_TPO_PURPOSES: ReadonlyArray<{
  purpose_id: string;
  description: string;
  legal_basis: RegisterPurposeInput['legal_basis'];
}> = [
  // Treatment/Payment/Operations are HIPAA-permitted without separate authorization.
  { purpose_id: 'hipaa.treatment', description: 'Treatment (HIPAA TPO)', legal_basis: 'legal-obligation' },
  { purpose_id: 'hipaa.payment', description: 'Payment (HIPAA TPO)', legal_basis: 'legal-obligation' },
  { purpose_id: 'hipaa.operations', description: 'Health care operations (HIPAA TPO)', legal_basis: 'legal-obligation' },
  // Research + marketing REQUIRE explicit authorization (consent).
  { purpose_id: 'hipaa.research', description: 'Research use of PHI (requires authorization/IRB)', legal_basis: 'consent' },
  { purpose_id: 'hipaa.marketing', description: 'Marketing use of PHI (requires explicit authorization)', legal_basis: 'consent' },
];

/** 42 CFR Part 2 substance-use disorder purpose — segmented, dedicated consent. */
export const PART2_PURPOSE = {
  purpose_id: 'part2.substance_use',
  description: '42 CFR Part 2 substance-use disorder records (segmented consent)',
} as const;

/** Marketing purpose code — denied for PHI without explicit consent (fail closed). */
export const HIPAA_MARKETING_PURPOSE = 'hipaa.marketing';

/** True for a 42 CFR Part 2 segmented purpose. */
export function isPart2Purpose(purpose_id: string): boolean {
  return purpose_id === PART2_PURPOSE.purpose_id || purpose_id.startsWith('part2.');
}

/**
 * Registers the HIPAA TPO + research/marketing codes and the Part 2 segmented
 * purpose for an app. Idempotent: a purpose that already exists is skipped, so
 * this is safe to call on tenant provisioning or repeatedly at boot.
 */
export async function registerHealthcarePurposes(
  app_id: string,
  jurisdictions: string[] = ['US'],
): Promise<PurposeRecord[]> {
  const out: PurposeRecord[] = [];
  const defs: RegisterPurposeInput[] = [
    ...HIPAA_TPO_PURPOSES.map((p) => ({
      purpose_id: p.purpose_id,
      app_id,
      description: p.description,
      legal_basis: p.legal_basis,
      default_jurisdictions: jurisdictions,
      category: 'hipaa_tpo' as const,
      segmented: false,
    })),
    {
      purpose_id: PART2_PURPOSE.purpose_id,
      app_id,
      description: PART2_PURPOSE.description,
      legal_basis: 'consent',
      default_jurisdictions: jurisdictions,
      category: 'part2_substance_use' as const,
      segmented: true,
    },
  ];
  for (const def of defs) {
    try {
      out.push(await registerPurpose(def));
    } catch (err) {
      // Idempotent: ignore PK/unique violation for an already-registered purpose.
      if (!/duplicate key|unique/i.test((err as Error).message)) throw err;
    }
  }
  return out;
}

/**
 * Enforces 42 CFR Part 2 segmented consent: accessing substance-use records
 * requires a DEDICATED active consent for the Part 2 purpose — general PHI/TPO
 * consent does NOT satisfy it. Throws when the segmented consent is absent
 * (fail closed); the caller maps this to a denial.
 */
export async function assertPart2Consent(
  input: Omit<CheckConsentInput, 'purpose_id'> & { purpose_id?: string },
): Promise<void> {
  const purpose_id = input.purpose_id ?? PART2_PURPOSE.purpose_id;
  if (!isPart2Purpose(purpose_id)) {
    throw new Error(`assertPart2Consent requires a Part 2 purpose, got '${purpose_id}'`);
  }
  const result = await checkConsent({
    person_id: input.person_id,
    purpose_id,
    processor: input.processor,
    jurisdiction: input.jurisdiction,
  });
  if (!result.granted) {
    throw new Error(`42 CFR Part 2: segmented consent absent for purpose '${purpose_id}'`);
  }
}
