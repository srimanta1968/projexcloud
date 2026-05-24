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

interface ProviderRow {
  provider_id: ProviderId;
  credential_envelope: Buffer;
  status: 'active' | 'degraded' | 'disabled';
}

async function loadProviderRow(provider_id: ProviderId): Promise<ProviderRow | null> {
  return dataService.one<ProviderRow>(
    `SELECT provider_id, credential_envelope, status
       FROM ai_gateway.provider WHERE provider_id = $1`,
    [provider_id],
  );
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
  const selected = await selectRoute(ctx, request);
  const providerRow = await loadProviderRow(selected.provider_id);
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
  const billed_cost = computeBilled(result.provider_cost);

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
  const selected = await selectRoute(ctx, request);
  const providerRow = await loadProviderRow(selected.provider_id);
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
  const billed_cost = computeBilled(approxProviderCost);

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
    completion_id: completionId,
    event_type: 'ai-gateway.stream.v1',
  });
}
