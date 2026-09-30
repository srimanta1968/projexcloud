import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { listTenantCredentials, withTenantCredentialKey } from '@projexlight/sdk-ai-gateway';
import { conflict, notFound, validationError, SpeechError } from '../models/errors';
import { getCatalogEntry, type CatalogEntry } from './catalogService';

/**
 * Certification runs (VA·E10 · TK-4519). A catalog entry is certified ONLY by passing one.
 *
 * The key under test comes from the tenant key vault — ProjexCloud holds no provider keys of
 * its own. A platform run uses a key the operator's tenant keeps in the vault and certifies the
 * entry for everyone; a tenant run uses the tenant's own key and certifies it for that tenant.
 *
 *   llm  reference agent scenarios: tool-call accuracy, time to first token, barge-in
 *   stt  phone-band audio from a REFERENCE tts key -> the stt under test: word error rate,
 *        time from end of speech to the final transcript
 *   tts  the tts under test: time to first audio, real-time factor, and intelligibility
 *        through a REFERENCE stt key
 *
 * A voice-runtime worker claims the run (it receives the decrypted keys, exactly as a call
 * bootstrap does), executes it and reports metrics; thresholds are fixed at start so the
 * verdict is judged against what the run was started with.
 */

export const CERT_SCOPES = ['platform', 'tenant'] as const;
export type CertScope = (typeof CERT_SCOPES)[number];
const CERTIFIABLE = ['llm', 'stt', 'tts'] as const;
/** The layer the reference key must be for, per layer under test. */
const REFERENCE_LAYER: Record<string, 'stt' | 'tts' | null> = { llm: null, stt: 'tts', tts: 'stt' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEASE_MS = Number(process.env.SPEECH_CERT_LEASE_MS ?? 15 * 60 * 1000);
const AUDIT_POOL = process.env.SPEECH_AUDIT_POOL || 'admin-default';

/** Pass thresholds, from the environment at start time (recorded on the run). */
export function certificationThresholds(layer: string): Record<string, number> {
  const n = (name: string, fallback: number): number => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  if (layer === 'llm') {
    return {
      ttft_p95_ms: n('SPEECH_CERT_LLM_TTFT_P95_MS', 1500),
      tool_accuracy_min: n('SPEECH_CERT_LLM_TOOL_ACCURACY', 0.9),
      barge_in_stop_ms: n('SPEECH_CERT_BARGE_IN_MS', 250),
    };
  }
  if (layer === 'stt') return { wer_max: n('SPEECH_CERT_STT_WER', 0.15), final_latency_p95_ms: n('SPEECH_CERT_STT_FINAL_MS', 1200) };
  return { ttfa_p95_ms: n('SPEECH_CERT_TTS_TTFA_P95_MS', 800), rtf_max: n('SPEECH_CERT_TTS_RTF', 1), wer_max: n('SPEECH_CERT_TTS_WER', 0.2) };
}

export interface CertificationRun {
  run_id: string;
  entry_id: string;
  catalog_key: string;
  layer: string;
  scope: CertScope;
  tenant_id: string;
  binding_id: string;
  reference_binding_id: string | null;
  status: 'queued' | 'running' | 'completed' | 'error';
  passed: boolean | null;
  metrics: Record<string, unknown>;
  thresholds: Record<string, number>;
  error: string | null;
  requested_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface Row extends Omit<CertificationRun, 'created_at' | 'started_at' | 'finished_at'> {
  created_at: Date; started_at: Date | null; finished_at: Date | null;
  reference_model: string | null; reference_voice: string | null; claimed_by: string | null;
}
const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);
const toRun = ({ reference_model: _m, reference_voice: _v, claimed_by: _c, ...r }: Row): CertificationRun => ({
  ...r, created_at: iso(r.created_at)!, started_at: iso(r.started_at), finished_at: iso(r.finished_at),
});
const COLUMNS = `r.run_id, r.entry_id, e.catalog_key, e.layer, r.scope, r.tenant_id, r.binding_id, r.reference_binding_id,
  r.reference_model, r.reference_voice, r.status, r.passed, r.metrics, r.thresholds, r.error, r.requested_by, r.claimed_by,
  r.created_at, r.started_at, r.finished_at`;
const FROM = `speech.certification_run r JOIN speech.catalog_entry e ON e.entry_id = r.entry_id`;

export interface StartCertificationInput {
  binding_id?: unknown;
  reference_binding_id?: unknown;
  reference_model?: unknown;
  reference_voice?: unknown;
}

/**
 * Queues a certification run of `entryId` with a vault key of `tenantId`.
 *
 * @throws SpeechError 400 (bad input, wrong key for the entry, missing reference key),
 *   404 unknown entry, 409 a run for this entry and tenant is already queued or running.
 */
export async function startCertificationRun(
  scope: CertScope, tenantId: string, entryId: string, input: StartCertificationInput, requestedBy: string,
): Promise<CertificationRun> {
  if (!UUID_RE.test(entryId)) throw notFound('catalog entry not found');
  const entry = await getCatalogEntry(entryId);
  if (!entry) throw notFound('catalog entry not found');
  if (!(CERTIFIABLE as readonly string[]).includes(entry.layer)) throw validationError(`${entry.layer} entries cannot be certified by a run yet`);
  if (typeof input.binding_id !== 'string' || !UUID_RE.test(input.binding_id)) throw validationError('binding_id (a key from your key vault) is required');

  const bindings = await listTenantCredentials({ tenant_id: tenantId, status: 'active' });
  const key = bindings.find((b) => b.binding_id === input.binding_id);
  if (!key) throw validationError('binding_id is not an active key of this tenant');
  if (key.layer !== entry.layer) throw validationError(`binding_id is a ${key.layer} key; this entry needs a ${entry.layer} key`);
  if (key.provider_id !== entry.provider) throw validationError(`binding_id is a ${key.provider_id} key; this entry is ${entry.provider}`);

  const refLayer = REFERENCE_LAYER[entry.layer];
  let refId: string | null = null;
  if (refLayer) {
    if (typeof input.reference_binding_id !== 'string' || !UUID_RE.test(input.reference_binding_id)) {
      throw validationError(`reference_binding_id (a ${refLayer} key) is required: ${entry.layer} is certified by an audio loopback through a ${refLayer} provider`);
    }
    const ref = bindings.find((b) => b.binding_id === input.reference_binding_id);
    if (!ref || ref.layer !== refLayer) throw validationError(`reference_binding_id must be an active ${refLayer} key of this tenant`);
    refId = ref.binding_id;
  }
  const opt = (v: unknown, field: string): string | null => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || v.length > 200) throw validationError(`${field} must be a string`);
    return v;
  };

  const busy = await dataService.one<{ run_id: string }>(
    `SELECT run_id FROM speech.certification_run WHERE entry_id = $1 AND tenant_id = $2 AND status IN ('queued', 'running') LIMIT 1`,
    [entryId, tenantId],
  );
  if (busy) throw conflict('a certification run of this entry is already in progress');
  const row = await dataService.one<{ run_id: string }>(
    `INSERT INTO speech.certification_run (entry_id, scope, tenant_id, binding_id, reference_binding_id, reference_model, reference_voice, thresholds, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING run_id`,
    [entryId, scope, tenantId, key.binding_id, refId, opt(input.reference_model, 'reference_model'), opt(input.reference_voice, 'reference_voice'),
      JSON.stringify(certificationThresholds(entry.layer)), requestedBy],
  );
  return getCertificationRun(row!.run_id, scope === 'tenant' ? tenantId : null);
}

