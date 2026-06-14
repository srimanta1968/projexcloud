// OC-11 known-bad fixture: a governed-data handler that reads an
// obligation-bearing decision but serializes RAW rows without enforcing the
// obligations (no applyObligations / enforceGovernedPayload / governedObligations).
// The OC-11 rule must flag this.

declare function evaluatePolicy(input: unknown): Promise<{ decision: string; obligations?: unknown }>;
declare function fetchPatientRows(): Promise<unknown[]>;

export async function getPatientsHandler(req: unknown, reply: { send: (b: unknown) => unknown }): Promise<unknown> {
  const decision = await evaluatePolicy({ policy_id: 'p', subject_id: 's' });
  const rows = await fetchPatientRows();
  // BUG: holds decision.obligations but ignores them and ships raw rows.
  if (decision.obligations) {
    // intentionally does nothing with the obligations
  }
  return reply.send({ data: rows });
}
