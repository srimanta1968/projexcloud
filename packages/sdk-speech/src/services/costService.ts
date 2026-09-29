import { findCatalogEntries, type CatalogEntry, type CatalogLayer } from './catalogService';
import { validationError } from '../models/errors';

/**
 * Per-minute provider cost estimator (VA·E4 · TK-4492, FR-SP-3, FR-ME-3).
 *
 * Estimated provider spend for one minute of call, from catalog list prices and a usage
 * profile. The tenant pays these providers directly (BYOK) — this is shown, never invoiced.
 * Telephony is excluded: it is the tenant's carrier account, priced by the carrier.
 *
 * Usage profile (every field overridable per request):
 *   turns_per_min           conversational turns per call-minute             (default 8)
 *   input_tokens_per_turn   LLM prompt tokens per turn, incl. history        (default 1500)
 *   output_tokens_per_turn  LLM completion tokens per turn                   (default 60)
 *   complex_turn_share      share of turns routed to llm_complex             (default 0.2)
 *   tts_chars_per_min       characters the agent speaks per call-minute      (default 600)
 *   agent_talk_share        share of the minute the agent is speaking        (default 0.5)
 *   stt_minutes_per_min     audio minutes transcribed per call-minute        (default 1)
 */

export interface UsageProfile {
  turns_per_min: number;
  input_tokens_per_turn: number;
  output_tokens_per_turn: number;
  complex_turn_share: number;
  tts_chars_per_min: number;
  agent_talk_share: number;
  stt_minutes_per_min: number;
}

export const DEFAULT_USAGE_PROFILE: UsageProfile = {
  turns_per_min: 8,
  input_tokens_per_turn: 1500,
  output_tokens_per_turn: 60,
  complex_turn_share: 0.2,
  tts_chars_per_min: 600,
  agent_talk_share: 0.5,
  stt_minutes_per_min: 1,
};

const PROFILE_LIMITS: Record<keyof UsageProfile, [number, number]> = {
  turns_per_min: [0, 60],
  input_tokens_per_turn: [0, 200000],
  output_tokens_per_turn: [0, 8000],
  complex_turn_share: [0, 1],
  tts_chars_per_min: [0, 5000],
  agent_talk_share: [0, 1],
  stt_minutes_per_min: [0, 2],
};

/** One stack layer to price: stt, llm_fast, llm_complex or tts, with its provider/model. */
export interface PricedLayerInput {
  layer: string;
  catalog_layer: CatalogLayer;
  provider: string;
  model?: string;
}

export interface CostLine {
  layer: string;
  catalog_key: string | null;
  unit: string | null;
  list_price: number | null;
  output_list_price: number | null;
  /** Units consumed per call-minute (minutes, thousand chars, or million tokens in / out). */
  quantity: Record<string, number>;
  /** USD per call-minute; null when the provider/model has no catalog entry. */
  cost_per_min: number | null;
  certified: boolean;
}

export interface CostEstimate {
  currency: 'USD';
  /** Sum of the priced lines; a lower bound when any line is unpriced. */
  cost_per_min: number;
  /** False when some layer had no catalog price, so the total is incomplete. */
  complete: boolean;
  lines: CostLine[];
  usage_profile: UsageProfile;
  excludes: string[];
  basis: string;
}

/** Parses usage overrides (strings from a query or numbers); unknown keys are ignored. */
export function parseUsageProfile(input: Record<string, unknown> | undefined): UsageProfile {
  const profile = { ...DEFAULT_USAGE_PROFILE };
  for (const key of Object.keys(PROFILE_LIMITS) as (keyof UsageProfile)[]) {
    const raw = input?.[key];
    if (raw === undefined || raw === '') continue;
    const n = typeof raw === 'number' ? raw : Number(raw);
    const [min, max] = PROFILE_LIMITS[key];
    if (!Number.isFinite(n) || n < min || n > max) throw validationError(`${key} must be a number between ${min} and ${max}`);
    profile[key] = n;
  }
  return profile;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

function priceLine(input: PricedLayerInput, entry: CatalogEntry | undefined, p: UsageProfile): CostLine {
  const key = input.model ? `${input.catalog_layer}:${input.provider}:${input.model}` : null;
  const base = {
    layer: input.layer,
    catalog_key: key,
    unit: entry?.unit ?? null,
    list_price: entry?.list_price ?? null,
    output_list_price: entry?.output_list_price ?? null,
    certified: entry?.certified ?? false,
  };
  if (!entry) return { ...base, quantity: {}, cost_per_min: null };

  if (entry.unit === 'per_1m_tokens') {
    const share = input.layer === 'llm_complex' ? p.complex_turn_share : input.layer === 'llm_fast' ? 1 - p.complex_turn_share : 1;
    const turns = p.turns_per_min * share;
    const mIn = (turns * p.input_tokens_per_turn) / 1e6;
    const mOut = (turns * p.output_tokens_per_turn) / 1e6;
    return {
      ...base,
      quantity: { million_input_tokens: round(mIn), million_output_tokens: round(mOut) },
      cost_per_min: round(mIn * entry.list_price + mOut * (entry.output_list_price ?? 0)),
    };
  }
  if (entry.unit === 'per_1k_chars') {
    const k = p.tts_chars_per_min / 1000;
    return { ...base, quantity: { thousand_chars: round(k) }, cost_per_min: round(k * entry.list_price) };
  }
  // per_minute: STT listens the whole call; TTS / realtime bill the audio they produce.
  const minutes = input.catalog_layer === 'stt' ? p.stt_minutes_per_min : input.catalog_layer === 'tts' ? p.agent_talk_share : 1;
  return { ...base, quantity: { minutes: round(minutes) }, cost_per_min: round(minutes * entry.list_price) };
}

/** Estimated provider cost per call-minute for a stack, from catalog prices. */
export async function estimateCostPerMinute(layers: PricedLayerInput[], usage: UsageProfile): Promise<CostEstimate> {
  const keyOf = (l: PricedLayerInput): string => `${l.catalog_layer}:${l.provider}:${l.model}`;
  const entries = await findCatalogEntries(layers.filter((l) => l.model).map(keyOf));
  const lines = layers.map((l) => priceLine(l, l.model ? entries.get(keyOf(l)) : undefined, usage));
  return {
    currency: 'USD',
    cost_per_min: round(lines.reduce((sum, l) => sum + (l.cost_per_min ?? 0), 0)),
    complete: lines.every((l) => l.cost_per_min !== null),
    lines,
    usage_profile: usage,
    excludes: ['telephony'],
    basis: 'speech catalog list prices; provider spend paid directly by the tenant (BYOK), not invoiced',
  };
}