/** A run; `tenantId` scopes it (null = operator view). @throws SpeechError 404. */
export async function getCertificationRun(runId: string, tenantId: string | null): Promise<CertificationRun> {
  if (!UUID_RE.test(runId)) throw notFound('certification run not found');
  const row = await dataService.one<Row>(`SELECT ${COLUMNS} FROM ${FROM} WHERE r.run_id = $1 AND ($2::uuid IS NULL OR r.tenant_id = $2::uuid)`, [runId, tenantId]);
  if (!row) throw notFound('certification run not found');
  return toRun(row);
}

/** Runs of an entry, newest first; `tenantId` limits them to that tenant's (null = all). */
export async function listCertificationRuns(entryId: string, tenantId: string | null, limit = 20): Promise<CertificationRun[]> {
  if (!UUID_RE.test(entryId)) throw notFound('catalog entry not found');
  const rows = await dataService.rows<Row>(
    `SELECT ${COLUMNS} FROM ${FROM} WHERE r.entry_id = $1 AND ($2::uuid IS NULL OR r.tenant_id = $2::uuid)
      ORDER BY r.created_at DESC LIMIT $3`,
    [entryId, tenantId, Math.min(Math.max(limit, 1), 100)],
  );
  return rows.map(toRun);
}

/** Entries this tenant certified for itself, by catalog_key (for stack-profile checks). */
export async function findTenantCertifications(tenantId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0 || !UUID_RE.test(tenantId)) return new Set();
  const rows = await dataService.rows<{ catalog_key: string }>(
    `SELECT e.catalog_key FROM speech.tenant_certification t JOIN speech.catalog_entry e ON e.entry_id = t.entry_id
      WHERE t.tenant_id = $1 AND e.catalog_key = ANY($2::text[])`,
    [tenantId, keys],
  );
  return new Set(rows.map((r) => r.catalog_key));
}

