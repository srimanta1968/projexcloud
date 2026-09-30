import { createHmac, randomBytes, randomUUID } from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Bootstrap, ControlPlane, RuntimeLayerConfig } from '../controlPlane';
import { log } from '../log';
import { resample } from '../pipeline/speaker';
import { realProviders, type SessionProviders } from '../pipeline/voiceSession';
import { SessionStore } from '../session/sessionStore';
import { runScenario, type Scenario } from './scenarioRunner';

/**
 * Catalog certification runs (VA·E10 · TK-4519), executed by the voice runtime with keys from
 * the tenant key vault (the control plane hands them over with the job, as it does for a call).
 *
 *   llm  a reference agent (an order-status desk with one signed app tool) answers simulated
 *        callers: tool-call accuracy (right tool AND the order number the caller said), time to
 *        first token, and how fast it stops when interrupted.
 *   stt  reference sentences synthesised by a reference TTS, band-limited to 8 kHz like a phone
 *        line, streamed in real time into the STT under test: word error rate and the time from
 *        the end of speech to the final transcript.
 *   tts  the same sentences from the TTS under test: time to first audio and real-time factor;
 *        intelligibility is the word error rate of its (phone-band) audio through a reference STT.
 */

export interface CertificationJob {
  run_id: string;
  layer: 'llm' | 'stt' | 'tts';
  scope: 'platform' | 'tenant';
  subject: { provider: string; model: string; voice: string | null; language: string; key: string };
  reference: { layer: 'stt' | 'tts'; provider: string; model: string | null; voice: string | null; key: string } | null;
  thresholds: Record<string, number>;
}

export interface CertificationOutcome {
  passed: boolean;
  metrics: Record<string, unknown>;
}

/** Plain-language, number-free sentences a phone caller says (numbers would score formatting, not hearing). */
export const REFERENCE_SENTENCES = [
  'I would like to book an appointment for next Tuesday afternoon.',
  'Can you transfer me to someone in billing please?',
  'My name is Priya Raman and I am calling about my delivery.',
  'I want to cancel my subscription before the end of the month.',
  'Yes, that works for me, thank you very much.',
  'What time do you close on Saturday evening?',
  'The package arrived damaged and I need a replacement.',
  'Could you send the confirmation to my phone instead?',
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))];
}

const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

/** Word error rate: word-level edit distance / reference length. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const r = words(reference);
  const h = words(hypothesis);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  const d: number[] = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= h.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] === h[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return Math.min(1, d[h.length] / r.length);
}

/** Squeezes audio through an 8 kHz phone channel and back to `outRate`. */
export function phoneBand(pcm: Int16Array, rate: number, outRate = 16000): Int16Array {
  return resample(resample(pcm, rate, 8000), 8000, outRate);
}

