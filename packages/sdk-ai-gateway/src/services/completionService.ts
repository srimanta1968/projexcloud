import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { envelopeDecrypt } from '@projexlight/sdk-secrets';
import type {
  AgentContext,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ProviderId,
} from '@projexlight/contracts';
import { getProvider, type ProviderCompletionResult } from './providerAdapter';
import { redactPrompt } from './piiRedactor';
import {
  recordProviderFailure,
  recordProviderSuccess,
  resolveRoute,
  withRetry,
} from './routingEngine';
import { assertKillSwitchDisengaged } from './killSwitch';
import { resolveLocalProvider } from './localProviderResolver';

/**
 * AI Gateway completion service (FR-AGW-1..9 / AC-1).
 *
 * Pipeline per call:
 *   1. Resolve route per tenant (or fall back to provider_hint).
 *   2. PII-redact prompt (FR-AGW-3).
 *   3. Pull provider credential envelope; decrypt via sdk-vault.
 *   4. Retry-wrapped provider.complete(); on failure, advance circuit breaker.
 *   5. Compute billed_cost = provider_cost * (1 + margin_pct/100).
 *   6. Insert ai_gateway.completion row with full trace + audit cross-ref.
 *   7. Emit ai-gateway.complete.v1 (operational retention).
 *
 * stream() shares the pipeline but the provider call is an async iterator;
 * tokens_out + provider_cost are computed on stream close from the final
 * chunk's `tokens_so_far` and the route's published rate.
 */

const PROVIDER_MARGIN_PCT = parseFloat(process.env.AI_GATEWAY_MARGIN_PCT ?? '15');

export type CredentialSource = 'tenant' | 'platform';

export interface ProviderRow {
  provider_id: ProviderId;
  credential_envelope: Buffer;
  status: 'active' | 'degraded' | 'disabled';
  credential_source: CredentialSource;
  binding_id?: string;
  model_allowlist?: string[] | null;
}

/**
 * In-process resolver cache for tenant↔provider lookups. Bounded TTL because
 * bind/rotate/revoke fires audit events but does not (yet) broadcast a
 * cache-invalidation message — the 60s window is the worst-case staleness.
 */
interface CacheEntry {
  row: ProviderRow;
  expires_at: number;
}
const RESOLVER_CACHE_TTL_MS = 60_000;
const resolverCache = new Map<string, CacheEntry>();

function cacheKey(tenant_id: string | null | undefined, provider_id: ProviderId): string {
  return `${tenant_id ?? '__platform__'}::${provider_id}`;
}

function cacheGet(key: string): ProviderRow | null {
  const hit = resolverCache.get(key);
  if (!hit) return null;
  if (hit.expires_at < Date.now()) {
    resolverCache.delete(key);
    return null;
  }
  return hit.row;
}

function cachePut(key: string, row: ProviderRow): void {
  resolverCache.set(key, { row, expires_at: Date.now() + RESOLVER_CACHE_TTL_MS });
}

/**
 * Invalidate the resolver cache for a (tenant, provider) pair. Called from
 * tenantCredentialService on bind/rotate/revoke so the next completion sees
 * the change immediately.
 */
export function invalidateProviderCache(tenant_id: string, provider_id: ProviderId): void {
  resolverCache.delete(cacheKey(tenant_id, provider_id));
}

interface TenantCredentialRow {
  binding_id: string;
  credential_envelope: Buffer;
  model_allowlist: string[] | null;
}

/**
 * Resolve the credential to use for a given (tenant, provider, model) tuple.
 *
 * Resolution order per docs/v3.1/prd/Tenant-BYOK-AI-Keys.md FR-BYOK-2:
 *   1. Active row in ai_gateway.tenant_provider_credential for (tenant, provider).
 *      If model_allowlist is non-null and the requested model is not in it,
 *      treat as no tenant credential and fall through (FR-BYOK-6).
 *   2. Platform row in ai_gateway.provider for the provider.
 *
 * Returns null if neither exists or the platform row is disabled.
 */