// ------------------------------------------------------------------------------------------
// Runtime side (operator routes).

export interface CertificationJob {
  run_id: string;
  layer: 'llm' | 'stt' | 'tts';
  scope: CertScope;
  subject: { provider: string; model: string; voice: string | null; language: string; key: string };
  reference: { layer: 'stt' | 'tts'; provider: string; model: string | null; voice: string | null; key: string } | null;
  thresholds: Record<string, number>;
}

function firstVoice(entry: CatalogEntry | null): string | null {
  const v = (entry?.voices ?? [])[0] as { id?: string } | undefined;
  return v?.id ?? null;
}

/**
 * Leases the oldest queued (or lease-expired) run to `worker` and hands it the keys it needs.
 * A run whose key has since been revoked is finished as an error instead.
 */
export async function claimCertificationRun(worker: unknown): Promise<CertificationJob | null> {
  if (typeof worker !== 'string' || !worker || worker.length > 200) throw validationError('worker is required');
  for (;;) {
    const row = await dataService.one<Row>(
      `WITH next AS (
         SELECT run_id FROM speech.certification_run
          WHERE status = 'queued' OR (status = 'running' AND lease_until < now())
          ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       UPDATE speech.certification_run c SET status = 'running', claimed_by = $1,
              lease_until = now() + ($2::bigint * interval '1 millisecond'), started_at = COALESCE(started_at, now())
         FROM next WHERE c.run_id = next.run_id
       RETURNING c.run_id`,
      [worker, LEASE_MS],
    );
    if (!row) return null;
    const run = await dataService.one<Row>(`SELECT ${COLUMNS} FROM ${FROM} WHERE r.run_id = $1`, [row.run_id]);
    if (!run) continue;
    const entry = await getCatalogEntry(run.entry_id);
    try {
      const subjectKey = await withTenantCredentialKey(run.tenant_id, run.binding_id, async (k) => k);
      let reference: CertificationJob['reference'] = null;
      if (run.reference_binding_id) {
        reference = await withTenantCredentialKey(run.tenant_id, run.reference_binding_id, async (k, b) => {
          const refLayer = REFERENCE_LAYER[run.layer] as 'stt' | 'tts';
          // The reference model: the one asked for, else a certified catalog entry of that provider.
          const catalogRef = run.reference_model ? null : await dataService.one<{ model: string; voices: unknown }>(
            `SELECT model, voices FROM speech.catalog_entry WHERE layer = $1 AND provider = $2
              ORDER BY (certification_status = 'certified') DESC, created_at LIMIT 1`,
            [refLayer, b.provider_id],
          );
          const refVoice = run.reference_voice ?? ((catalogRef?.voices as { id?: string }[] | undefined)?.[0]?.id ?? null);
          return { layer: refLayer, provider: b.provider_id, model: run.reference_model ?? catalogRef?.model ?? null, voice: refVoice, key: k };
        });
      }
      return {
        run_id: run.run_id,
        layer: run.layer as CertificationJob['layer'],
        scope: run.scope,
        subject: { provider: entry!.provider, model: entry!.model, voice: firstVoice(entry), language: entry!.languages[0] ?? 'en', key: subjectKey },
        reference,
        thresholds: run.thresholds,
      };
    } catch (err) {
      await finish(run.run_id, { status: 'error', error: `key unavailable: ${(err as Error).message}` });
    }
  }
}