async function synthesize(providers: SessionProviders, tts: { provider: string; model: string | null; voice: string | null; key: string }, text: string, language: string) {
  const provider = providers.tts(tts.provider);
  const opts = { key: tts.key, model: tts.model ?? undefined, voice: tts.voice ?? undefined, language };
  const rate = provider.sampleRate(opts);
  const started = Date.now();
  let firstAt: number | null = null;
  const chunks: Int16Array[] = [];
  for await (const pcm of provider.synthesize(text, opts, new AbortController().signal)) {
    if (firstAt === null) firstAt = Date.now();
    chunks.push(pcm);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Int16Array(total);
  let off = 0;
  for (const c of chunks) { pcm.set(c, off); off += c.length; }
  return { pcm, rate, ttfaMs: firstAt === null ? null : firstAt - started, synthMs: Date.now() - started, durationMs: (total / rate) * 1000 };
}

/**
 * Streams 16 kHz audio into an STT connection in real time, then silence, and returns what it
 * heard and how long after the end of speech the final transcript came.
 */
async function transcribe(providers: SessionProviders, stt: { provider: string; model: string | null; key: string }, pcm16k: Int16Array, language: string) {
  const conn = await providers.stt(stt.provider).connect({ key: stt.key, model: stt.model ?? undefined, language, sampleRate: 16000 });
  const finals: string[] = [];
  let lastFinalAt: number | null = null;
  let endOfTurn = false;
  let error: Error | null = null;
  conn.onTranscript((t) => {
    if (t.final && t.text) { finals.push(t.text); lastFinalAt = Date.now(); }
    if (t.endOfTurn) endOfTurn = true;
  });
  conn.onError((e) => { error = e; });
  const frame = 320; // 20 ms at 16 kHz
  let next = Date.now();
  for (let i = 0; i < pcm16k.length; i += frame) {
    conn.write(pcm16k.subarray(i, Math.min(i + frame, pcm16k.length)));
    next += 20;
    await sleep(next - Date.now());
  }
  const speechEnd = Date.now();
  const silence = new Int16Array(frame);
  const deadline = speechEnd + 5000;
  while (Date.now() < deadline && !endOfTurn && !error) {
    conn.write(silence);
    await sleep(20);
  }
  conn.close();
  if (error) throw error;
  return { heard: finals.join(' ').trim(), finalLatencyMs: lastFinalAt === null ? null : Math.max(0, lastFinalAt - speechEnd) };
}

/** A local app tool for the reference agent; records what it was asked. */
async function referenceTool(secret: string) {
  const calls: { order_id: unknown; signed: boolean }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(req.headers['x-projexcloud-signature'] ?? ''));
      const signed = !!m && createHmac('sha256', secret).update(`${m[1]}.${String(req.headers['idempotency-key'] ?? '')}.${raw}`).digest('hex') === m[2];
      let args: Record<string, unknown> = {};
      try { args = (JSON.parse(raw) as { arguments?: Record<string, unknown> }).arguments ?? {}; } catch { /* malformed */ }
      calls.push({ order_id: args.order_id, signed });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ order_id: args.order_id ?? null, status: 'shipped', arriving: 'Friday' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/lookup_order`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const LLM_TOOL_CASES = [
  { say: 'Hi, can you check on order four four one seven for me?', digits: '4417' },
  { say: 'What is the status of my order, number nine zero two one zero?', digits: '90210' },
  { say: 'I placed order three three one eight last week, where is it now?', digits: '3318' },
];

export async function certifyLlm(job: CertificationJob, providers: SessionProviders = realProviders): Promise<CertificationOutcome> {
  const secret = randomBytes(16).toString('hex');
  const tool = await referenceTool(secret);
  const layer: RuntimeLayerConfig = { provider: job.subject.provider, model: job.subject.model, primary: { binding_id: 'certification', provider: job.subject.provider, priority: 'primary', key: job.subject.key }, secondary: null };
  const inert: RuntimeLayerConfig = { provider: 'loopback', primary: { binding_id: 'certification', provider: 'loopback', priority: 'primary', key: '' }, secondary: null };
  const boot = (): Bootstrap => ({
    action: 'agent',
    call: {
      call_id: randomUUID(), tenant_id: 'certification', direction: 'inbound', is_test: true, status: 'in_progress', from_number: null, to_number: null,
      subject_ref: null, jurisdiction: null, recording_consent: null, gate_verdicts: null, context: { certification_run_id: job.run_id },
    },
    agent: {
      agent_id: 'certification', name: 'Reference agent', version_id: 'certification', version_no: 1,
      system_prompt: 'You are the phone assistant for Acme Outdoor. When a caller asks about an order, call the lookup_order tool with the order number they give (digits only), then tell them the status in one sentence. Otherwise answer briefly and helpfully.',
      greeting: 'Thanks for calling Acme Outdoor.', language: job.subject.language, escalation_rules: {}, business_hours: {}, kb_corpus_ids: [],
    },
    stack: { profile_id: 'certification', preset_key: 'certification', certified: false, layers: { stt: inert, llm_fast: layer, llm_complex: layer, tts: inert } },
    tools: [{
      tool_id: 'certification-lookup', name: 'lookup_order', description: 'Look up the status of a customer order by its order number.',
      json_schema: { type: 'object', properties: { order_id: { type: 'string', description: 'The order number, digits only' } }, required: ['order_id'] },
      url: tool.url, timeout_ms: 3000, idempotent: true, signing_secret: secret,
    }],
    recording: { permitted: false, notice: false, basis: 'test_call', rule: null, jurisdiction: null },
    session_token: { token: 'certification', token_id: 'certification', expires_at: new Date(Date.now() + 3_600_000).toISOString(), allowed_tools: ['lookup_order'] },
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    first_bootstrap: true,
  });
  // No call record exists: tool authorization is local, nothing is reported to the platform.
  const controlPlane = {
    validateTools: async (_c: string, _t: string, tools: string[]) => new Map(tools.map((t) => [t, { valid: true }])),
    credentialDegraded: async () => ({}),
  } as unknown as ControlPlane;
  const store = new SessionStore(null, 'certification', 900);
  const run = (scenario: Scenario) => runScenario({ boot: boot(), scenario, mode: 'evaluation', controlPlane, store, agentLlm: providers.llm });

  try {
    const ttft: number[] = [];
    let correct = 0;
    const toolCases: { say: string; expected: string; got: unknown; ok: boolean; error: string | null }[] = [];
    let answeredAll = true;
    for (const c of LLM_TOOL_CASES) {
      const before = tool.calls.length;
      const { result } = await run({ name: 'tool', turns: [{ say: c.say }] });
      ttft.push(...result.ttft_ms);
      const got = tool.calls.slice(before).find((x) => x.signed)?.order_id;
      const ok = String(got ?? '').replace(/\D/g, '') === c.digits;
      if (ok) correct += 1;
      if (result.error || !result.checks.find((k) => k.name === 'answered')?.passed) answeredAll = false;
      toolCases.push({ say: c.say, expected: c.digits, got: got ?? null, ok, error: result.error });
    }
    const { result: barge } = await run({
      name: 'barge-in',
      turns: [{ say: 'Can you describe everything you sell and your full return policy in detail?' }, { say: 'Sorry, one quick question.', interrupt: true }],
    });
    ttft.push(...barge.ttft_ms);
    const bargeMax = barge.barge_in_stop_ms.length ? Math.max(...barge.barge_in_stop_ms) : null;
    const metrics = {
      ttft_p50_ms: percentile(ttft, 0.5),
      ttft_p95_ms: percentile(ttft, 0.95),
      tool_accuracy: correct / LLM_TOOL_CASES.length,
      barge_in_max_stop_ms: bargeMax,
      answered_all: answeredAll,
      tool_cases: toolCases,
    };
    const t = job.thresholds;
    const passed = metrics.ttft_p95_ms !== null && metrics.ttft_p95_ms <= t.ttft_p95_ms
      && metrics.tool_accuracy >= t.tool_accuracy_min
      && bargeMax !== null && bargeMax <= t.barge_in_stop_ms
      && answeredAll;
    return { passed, metrics };
  } finally {
    await tool.close();
  }
}

export async function certifyStt(job: CertificationJob, providers: SessionProviders = realProviders, sentences = REFERENCE_SENTENCES): Promise<CertificationOutcome> {
  if (!job.reference || job.reference.layer !== 'tts') throw new Error('an stt certification needs a reference tts key');
  const samples: { text: string; heard: string; wer: number; final_latency_ms: number | null }[] = [];
  for (const text of sentences) {
    const audio = await synthesize(providers, job.reference, text, job.subject.language);
    const { heard, finalLatencyMs } = await transcribe(providers, job.subject, phoneBand(audio.pcm, audio.rate), job.subject.language);
    samples.push({ text, heard, wer: wordErrorRate(text, heard), final_latency_ms: finalLatencyMs });
  }
  const wers = samples.map((s) => s.wer);
  const lat = samples.map((s) => s.final_latency_ms).filter((v): v is number => v !== null);
  const metrics = {
    wer_mean: wers.reduce((a, b) => a + b, 0) / wers.length,
    wer_max: Math.max(...wers),
    final_latency_p95_ms: percentile(lat, 0.95),
    missing_finals: samples.filter((s) => s.final_latency_ms === null).length,
    phone_band_hz: 8000,
    reference: { provider: job.reference.provider, model: job.reference.model },
    samples,
  };
  const t = job.thresholds;
  const passed = metrics.wer_mean <= t.wer_max && metrics.missing_finals === 0
    && metrics.final_latency_p95_ms !== null && metrics.final_latency_p95_ms <= t.final_latency_p95_ms;
  return { passed, metrics };
}

export async function certifyTts(job: CertificationJob, providers: SessionProviders = realProviders, sentences = REFERENCE_SENTENCES): Promise<CertificationOutcome> {
  if (!job.reference || job.reference.layer !== 'stt') throw new Error('a tts certification needs a reference stt key');
  const samples: { text: string; ttfa_ms: number | null; rtf: number; heard: string; wer: number }[] = [];
  for (const text of sentences) {
    const audio = await synthesize(providers, job.subject, text, job.subject.language);
    const rtf = audio.durationMs > 0 ? audio.synthMs / audio.durationMs : Infinity;
    const { heard } = audio.pcm.length ? await transcribe(providers, job.reference, phoneBand(audio.pcm, audio.rate), job.subject.language) : { heard: '' };
    samples.push({ text, ttfa_ms: audio.ttfaMs, rtf: Math.round(rtf * 1000) / 1000, heard, wer: wordErrorRate(text, heard) });
  }
  const ttfa = samples.map((s) => s.ttfa_ms).filter((v): v is number => v !== null);
  const metrics = {
    ttfa_p95_ms: percentile(ttfa, 0.95),
    rtf_mean: samples.reduce((a, s) => a + s.rtf, 0) / samples.length,
    wer_mean: samples.reduce((a, s) => a + s.wer, 0) / samples.length,
    silent_samples: samples.filter((s) => s.ttfa_ms === null).length,
    phone_band_hz: 8000,
    reference: { provider: job.reference.provider, model: job.reference.model },
    samples,
  };
  const t = job.thresholds;
  const passed = metrics.silent_samples === 0 && metrics.ttfa_p95_ms !== null && metrics.ttfa_p95_ms <= t.ttfa_p95_ms
    && metrics.rtf_mean <= t.rtf_max && metrics.wer_mean <= t.wer_max;
  return { passed, metrics };
}

export async function runCertification(job: CertificationJob, controlPlane: ControlPlane, worker: string): Promise<void> {
  log.info('certification run started', { runId: job.run_id, layer: job.layer, provider: job.subject.provider, model: job.subject.model, scope: job.scope });
  try {
    const outcome = job.layer === 'llm' ? await certifyLlm(job) : job.layer === 'stt' ? await certifyStt(job) : await certifyTts(job);
    await controlPlane.finishCertificationRun(job.run_id, { worker, status: 'completed', passed: outcome.passed, metrics: outcome.metrics });
    log.info('certification run finished', { runId: job.run_id, passed: outcome.passed });
  } catch (err) {
    log.error('certification run could not complete', { runId: job.run_id, error: (err as Error).message });
    await controlPlane.finishCertificationRun(job.run_id, { worker, status: 'error', error: (err as Error).message })
      .catch((e: Error) => log.error('could not report the certification error', { runId: job.run_id, error: e.message }));
  }
}
