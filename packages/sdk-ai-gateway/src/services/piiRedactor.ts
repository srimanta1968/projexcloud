import { dataService } from '@projexlight/db-runtime';

/**
 * PII redaction pass (FR-AGW-3).
 *
 * Loads active redaction rules from `ai_gateway.pii_redaction_rule` for
 * the requesting tenant + platform defaults (tenant_id IS NULL), then
 * applies them to the prompt before the provider call. Returns the
 * redacted prompt + a boolean for the completion row's
 * `pii_redaction_applied` column.
 *
 * Rules are cached per (tenant_id) for 60s to keep the hot path fast.
 * Cache is process-local; a SIGHUP / rule-update event invalidates the
 * cache key for that tenant.
 */

interface RuleRow {
  pattern: string;
  replacement: string;
}

interface CompiledRule {
  regex: RegExp;
  replacement: string;
}

interface CacheEntry {
  rules: CompiledRule[];
  loaded_at: number;
}

const RULE_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(tenant_id: string | null): string {
  return tenant_id ?? '__platform__';
}

async function loadRules(tenant_id: string | null): Promise<CompiledRule[]> {
  const key = cacheKey(tenant_id);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.loaded_at < RULE_TTL_MS) return hit.rules;

  const r = await dataService.query<RuleRow>(
    `SELECT pattern, replacement
       FROM ai_gateway.pii_redaction_rule
      WHERE active = TRUE
        AND (tenant_id IS NULL OR tenant_id = $1::uuid)`,
    [tenant_id],
  );

  const compiled: CompiledRule[] = [];
  for (const row of r.rows) {
    try {
      compiled.push({ regex: new RegExp(row.pattern, 'g'), replacement: row.replacement });
    } catch (err) {
      console.error(
        '[pii-redactor] skipping invalid pattern',
        row.pattern,
        (err as Error).message,
      );
    }
  }

  cache.set(key, { rules: compiled, loaded_at: Date.now() });
  return compiled;
}

export interface RedactResult {
  redacted: string;
  applied: boolean;
  /** Per-rule match count for forensics (not persisted in completion row). */
  match_counts: Record<string, number>;
}

export async function redactPrompt(
  prompt: string,
  tenant_id: string | null,
): Promise<RedactResult> {
  const rules = await loadRules(tenant_id);
  if (rules.length === 0) {
    return { redacted: prompt, applied: false, match_counts: {} };
  }
  let out = prompt;
  let applied = false;
  const counts: Record<string, number> = {};
  for (const rule of rules) {
    const before = out;
    let n = 0;
    out = out.replace(rule.regex, () => {
      n += 1;
      return rule.replacement;
    });
    if (n > 0) {
      applied = true;
      counts[rule.regex.source] = n;
    }
    if (before === out) continue;
  }
  return { redacted: out, applied, match_counts: counts };
}

/** Invalidate the redaction-rule cache for a tenant. Called by admin updates. */
export function invalidateRedactionCache(tenant_id: string | null): void {
  cache.delete(cacheKey(tenant_id));
}
