import { dataService } from '@projexlight/db-runtime';

/**
 * Who may spend, how much, and who has to ask first.
 *
 * Three modes, and a threshold that outranks all of them:
 *
 *   REQUEST_ONLY — every request waits for an approval decision.
 *   DAILY_CAP    — spend freely up to a limit over a rolling 24 hours.
 *   FULL         — spend freely.
 *   bulk_approval_threshold — a single request at or above this needs approval
 *                  REGARDLESS of mode, including FULL. The point of a bulk gate is
 *                  that one enormous request is a different decision from the
 *                  thousand small ones the role was trusted with; a role-based rule
 *                  alone cannot see the difference.
 *
 * A role with NO policy requires approval. Absent policy could plausibly mean either
 * "not configured yet" or "no restriction", and the two are indistinguishable from
 * here — so this fails CLOSED, but not shut: an unknown role is not trusted with the
 * balance, it is asked. Refusing outright would make a missing row look like a bug in
 * the broker; auto-approving would make it look like nothing at all, right up until
 * the invoice.
 *
 * The DAILY_CAP window is ROLLING, not calendar. A calendar day resets at a moment
 * somebody has to pick a timezone for, and a tenant in the wrong one gets two days of
 * spend inside one of their working days.
 */

export type BudgetMode = 'REQUEST_ONLY' | 'DAILY_CAP' | 'FULL';

export interface BudgetPolicy {
  policy_id: string;
  tenant_id: string;
  role_ref: string;
  mode: BudgetMode;
  daily_cap: number | null;
  bulk_approval_threshold: number | null;
  is_active: boolean;
}

export class BudgetPolicyInvalid extends Error {
  readonly code = 'BUDGET_POLICY_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'BudgetPolicyInvalid';
  }
}

export class DailyCapExceeded extends Error {
  readonly code = 'DAILY_CAP_EXCEEDED';
  constructor(
    readonly spent: number,
    readonly cap: number,
    readonly requested: number,
  ) {
    super(
      `this role has spent ${spent} of ${cap} credits in the last 24 hours; ` +
        `${requested} more would exceed the cap`,
    );
    this.name = 'DailyCapExceeded';
  }
}

const POLICY_COLS = `policy_id, tenant_id, role_ref, mode, daily_cap::text AS daily_cap,
       bulk_approval_threshold::text AS bulk_approval_threshold, is_active`;

interface PolicyRow extends Omit<BudgetPolicy, 'daily_cap' | 'bulk_approval_threshold'> {
  daily_cap: string | null;
  bulk_approval_threshold: string | null;
}

const toPolicy = (row: PolicyRow): BudgetPolicy => ({
  policy_id: row.policy_id,
  tenant_id: row.tenant_id,
  role_ref: row.role_ref,
  mode: row.mode,
  daily_cap: row.daily_cap === null ? null : Number(row.daily_cap),
  bulk_approval_threshold:
    row.bulk_approval_threshold === null ? null : Number(row.bulk_approval_threshold),
  is_active: row.is_active,
});

export interface UpsertPolicyInput {
  tenant_id: string;
  role_ref: string;
  mode: BudgetMode;
  daily_cap?: number | null;
  bulk_approval_threshold?: number | null;
  is_active?: boolean;
}

