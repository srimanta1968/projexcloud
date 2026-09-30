/**
 * Two-tier turn router (VA·E1 · TK-4460): tags each caller turn voice.fast or voice.complex.
 * Most turns are short exchanges ("eight thirty please") that a fast, cheap model answers
 * with the lowest latency; turns that need reasoning, comparison, policy or care go to the
 * complex model. Where each tier points (provider/model) is the tenant's ai-gateway route
 * rule for the tag, resolved in the call bootstrap — this only decides the tier.
 *
 * Per agent: escalation_rules.router = { complex_patterns?: string[] (regex, case-insensitive),
 * max_fast_words?: number, always?: 'fast' | 'complex' }.
 */

export type Tier = 'fast' | 'complex';

export interface RouteVerdict {
  tier: Tier;
  reason: string;
}

const REASONING = /\b(why|explain|compare|comparison|difference|differ|versus|vs\.?|calculate|how much would|how many would|what if|pros and cons|recommend|which (?:one )?(?:is|would be) better|policy|policies|refund|reimburse|cancellation fee|terms|contract|warranty|legal|dispute|breakdown|in detail)\b/i;
const FRUSTRATION = /\b(frustrat\w*|angry|upset|ridiculous|unacceptable|complain\w*|terrible|worst|manager|supervisor|speak to (?:a )?(?:human|person|someone))\b/i;
const MULTI_INTENT = /\b(and also|as well as|another question|two things|a couple of things|one more thing)\b/i;

interface RouterConfig {
  complexPatterns: RegExp[];
  maxFastWords: number;
  always: Tier | null;
}

export function routerConfig(escalationRules: Record<string, unknown> | undefined): RouterConfig {
  const r = (escalationRules?.router ?? {}) as Record<string, unknown>;
  const patterns = Array.isArray(r.complex_patterns) ? r.complex_patterns.filter((p): p is string => typeof p === 'string') : [];
  const compiled: RegExp[] = [];
  for (const p of patterns) {
    try { compiled.push(new RegExp(p, 'i')); } catch { /* invalid pattern: ignored */ }
  }
  const max = typeof r.max_fast_words === 'number' && r.max_fast_words > 0 ? r.max_fast_words : 35;
  return { complexPatterns: compiled, maxFastWords: max, always: r.always === 'fast' || r.always === 'complex' ? r.always : null };
}

export function classifyTurn(text: string, cfg: RouterConfig): RouteVerdict {
  if (cfg.always) return { tier: cfg.always, reason: 'agent_setting' };
  for (const re of cfg.complexPatterns) if (re.test(text)) return { tier: 'complex', reason: 'agent_pattern' };
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words > cfg.maxFastWords) return { tier: 'complex', reason: 'long_turn' };
  if ((text.match(/\?/g) ?? []).length >= 2 || MULTI_INTENT.test(text)) return { tier: 'complex', reason: 'multi_intent' };
  if (REASONING.test(text)) return { tier: 'complex', reason: 'reasoning' };
  if (FRUSTRATION.test(text)) return { tier: 'complex', reason: 'frustration' };
  return { tier: 'fast', reason: 'default' };
}