async function finish(runId: string, r: { status: 'completed' | 'error'; passed?: boolean; metrics?: Record<string, unknown>; error?: string }): Promise<Row> {
  const row = await dataService.one<{ run_id: string }>(
    `UPDATE speech.certification_run SET status = $2, passed = $3, metrics = $4::jsonb, error = $5, finished_at = now(), lease_until = NULL
      WHERE run_id = $1 RETURNING run_id`,
    [runId, r.status, r.status === 'completed' ? r.passed === true : null, JSON.stringify(r.metrics ?? {}), r.status === 'error' ? (r.error ?? 'the run could not complete').slice(0, 1000) : null],
  );
  const run = await dataService.one<Row>(`SELECT ${COLUMNS} FROM ${FROM} WHERE r.run_id = $1`, [row!.run_id]);
  return run!;
}

/**
 * Records the outcome. A PASS certifies: platform scope -> the catalog entry (every tenant),
 * tenant scope -> that tenant only. A tenant run that fails withdraws the tenant's own earlier
 * certification of the entry; a failing platform run leaves the catalog as it is (an operator
 * revokes explicitly) — the run is on record either way.
 *
 * @throws SpeechError 400 / 404 / 409 the worker does not hold the run.
 */
export async function finishCertificationRun(runId: string, input: { worker?: unknown; status?: unknown; passed?: unknown; metrics?: unknown; error?: unknown }): Promise<CertificationRun> {
  if (!UUID_RE.test(runId)) throw notFound('certification run not found');
  const held = await dataService.one<{ status: string; claimed_by: string | null }>(`SELECT status, claimed_by FROM speech.certification_run WHERE run_id = $1`, [runId]);
  if (!held) throw notFound('certification run not found');
  if (held.status !== 'running' || held.claimed_by !== input.worker) throw conflict('this worker does not hold the certification run');
  const status = input.status ?? 'completed';
  if (status !== 'completed' && status !== 'error') throw validationError('status must be completed or error');
  if (status === 'completed' && typeof input.passed !== 'boolean') throw validationError('passed (boolean) is required for a completed run');
  if (input.metrics !== undefined && (typeof input.metrics !== 'object' || input.metrics === null || Array.isArray(input.metrics))) throw validationError('metrics must be an object');

  const run = await finish(runId, {
    status, passed: input.passed as boolean | undefined, metrics: input.metrics as Record<string, unknown> | undefined,
    error: typeof input.error === 'string' ? input.error : undefined,
  });
  if (run.status === 'completed' && run.passed) {
    const certMetrics = { ...run.metrics, thresholds: run.thresholds, run_id: run.run_id, provisional: false, certified_by: run.scope };
    if (run.scope === 'platform') {
      await dataService.query(
        `UPDATE speech.catalog_entry SET certification_status = 'certified', certified_at = now(), cert_metrics = $2::jsonb,
                updated_at = now(), updated_by = $3 WHERE entry_id = $1`,
        [run.entry_id, JSON.stringify(certMetrics), `certification-run:${run.run_id}`],
      );
    } else {
      await dataService.query(
        `INSERT INTO speech.tenant_certification (tenant_id, entry_id, run_id, metrics) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (tenant_id, entry_id) DO UPDATE SET run_id = EXCLUDED.run_id, metrics = EXCLUDED.metrics, certified_at = now()`,
        [run.tenant_id, run.entry_id, run.run_id, JSON.stringify(certMetrics)],
      );
    }
  } else if (run.status === 'completed' && run.scope === 'tenant') {
    await dataService.query(`DELETE FROM speech.tenant_certification WHERE tenant_id = $1 AND entry_id = $2`, [run.tenant_id, run.entry_id]);
  }
  await emitEvent({
    event_type: 'speech.certification_run.completed.v1',
    pool_index: AUDIT_POOL,
    actor_kind: 'agent',
    actor_id: 'voice-runtime',
    tenant_id: run.tenant_id,
    subject_kind: 'speech.catalog_entry',
    subject_id: run.entry_id,
    payload: { run_id: run.run_id, catalog_key: run.catalog_key, scope: run.scope, status: run.status, passed: run.passed },
  });
  return toRun(run);
}

export { SpeechError };