export async function upsertBudgetPolicy(input: UpsertPolicyInput): Promise<BudgetPolicy> {
  if (input.mode === 'DAILY_CAP' && (input.daily_cap === undefined || input.daily_cap === null)) {
    // The database refuses this too. Checked here so the caller gets a sentence: a
    // policy that reads as a limit and enforces nothing is worse than no policy,
    // because the dashboard says "capped" and the spend says otherwise.
    throw new BudgetPolicyInvalid('a DAILY_CAP policy must carry a daily_cap');
  }
  for (const [name, value] of [
    ['daily_cap', input.daily_cap], ['bulk_approval_threshold', input.bulk_approval_threshold],
  ] as const) {
    if (value !== undefined && value !== null && !(Number.isFinite(value) && value >= 0)) {
      throw new BudgetPolicyInvalid(`${name} must be a non-negative number`);
    }
  }

  const row = await dataService.one<PolicyRow>(
    `INSERT INTO data_credits.budget_policy
        (tenant_id, role_ref, mode, daily_cap, bulk_approval_threshold, is_active)
     VALUES ($1, $2, $3::data_credits.budget_mode, $4, $5, COALESCE($6, true))
     ON CONFLICT (tenant_id, role_ref)
     DO UPDATE SET mode = EXCLUDED.mode,
                   daily_cap = EXCLUDED.daily_cap,
                   bulk_approval_threshold = EXCLUDED.bulk_approval_threshold,
                   is_active = EXCLUDED.is_active
     RETURNING ${POLICY_COLS}`,
    [
      input.tenant_id, input.role_ref, input.mode,
      input.daily_cap ?? null, input.bulk_approval_threshold ?? null,
      input.is_active ?? null,
    ],
  );
  return toPolicy(row as PolicyRow);
}

export async function getBudgetPolicy(
  tenant_id: string, role_ref: string,
): Promise<BudgetPolicy | null> {
  const row = await dataService.one<PolicyRow>(
    `SELECT ${POLICY_COLS} FROM data_credits.budget_policy
      WHERE tenant_id = $1 AND role_ref = $2 AND is_active`,
    [tenant_id, role_ref],
  );
  return row ? toPolicy(row) : null;
}

export async function listBudgetPolicies(tenant_id: string): Promise<BudgetPolicy[]> {
  const rows = await dataService.rows<PolicyRow>(
    `SELECT ${POLICY_COLS} FROM data_credits.budget_policy
      WHERE tenant_id = $1 ORDER BY role_ref ASC`,
    [tenant_id],
  );
  return rows.map(toPolicy);
}

/* ------------------------------------------------------------ spending */

/**
 * What this role has actually been CHARGED in the last 24 hours.
 *
 * Read from the ledger's CHARGE entries rather than from a running total on the
 * policy, and joined back through the request to get the role. A counter column
 * would have to be decremented on every refund and reset on a schedule, and the day
 * it drifts nobody can tell whether the cap was honoured. The ledger is append-only,
 * so this number can always be re-derived and it can never be quietly edited.
 *
 * Reservations are excluded on purpose: a hold is not a spend. Counting them would
 * make an in-flight request eat into a cap that a no-match is about to hand back.
 */
export async function spentInLast24h(tenant_id: string, role_ref: string): Promise<number> {
  const row = await dataService.one<{ spent: string }>(
    `SELECT COALESCE(sum(-l.balance_delta), 0)::text AS spent
       FROM data_credits.credit_ledger l
       JOIN data_credits.capability_request r ON r.request_id = l.request_id
      WHERE l.tenant_id = $1 AND r.role_ref = $2
        AND l.entry_type = 'CHARGE'
        AND l.created_at > now() - interval '24 hours'`,
    [tenant_id, role_ref],
  );
  return Number(row?.spent ?? 0);
}

export interface BudgetVerdict {
  /** False only when the spend is refused outright — a daily cap that is already full. */
  allowed: boolean;
  /** True when the request may proceed, but only after somebody approves it. */
  requires_approval: boolean;
  mode: BudgetMode | 'NO_POLICY';
  reason: string;
  spent_last_24h: number;
  daily_cap: number | null;
  remaining_today: number | null;
  bulk_approval_threshold: number | null;
}

export interface EvaluateInput {
  tenant_id: string;
  role_ref?: string | null;
  credits: number;
}

/**
 * Decide what happens to this spend BEFORE anything is held or executed.
 *
 * Returns a verdict rather than throwing for the approval cases: "you may, once
 * somebody says so" is not an error, and modelling it as one pushes callers into
 * catching exceptions to implement the normal path.
 */
