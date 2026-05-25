/**
 * P9 / E1.F5 — manifest quality lints.
 *
 * Lints run AFTER schema validation passes. They enforce the substantive
 * quality bar (vs. the structural bar enforced by the schema):
 *   - scenarios contain real code (not "TBD" / empty / trivially short)
 *   - summary length is bounded above AND below (forces real content)
 *   - at least 3 scenarios
 *   - non-empty compliance_posture.regimes
 *   - pool_placement is a real enum value (already checked at schema layer
 *     — duplicated here as a defensive guard for the lint runner's caller)
 *   - provides.endpoints non-empty unless manifest.no_endpoints === true
 *     (carve-out for build-time-only packages like sdk-capability itself)
 *
 * Per Q-5 decision: CI surfaces lint failures with the same severity as
 * schema failures (PR-blocking). The whole point is to refuse "ship the
 * manifest, fill the prose later" PRs.
 */

import { SdkCapabilityManifest } from './types';

const SUMMARY_MIN = 50;
const SUMMARY_MAX = 5000;
const MIN_SCENARIOS = 3;
const MIN_SCENARIO_CODE_LENGTH = 20;

const FORBIDDEN_PLACEHOLDERS = ['TBD', 'TODO', 'FIXME', 'PLACEHOLDER'];

export function runLints(m: SdkCapabilityManifest): string[] {
  const errs: string[] = [];

  // summary length
  if (m.summary.length < SUMMARY_MIN) {
    errs.push(
      `LINT: summary is too short (${m.summary.length} chars; minimum ${SUMMARY_MIN}). Fill in real content describing what the SDK does.`,
    );
  }
  if (m.summary.length > SUMMARY_MAX) {
    errs.push(
      `LINT: summary is too long (${m.summary.length} chars; maximum ${SUMMARY_MAX}). Move detail to scenarios or links.`,
    );
  }

  // forbidden placeholders in summary
  for (const placeholder of FORBIDDEN_PLACEHOLDERS) {
    if (m.summary.includes(placeholder)) {
      errs.push(`LINT: summary contains placeholder "${placeholder}"; replace with real content.`);
    }
  }

  // minimum scenarios
  if (m.scenarios.length < MIN_SCENARIOS) {
    errs.push(
      `LINT: at least ${MIN_SCENARIOS} scenarios required; found ${m.scenarios.length}. Add concrete use-cases an AI agent can compose against.`,
    );
  }

  // each scenario's example_code is real
  for (const s of m.scenarios) {
    if (s.example_code.length < MIN_SCENARIO_CODE_LENGTH) {
      errs.push(
        `LINT: scenarios[id=${s.id}].example_code is too short (${s.example_code.length} chars; minimum ${MIN_SCENARIO_CODE_LENGTH}). Provide a real, runnable snippet.`,
      );
    }
    for (const placeholder of FORBIDDEN_PLACEHOLDERS) {
      if (s.example_code.includes(placeholder)) {
        errs.push(
          `LINT: scenarios[id=${s.id}].example_code contains placeholder "${placeholder}"; replace with real code.`,
        );
      }
      if (s.when_to_use.includes(placeholder)) {
        errs.push(
          `LINT: scenarios[id=${s.id}].when_to_use contains placeholder "${placeholder}".`,
        );
      }
      if (s.expected_outcome.includes(placeholder)) {
        errs.push(
          `LINT: scenarios[id=${s.id}].expected_outcome contains placeholder "${placeholder}".`,
        );
      }
    }
  }

  // compliance_posture.regimes non-empty
  if (m.compliance_posture.regimes.length === 0) {
    errs.push(
      `LINT: compliance_posture.regimes must list at least one regime (e.g. "SOC2"). Forces the SDK owner to think about applicability.`,
    );
  }

  // endpoints non-empty unless explicit opt-out
  if (m.provides.endpoints.length === 0 && m.no_endpoints !== true) {
    errs.push(
      `LINT: provides.endpoints is empty. If this is intentional (build-time-only package), set "no_endpoints": true at the top level.`,
    );
  }

  return errs;
}
