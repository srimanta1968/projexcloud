/**
 * TypeScript models mirroring billing.* tables per P4-Operational-Billing-DataModel §9.
 */

export type InvoiceStatus = 'draft' | 'finalized' | 'paid' | 'failed' | 'void';
export type DunningStage = 'reminder-1' | 'reminder-2' | 'final-notice' | 'service-suspend' | 'written-off';
export type ActorKind = 'human' | 'agent' | 'service';

export interface InvoiceRecord {
  invoice_id: string;
  tenant_id: string;
  catalog_id: string;
  fiscal_period_id: string | null;
  period_start: string;
  period_end: string;
  subtotal: string;
  tax: string;
  total: string;
  currency: string;
  status: InvoiceStatus;
  pdf_s3_key: string | null;
  stripe_invoice_id: string | null;
  generated_at: Date;
  finalized_at: Date | null;
  paid_at: Date | null;
}

export interface LineItemRecord {
  line_id: string;
  invoice_id: string;
  sku: string;
  app_id: string | null;
  bu_id: string | null;
  persona_kind: string | null;
  encounter_id: string | null;
  units: string;
  rate: string;
  amount: string;
  actor_kind: ActorKind | null;
}

export interface DunningStateRecord {
  dunning_id: string;
  invoice_id: string;
  stage: DunningStage;
  workflow_run_id: string | null;
  last_action_at: Date;
}

export interface RepriceDryRunRecord {
  dry_run_id: string;
  tenant_id: string | null;
  period_start: string;
  period_end: string;
  baseline_catalog_id: string;
  target_catalog_id: string;
  delta_amount: string;
  delta_by_sku: Record<string, number>;
  computed_at: Date;
}

/* --------------------------------------------------------------- Pricing */

/**
 * The six pricing modes per FR-BIL-1. Each catalog rate row picks one.
 */
export type PricingMode =
  | 'flat_per_call'
  | 'tiered_per_call'
  | 'passthrough_plus_margin'
  | 'per_unit'
  | 'bundled_subscription'
  | 'free_internal';

export interface TierBreak {
  /** Inclusive upper bound. Final tier uses Infinity. */
  upto: number;
  /** Rate applied to units up to this break. */
  rate: number;
}

export interface PricingRate {
  sku: string;
  mode: PricingMode;
  rate?: number;
  /** For tiered_per_call. */
  tiers?: TierBreak[];
  /** For passthrough_plus_margin: caller-supplied wholesale cost + margin %. */
  margin_pct?: number;
  /** For bundled_subscription: included units before overage rate kicks in. */
  included_units?: number;
  /** For bundled_subscription: rate applied after included_units. */
  overage_rate?: number;
}

/**
 * Usage roll-up read from ClickHouse meter rollups (or in synthetic mode,
 * from the meter.usage_rollup Postgres table). One row per
 * (sku × app × bu × persona_kind × encounter × actor_kind) bucket.
 */
export interface UsageBucket {
  sku: string;
  app_id: string | null;
  bu_id: string | null;
  persona_kind: string | null;
  encounter_id: string | null;
  actor_kind: ActorKind | null;
  units: number;
  /** For passthrough_plus_margin: vendor wholesale cost in catalog currency. */
  vendor_cost?: number;
}

/* ------------------------------------------------------------------- DTOs */

export interface GenerateInvoiceInput {
  tenant_id: string;
  catalog_id: string;
  period_start: string;
  period_end: string;
  /** Caller may inject usage instead of asking the synthetic provider. */
  usage?: UsageBucket[];
  /** Apply tax rate (decimal, e.g. 0.0875 for 8.75%); default 0. */
  tax_rate?: number;
  currency?: string;
}

export interface LiveMeterInput {
  tenant_id: string;
}

export interface LiveMeterResult {
  tenant_id: string;
  as_of: Date;
  current_period_start: string;
  /** Subtotal accrued so far in current period, before tax. */
  subtotal: number;
  /** Lag in milliseconds between meter event ingest and this read. */
  lag_ms: number;
  by_sku: Record<string, { units: number; amount: number }>;
}

export interface RepriceDryRunInput {
  tenant_id: string;
  period_start: string;
  period_end: string;
  baseline_catalog_id: string;
  target_catalog_id: string;
  usage?: UsageBucket[];
}

export interface ShowbackInput {
  tenant_id: string;
  period_start: string;
  period_end: string;
  group_by: Array<'app_id' | 'bu_id' | 'persona_kind' | 'encounter_id' | 'sku' | 'actor_kind'>;
}

export interface ShowbackRow {
  /** Composite key — concatenation of the group_by dimensions. */
  dim_key: string;
  dimensions: Record<string, string | null>;
  units: number;
  amount: number;
}

export interface ShowbackResult {
  tenant_id: string;
  period_start: string;
  period_end: string;
  rows: ShowbackRow[];
  total_amount: number;
}