export async function evaluate(input: EvaluateInput): Promise<BudgetVerdict> {
  const credits = Number(input.credits);

  if (!input.role_ref) {
    // No role given at all — a system-initiated request. There is no policy to
    // consult and no human to ask, so it proceeds; the caller that omitted the role
    // is the one that decided this is not user-driven spend.
    return {
      allowed: true, requires_approval: false, mode: 'NO_POLICY',
      reason: 'no role supplied — treated as a system request',
      spent_last_24h: 0, daily_cap: null, remaining_today: null,
      bulk_approval_threshold: null,
    };
  }

  const policy = await getBudgetPolicy(input.tenant_id, input.role_ref);

  if (!policy) {
    return {
      allowed: true, requires_approval: true, mode: 'NO_POLICY',
      reason: `no budget policy for role '${input.role_ref}' — asking rather than assuming`,
      spent_last_24h: 0, daily_cap: null, remaining_today: null,
      bulk_approval_threshold: null,
    };
  }

  const threshold = policy.bulk_approval_threshold;
  // Checked FIRST and independently of mode: this is the rule that outranks trust.
  const bulk = threshold !== null && credits >= threshold;

  if (policy.mode === 'DAILY_CAP') {
    const spent = await spentInLast24h(input.tenant_id, input.role_ref);
    const cap = policy.daily_cap ?? 0;
    const remaining = cap - spent;
    if (credits > remaining) {
      return {
        allowed: false, requires_approval: false, mode: policy.mode,
        reason: `daily cap reached: ${spent} of ${cap} credits spent in the last 24 hours`,
        spent_last_24h: spent, daily_cap: cap, remaining_today: Math.max(0, remaining),
        bulk_approval_threshold: threshold,
      };
    }
    return {
      allowed: true, requires_approval: bulk, mode: policy.mode,
      reason: bulk
        ? `at or above the bulk threshold of ${threshold} credits`
        : `within the daily cap (${spent} of ${cap} spent)`,
      spent_last_24h: spent, daily_cap: cap, remaining_today: remaining - credits,
      bulk_approval_threshold: threshold,
    };
  }

  const requires_approval = policy.mode === 'REQUEST_ONLY' || bulk;
  return {
    allowed: true,
    requires_approval,
    mode: policy.mode,
    reason: requires_approval
      ? (policy.mode === 'REQUEST_ONLY'
          ? `role '${input.role_ref}' may request but not spend`
          : `at or above the bulk threshold of ${threshold} credits`)
      : `role '${input.role_ref}' has full authority`,
    spent_last_24h: 0,
    daily_cap: null,
    remaining_today: null,
    bulk_approval_threshold: threshold,
  };
}

/* ------------------------------------------------------------ approval */

export interface ApprovalRequest {
  tenant_id: string;
  request_id: string;
  role_ref: string | null;
  credits: number;
  capability_key: string;
  reason: string;
}

/**
 * Raise the approval with sdk-approval. NO DEFAULT.
 *
 * A no-op default would leave requests sitting in PENDING_APPROVAL with nobody ever
 * told to look at them — a queue that silently never moves, which is indistinguishable
 * from a broken integration until somebody asks why their lookups never ran.
 * Unwired, `requestApproval` says so in its return value instead of pretending.
 */
export type ApprovalRequester = (req: ApprovalRequest) => Promise<{ approval_ref: string }>;

let approvalRequester: ApprovalRequester | null = null;

export function setApprovalRequester(fn: ApprovalRequester | null): void {
  approvalRequester = fn;
}

export function hasApprovalRequester(): boolean {
  return approvalRequester !== null;
}

export async function requestApproval(req: ApprovalRequest): Promise<{
  raised: boolean; approval_ref: string | null;
}> {
  if (!approvalRequester) return { raised: false, approval_ref: null };
  const { approval_ref } = await approvalRequester(req);
  await dataService.query(
    `UPDATE data_credits.capability_request SET approval_ref = $2 WHERE request_id = $1`,
    [req.request_id, approval_ref],
  );
  return { raised: true, approval_ref };
}
