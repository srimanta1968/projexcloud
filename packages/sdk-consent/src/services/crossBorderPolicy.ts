/**
 * FR-CNS-5: cross-border policy enforcement hook.
 *
 * Validates that the requested processor jurisdiction is "adequate" for the
 * person's home region under GDPR-style residency rules. EU residents (whose
 * home_region is in the EEA) cannot have data processed in non-adequate
 * jurisdictions without explicit consent.
 *
 * The adequacy list mirrors the European Commission's published adequacy
 * decisions as of 2024; production deployments should load this from a
 * jurisdictional-policy source rather than hard-coding.
 */

const EEA_REGIONS = new Set([
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-central-2',
  'eu-north-1', 'eu-south-1', 'eu-south-2',
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
]);

/** GDPR adequacy decisions: jurisdictions where EU residents' data may
 * flow without further safeguards. */
const ADEQUATE_FOR_EEA = new Set([
  'AD', 'AR', 'CA', 'FO', 'GG', 'IL', 'IM', 'JP', 'JE', 'NZ', 'KR', 'CH', 'GB', 'UY',
  ...EEA_REGIONS,
]);

export interface CrossBorderCheckInput {
  person_home_region: string;
  processor_jurisdiction: string;
}

export interface CrossBorderCheckResult {
  allowed: boolean;
  reason: string;
}

/**
 * Pure-function check. Returns { allowed: true } when:
 *   - Both regions are non-EEA (no GDPR concern)
 *   - Person is in EEA AND processor jurisdiction is in the adequacy list
 *   - Person is NOT in EEA (other residency regimes — out of scope)
 *
 * Returns { allowed: false } only when the person is in EEA and the
 * processor jurisdiction is NOT in the adequacy list. Callers can override
 * by recording an explicit "cross-border" consent receipt.
 */
export function checkCrossBorder(input: CrossBorderCheckInput): CrossBorderCheckResult {
  const personInEea = EEA_REGIONS.has(input.person_home_region);
  if (!personInEea) {
    return { allowed: true, reason: 'person not subject to EEA residency rules' };
  }
  const processorAdequate = ADEQUATE_FOR_EEA.has(input.processor_jurisdiction);
  if (processorAdequate) {
    return { allowed: true, reason: 'processor jurisdiction has EEA adequacy decision' };
  }
  return {
    allowed: false,
    reason: `Person home region ${input.person_home_region} is in EEA; processor jurisdiction ${input.processor_jurisdiction} has no EU adequacy decision. Explicit cross-border consent required.`,
  };
}