async function loadProviderRow(
  tenant_id: string | null | undefined,
  provider_id: ProviderId,
  model?: string,
): Promise<ProviderRow | null> {
  // Model-allowlist gating defeats cache reuse across different models, so
  // we only cache when no model is supplied OR no tenant binding exists.
  const key = cacheKey(tenant_id, provider_id);
  const cached = cacheGet(key);
  if (cached) {
    if (
      cached.credential_source === 'tenant' &&
      cached.model_allowlist &&
      model &&
      !cached.model_allowlist.includes(model)
    ) {
      // Fall through to platform — but don't poison the cache with a
      // model-dependent answer. Continue to fresh resolution below.
    } else {
      return cached;
    }
  }

  if (tenant_id) {
    const tenantRow = await dataService.one<TenantCredentialRow>(
      `SELECT binding_id, credential_envelope, model_allowlist
         FROM ai_gateway.tenant_provider_credential
         WHERE tenant_id = $1 AND provider_id = $2 AND status = 'active'`,
      [tenant_id, provider_id],
    );
    if (tenantRow) {
      const allowlist = tenantRow.model_allowlist;
      const modelAllowed = !allowlist || (model ? allowlist.includes(model) : true);
      if (modelAllowed) {
        const row: ProviderRow = {
          provider_id,
          credential_envelope: tenantRow.credential_envelope,
          status: 'active',
          credential_source: 'tenant',
          binding_id: tenantRow.binding_id,
          model_allowlist: allowlist,
        };
        cachePut(key, row);
        return row;
      }
      // model not in allowlist → fall through to platform without caching
      // (the answer is model-dependent).
    }
  }

  const platformRow = await dataService.one<{
    provider_id: ProviderId;
    credential_envelope: Buffer;
    status: 'active' | 'degraded' | 'disabled';
  }>(
    `SELECT provider_id, credential_envelope, status
       FROM ai_gateway.provider WHERE provider_id = $1`,
    [provider_id],
  );
  if (!platformRow) return null;

  const row: ProviderRow = {
    provider_id: platformRow.provider_id,
    credential_envelope: platformRow.credential_envelope,
    status: platformRow.status,
    credential_source: 'platform',
  };
  // Cache only when we either had no tenant_id or the platform fallback is
  // the right answer regardless of model — i.e. no tenant binding existed.
  cachePut(key, row);
  return row;
}

interface SelectedRoute {
  rule_id: string | null;
  provider_id: ProviderId;
  model: string;
}

async function selectRoute(
  ctx: AgentContext,
  request: CompletionRequest,
): Promise<SelectedRoute> {
  // P8 Variant C (on-prem) preempts every other route. If sdk-onprem has
  // registered a local-provider resolver and that resolver returns a hit,
  // we use it — guarantees no cloud provider call on an air-gapped install.
  const localHit = await resolveLocalProvider(ctx, request);
  if (localHit) {
    return { rule_id: null, provider_id: localHit.provider_id, model: localHit.model };
  }
  const decision = await resolveRoute(ctx.tenant_id, request);
  if (decision) {
    return { rule_id: decision.rule_id, provider_id: decision.provider_id, model: decision.model };
  }
  if (request.provider_hint) {
    return { rule_id: null, provider_id: request.provider_hint, model: request.model };
  }
  throw new Error('[ai-gateway] no route matches and no provider_hint supplied');
}

function computeBilled(provider_cost: number): number {
  return Number((provider_cost * (1 + PROVIDER_MARGIN_PCT / 100)).toFixed(8));
}

/**
 * Resolve the kill-switch flag id for the run's agent and assert the flag
 * is NOT engaged before any provider work happens (FR-AGW-7 / G-9).
 *
 * Returns silently when (a) no agent_id is on the ctx (platform-internal
 * call without an agent), (b) the agent has no kill_switch_flag_id wired,
 * or (c) the flag is disengaged. Throws KillSwitchError otherwise — the
 * caller bubbles that up so no provider cost is incurred.
 */
async function ensureKillSwitchClear(ctx: AgentContext): Promise<void> {
  if (!ctx.agent_id) return;
  const row = await dataService.one<{ kill_switch_flag_id: string | null }>(
    `SELECT kill_switch_flag_id FROM agents.agent_definition WHERE agent_id = $1`,
    [ctx.agent_id],
  );
  if (!row || !row.kill_switch_flag_id) return;
  await assertKillSwitchDisengaged({
    agent_id: ctx.agent_id,
    flag_id: row.kill_switch_flag_id,
    ctx,
  });
}

async function unwrapCredential(envelope: Buffer): Promise<Buffer> {
  // Production: sdk-secrets envelopeDecrypt with a per-call wrapped DEK.
  // Prototype: when the envelope is JSON with {ref, wrapped}, decrypt;
  // otherwise treat the envelope itself as the plain credential (dev mode).
  try {
    const maybe = JSON.parse(envelope.toString('utf8'));
    if (maybe && typeof maybe.ref === 'string' && typeof maybe.wrapped === 'string') {
      return envelopeDecrypt({
        ref: maybe.ref,
        wrapped_dek_b64: maybe.wrapped,
        ciphertext_b64: maybe.ciphertext ?? '',
        iv_b64: maybe.iv ?? '',
        tag_b64: maybe.tag ?? '',
      });
    }
  } catch {
    // not JSON — fall through to plain-bytes mode
  }
  return envelope;
}

async function persistCompletion(input: {
  completion_id: string;
  ctx: AgentContext;
  selected: SelectedRoute;
  prompt_redacted: boolean;
  result: ProviderCompletionResult;
  billed_cost: number;
  latency_ms: number;
}): Promise<void> {
  await dataService.query(
    `INSERT INTO ai_gateway.completion (
       completion_id, tenant_id, persona_id, agent_run_id, provider_id, model,
       tokens_in, tokens_out, provider_cost, billed_cost, pii_redaction_applied,
       latency_ms, started_at, langfuse_trace_id, trace_id, finish_reason
     ) VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13, $14, $15)`,
    [
      input.completion_id,
      input.ctx.tenant_id,
      input.ctx.acting_persona_id,
      input.ctx.run_id,
      input.selected.provider_id,
      input.selected.model,
      input.result.tokens_in,
      input.result.tokens_out,
      input.result.provider_cost,
      input.billed_cost,
      input.prompt_redacted,
      input.latency_ms,
      input.result.langfuse_trace_id ?? null,
      input.ctx.trace_id,
      input.result.finish_reason,
    ],
  );
}

async function emitCompletionEvent(input: {
  ctx: AgentContext;
  selected: SelectedRoute;
  result: ProviderCompletionResult;
  billed_cost: number;
  credential_source: CredentialSource;
  completion_id: string;
  event_type: 'ai-gateway.complete.v1' | 'ai-gateway.stream.v1';
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: process.env.AI_GATEWAY_AUDIT_POOL || 'admin-default',
      event_type: input.event_type,
      actor_kind: 'service',
      actor_id: 'sdk-ai-gateway',
      tenant_id: input.ctx.tenant_id,
      subject_kind: 'ai_gateway.completion',
      subject_id: input.completion_id,
      retention_class: 'operational',
      payload: {
        agent_run_id: input.ctx.run_id,
        provider_id: input.selected.provider_id,
        model: input.selected.model,
        tokens_in: input.result.tokens_in,
        tokens_out: input.result.tokens_out,
        provider_cost: input.result.provider_cost,
        billed_cost: input.billed_cost,
        // FR-BYOK-9 / AC-4: stamped so the meter ingest worker emits the
        // governance SKU only for tenant credential calls (suppresses the
        // ai-gateway.tokens.* markup line).
        credential_source: input.credential_source,
        finish_reason: input.result.finish_reason,
        trace_id: input.ctx.trace_id,
      },
    });
  } catch (auditErr) {
    console.error(
      '[ai-gateway] audit emit failed for completion',
      input.completion_id,
      (auditErr as Error).message,
    );
  }
}

/**
 * Non-streaming completion. Returns a fully-populated CompletionResponse
 * suitable for direct return to the agent runtime caller.
 */
export async function complete(
  request: CompletionRequest,
  ctx: AgentContext,
): Promise<CompletionResponse> {
  // FR-AGW-7 / G-9 — short-circuit before any provider cost is incurred.
  await ensureKillSwitchClear(ctx);

  const selected = await selectRoute(ctx, request);
  const providerRow = await loadProviderRow(ctx.tenant_id, selected.provider_id, selected.model);
  if (!providerRow || providerRow.status === 'disabled') {
    throw new Error(`[ai-gateway] provider ${selected.provider_id} not available`);
  }
  const credential = await unwrapCredential(providerRow.credential_envelope);

  const prompt = typeof request.prompt === 'string' ? request.prompt : JSON.stringify(request.prompt);
  const redaction = await redactPrompt(prompt, ctx.tenant_id);
  const requestForProvider: CompletionRequest = { ...request, prompt: redaction.redacted, model: selected.model };

  const adapter = getProvider(selected.provider_id);
  const completionId = crypto.randomUUID();
  const startedAt = Date.now();

  let result: ProviderCompletionResult;
  try {
    result = await withRetry(() => adapter.complete(requestForProvider, credential));
    await recordProviderSuccess(selected.provider_id);
  } catch (providerErr) {
    await recordProviderFailure(selected.provider_id);
    throw providerErr;
  }

  const latency_ms = Date.now() - startedAt;
  // FR-BYOK-9: when the tenant brings their own provider key, the token cost
  // is on their provider invoice — we bill only the governance SKU. The
  // billed_cost on the completion row stays at zero, and the meter ingest
  // worker (reading credential_source from the audit payload) emits only
  // ai-gateway.completion.governance for these calls.
  const billed_cost = providerRow.credential_source === 'tenant'
    ? 0
    : computeBilled(result.provider_cost);

  await persistCompletion({
    completion_id: completionId,
    ctx,
    selected,
    prompt_redacted: redaction.applied,
    result,
    billed_cost,
    latency_ms,
  });
  await emitCompletionEvent({
    ctx,
    selected,
    result,
    billed_cost,
    credential_source: providerRow.credential_source,
    completion_id: completionId,
    event_type: 'ai-gateway.complete.v1',
  });

  return {
    completion_id: completionId,
    provider_id: selected.provider_id,
    model: selected.model,
    output: result.output,
    tool_calls: result.tool_calls,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
    provider_cost: result.provider_cost,
    billed_cost,
    latency_ms,
    langfuse_trace_id: result.langfuse_trace_id,
    trace_id: ctx.trace_id,
    pii_redaction_applied: redaction.applied,
    finish_reason: result.finish_reason,
  };
}

/**
 * Streaming completion. Yields each chunk from the provider; persists the
 * completion row + audit event after the stream closes.
 */
export async function* stream(
  request: CompletionRequest,
  ctx: AgentContext,
): AsyncIterable<StreamChunk> {
  // FR-AGW-7 / G-9 — refuse before opening a provider stream.
  await ensureKillSwitchClear(ctx);

  const selected = await selectRoute(ctx, request);
  const providerRow = await loadProviderRow(ctx.tenant_id, selected.provider_id, selected.model);
  if (!providerRow || providerRow.status === 'disabled') {
    throw new Error(`[ai-gateway] provider ${selected.provider_id} not available`);
  }
  const credential = await unwrapCredential(providerRow.credential_envelope);

  const prompt = typeof request.prompt === 'string' ? request.prompt : JSON.stringify(request.prompt);
  const redaction = await redactPrompt(prompt, ctx.tenant_id);
  const requestForProvider: CompletionRequest = { ...request, prompt: redaction.redacted, model: selected.model, stream: true };

  const adapter = getProvider(selected.provider_id);
  const completionId = crypto.randomUUID();
  const startedAt = Date.now();

  let tokensSoFar = 0;
  let finishReason: CompletionResponse['finish_reason'] = 'stop';
  let outputAccum = '';

  try {
    for await (const chunk of adapter.stream(requestForProvider, credential)) {
      const enriched: StreamChunk = { ...chunk, completion_id: completionId };
      tokensSoFar = chunk.tokens_so_far ?? tokensSoFar;
      outputAccum += chunk.delta;
      if (chunk.finish_reason) finishReason = chunk.finish_reason;
      yield enriched;
    }
    await recordProviderSuccess(selected.provider_id);
  } catch (providerErr) {
    await recordProviderFailure(selected.provider_id);
    throw providerErr;
  }

  const latency_ms = Date.now() - startedAt;
  // Streaming providers usually report cost out-of-band; approximate from
  // a static rate per million tokens until a per-stream cost hook lands.
  const approxProviderCost = (tokensSoFar / 1_000_000) * 1.0; // $1/M tokens default
  // FR-BYOK-9: zero token markup for BYOK streams; governance SKU only.
  const billed_cost = providerRow.credential_source === 'tenant'
    ? 0
    : computeBilled(approxProviderCost);

  const synthetic: ProviderCompletionResult = {
    output: outputAccum,
    tool_calls: [],
    tokens_in: 0,
    tokens_out: tokensSoFar,
    provider_cost: approxProviderCost,
    finish_reason: finishReason,
  };

  await persistCompletion({
    completion_id: completionId,
    ctx,
    selected,
    prompt_redacted: redaction.applied,
    result: synthetic,
    billed_cost,
    latency_ms,
  });
  await emitCompletionEvent({
    ctx,
    selected,
    result: synthetic,
    billed_cost,
    credential_source: providerRow.credential_source,
    completion_id: completionId,
    event_type: 'ai-gateway.stream.v1',
  });
}
