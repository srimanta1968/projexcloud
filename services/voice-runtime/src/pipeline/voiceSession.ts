import type { ChatMessage, CompletionRequest, ToolCallRecord } from '@projexlight/contracts';
import type { Conversation } from '../call/callRunner';
import type { ControlPlane } from '../controlPlane';
import { log } from '../log';
import { llmAdapter } from '../providers/llm';
import { sttProvider } from '../providers/stt';
import { ttsProvider } from '../providers/tts';
import type { SttProvider, SttStream, Transcript, TtsProvider } from '../providers/types';
import type { ProviderAdapter } from '@projexlight/llm-adapters';
import { LiveKitMedia, type AudioSink, type CallMedia } from './media';
import type { SessionContext, SessionStore, TurnRecord } from '../session/sessionStore';
import { ToolExecutor, toolMessage } from '../tools/toolExecutor';
import { TRANSFER_TOOL, summarizeForHandoff, transferAvailable, transferToolManifest } from '../call/transfer';
import { ClauseChunker } from './chunker';
import { openingDisclosure } from './disclosure';
import { FILLER_THRESHOLD_MS, FillerPolicy } from './fillers';
import { Speaker, type TtsBinding } from './speaker';
import { soundsIncomplete, turnConfig, type TurnConfig } from './turnDetector';
import { classifyTurn, routerConfig } from './turnRouter';
import { EnergyVad, vadConfig } from './vad';
import { LayerFailover, type ActiveLayer, type Degradation } from './failover';
import { noopTurnSink, type TurnEventSink } from '../session/turnEvents';
import type { RuntimeLayer } from '../controlPlane';

/**
 * One live voice conversation (VA·E1 · TK-4458): caller audio -> streaming STT -> end of
 * turn -> streaming LLM -> clause chunker -> streaming TTS -> agent audio, with every stage
 * overlapping the next: the first clause is spoken while the model is still generating.
 *
 * Everything a turn needs is already in memory (the call bootstrap); a turn talks only to
 * the speech/LLM providers with the call's own keys — never the control plane or Postgres.
 */

/** Agent audio sample rate; TTS output at any rate is resampled to it. */
export const OUT_RATE = 24000;
/** Caller audio as sent to STT. */
export const IN_RATE = 16000;

/**
 * Spoken-output rules prepended to every agent prompt. Stable per agent version, so the
 * system block is identical across calls and provider prompt caches hit (call-specific
 * context goes in the first user message instead, after the cached prefix).
 */
export const VOICE_RULES = [
  'You are a voice agent on a live phone call.',
  'Speak naturally in short sentences, the way a person talks on the phone.',
  'Never use markdown, lists, emojis, URLs or special characters: everything you write is read aloud.',
  'Keep replies brief unless the caller asks for detail. Say numbers, dates and times the way people say them aloud.',
].join(' ');

const FALLBACK_LINE = "Sorry, I'm having trouble on my end. Could you say that again?";
/** Spoken when a turn that used tools produced no answer (e.g. the model failed after a tool timeout). */
const TOOL_FALLBACK_LINE = "Sorry, I couldn't get that information right now. Can I help you with something else, or arrange a call back?";
/** Model rounds with tools offered per caller turn (a final round never offers tools). */
const MAX_TOOL_ROUNDS = 3;

/** Where a session gets its speech and LLM providers: the real registries, or fakes (sim/). */
export interface SessionProviders {
  stt(id: string): SttProvider;
  tts(id: string): TtsProvider;
  llm(id: string): ProviderAdapter;
}
export const realProviders: SessionProviders = { stt: sttProvider, tts: ttsProvider, llm: llmAdapter };

/** Hooks for the evaluation harness (TK-4518); a live call has none. */
export interface SessionObserver {
  onBargeIn?(stopMs: number, heard: string): void;
}

export interface VoiceSessionOptions {
  turnEvents?: TurnEventSink;
  providers?: SessionProviders;
  observer?: SessionObserver;
}

export class VoiceSession {
  readonly history: ChatMessage[] = [];
  private source!: AudioSink;
  protected speaker!: Speaker;
  protected stt: SttStream | null = null;
  private pendingUser: string[] = [];
  private turnChain: Promise<void> = Promise.resolve();
  protected ended = false;
  protected readonly systemPrompt: string;
  /** Which key each layer is on right now (TK-4465). */
  protected readonly failover: LayerFailover;
  /** The TTS binding for a clause, resolved when it is synthesized (follows TTS failover). */
  protected readonly tts = (): TtsBinding => {
    const a = this.failover.active('tts');
    return { provider: this.providers.tts(a.provider), opts: { key: a.handle.key, model: a.model, voice: a.voice, language: this.session.boot.agent.language, options: a.options } };
  };
  // Turn-taking (TK-4459).
  protected readonly turnCfg: TurnConfig;
  private readonly vad: EnergyVad;
  private holdTimer: NodeJS.Timeout | null = null;
  private vadEndTimer: NodeJS.Timeout | null = null;
  private lastSpeechEndAt: number | null = null;
  /** Aborts the in-flight LLM stream of the turn being answered. */
  private turnAbort: AbortController | null = null;
  /** The agent line currently being spoken (greeting or reply), to mark on barge-in. */
  private speakingRec: TurnRecord | null = null;
  private readonly router: ReturnType<typeof routerConfig>;
  protected readonly tools: ToolExecutor;
  private readonly fillers: FillerPolicy;
  private readonly controlPlane: ControlPlane;
  /** The agent version can escalate to a human (escalation_rules.transfer). */
  private readonly canTransfer: boolean;
  /** True while the mandatory disclosure plays: barge-in cannot cut it short. */
  private protectedLine = false;

  protected readonly turnEvents: TurnEventSink;
  protected readonly providers: SessionProviders;
  private readonly observer: SessionObserver;

  constructor(
    protected readonly media: CallMedia,
    protected readonly session: SessionContext,
    protected readonly signal: AbortSignal,
    protected readonly store: SessionStore,
    controlPlane: ControlPlane,
    opts: VoiceSessionOptions = {},
  ) {
    this.turnEvents = opts.turnEvents ?? noopTurnSink;
    this.providers = opts.providers ?? realProviders;
    this.observer = opts.observer ?? {};
    const b = session.boot;
    this.systemPrompt = `${VOICE_RULES}\n\n${b.agent.system_prompt}`;
    this.failover = new LayerFailover(b.stack.layers);
    const sttOpts = b.stack.layers.stt.options;
    this.turnCfg = turnConfig(sttOpts);
    const td = ((sttOpts?.turn_detection ?? {}) as Record<string, unknown>);
    this.vad = new EnergyVad(vadConfig(td.sensitivity, { minSpeechMs: td.min_interruption_ms, minSilenceMs: td.min_silence_ms }, IN_RATE));
    this.router = routerConfig(b.agent.escalation_rules);
    this.tools = new ToolExecutor(session, controlPlane);
    this.fillers = new FillerPolicy(b.agent.language);
    this.controlPlane = controlPlane;
    this.canTransfer = transferAvailable(b.agent.escalation_rules);
  }


  protected elapsed(at = Date.now()): number {
    return at - this.session.openedAt;
  }

  protected record(t: Omit<TurnRecord, 'turn_index'>): TurnRecord {
    const rec = { turn_index: this.session.turns.length, ...t };
    this.session.turns.push(rec);
    return rec;
  }

  async run(): Promise<void> {
    const b = this.session.boot;
    // 200 ms queue: frames are captured close to real time, so 'heard' on barge-in and
    // speaker idle() track what the caller actually heard (the default queue is 1 s).
    this.source = await this.media.openAgentAudio(OUT_RATE, 200);
    this.speaker = new Speaker(this.source, OUT_RATE);

    this.speaker.onError((err) => {
      const d = this.failover.report('tts', (err as { status?: number }).status, err.message);
      if (d) this.reportDegraded(d);
      return d !== null && d.to !== null;
    });
    if (!(await this.connectStt())) {
      log.error('speech-to-text unavailable, ending call', { callId: this.session.callId });
      this.speaker.say("Sorry, I'm having trouble on my end. Please call back in a moment.", this.tts);
      await this.speaker.idle();
      return this.cleanup();
    }

    await this.greet();
    void this.pumpCallerAudio();
    await this.media.untilEnds();
    await this.cleanup();
  }

  /** The harness: resolves once every queued turn is answered and the agent has stopped talking. */
  async settled(): Promise<void> {
    await this.turnChain;
    await this.speaker.idle();
  }

  /** The harness: the agent is talking (or about to) right now. */
  get agentBusy(): boolean {
    return this.speaker.busy || this.turnAbort !== null;
  }

  /**
   * Connects speech-to-text on the layer's current key. A retryable failure — at connect or
   * mid-call — trips STT to its secondary and reconnects at once (TK-4465). Returns false
   * when no STT could be connected.
   */
  private async connectStt(): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const a = this.failover.active('stt');
      try {
        const stt = await this.providers.stt(a.provider).connect({
          key: a.handle.key, model: a.model, language: this.session.boot.agent.language, sampleRate: IN_RATE, options: a.options,
        });
        this.stt = stt;
        stt.onTranscript((t) => { if (this.stt === stt) this.onTranscript(t); });
        stt.onError((err) => {
          if (this.stt !== stt || this.ended) return;
          log.warn('stt error mid-call', { callId: this.session.callId, provider: a.provider, error: err.message });
          const d = this.failover.report('stt', (err as { status?: number }).status, err.message);
          if (!d) return;
          this.reportDegraded(d);
          if (!d.to) return;
          stt.close();
          void this.connectStt().then((ok) => { if (!ok) log.error('stt failover could not connect', { callId: this.session.callId }); });
        });
        return true;
      } catch (err) {
        const d = this.failover.report('stt', (err as { status?: number }).status, (err as Error).message);
        if (d) this.reportDegraded(d);
        if (!d?.to) return false;
      }
    }
    return false;
  }

  /** Turn metrics to Kafka (TK-4467) — never the text. */
  private publishTurn(rec: TurnRecord, tier: 'fast' | 'complex', llmMs: number, llmFailed: boolean): void {
    const b = this.session.boot;
    const caller = this.session.turns.slice(0, rec.turn_index).reverse().find((t) => t.speaker === 'caller');
    const tools = rec.tool_calls ?? [];
    this.turnEvents.publish({
      call_id: this.session.callId,
      tenant_id: this.session.tenantId,
      agent_id: b.agent.agent_id,
      agent_version_id: b.agent.version_id,
      is_test: b.call.is_test,
      turn_index: rec.turn_index,
      tier,
      model: rec.model ?? null,
      stt_ms: caller?.stt_ms ?? null,
      ttft_ms: rec.ttft_ms ?? null,
      ttfa_ms: rec.ttfa_ms ?? null,
      llm_ms: llmMs,
      interrupted: rec.interrupted,
      tool_calls: tools.length,
      tool_errors: tools.filter((t) => !t.ok).length,
      llm_failed: llmFailed,
      failed_over: (['stt', 'llm_fast', 'llm_complex', 'tts'] as const).filter((l) => this.failover.isTripped(l)),
      at: new Date().toISOString(),
    });
  }

  /** Tells the control plane a layer's primary failed (voice.credential.degraded.v1). Never throws. */
  protected reportDegraded(d: Degradation): void {
    log.warn('provider degraded', { callId: this.session.callId, layer: d.layer, provider: d.from.provider, status: d.status, switched_to: d.toProvider });
    this.controlPlane.credentialDegraded(this.session.callId, {
      layer: d.layer,
      binding_id: d.from.binding_id,
      provider: d.from.provider,
      status: d.status,
      error: d.error,
      switched_to_binding_id: d.to?.binding_id ?? null,
      switched_to_provider: d.toProvider,
    }).catch((err: Error) => log.warn('could not report degradation', { callId: this.session.callId, error: err.message }));
  }

  /**
   * Opening (TK-4461): the platform's AI disclosure — plus the recording notice when the
   * bootstrap says the call may be recorded — ALWAYS comes first and plays to the end even
   * if the caller talks over it; then the agent's greeting (interruptible as usual).
   */
  protected async greet(): Promise<void> {
    const b = this.session.boot;
    const disclosure = openingDisclosure(b.agent.language, b.recording?.notice === true);
    this.protectedLine = true;
    const played = this.speakAgentLine(disclosure, true);
    void played.then(() => {
      this.protectedLine = false;
      // The caller spoke over the disclosure and is still talking: yield now.
      if (this.turnCfg.bargeIn && this.vad.isSpeaking && this.speaker.busy) this.bargeIn(Date.now());
    });
    log.info('opening disclosure', { callId: this.session.callId, recording_notice: b.recording?.notice === true, basis: b.recording?.basis ?? null });
    const g = b.agent.greeting;
    if (g) this.speakAgentLine(g);
  }

  protected speakAgentLine(text: string, isProtected = false): Promise<void> {
    const rec = this.record({ speaker: 'agent', text, started_ms: this.elapsed(), interrupted: false });
    this.history.push({ role: 'assistant', content: text });
    if (!isProtected) this.speakingRec = rec;
    const played = this.speaker.say(text, this.tts);
    void played.then(() => { if (this.speakingRec === rec) this.speakingRec = null; });
    return played;
  }

  /** Caller audio -> STT, as 16 kHz mono PCM, until the call ends. */
  private async pumpCallerAudio(): Promise<void> {
    const audio = await this.media.callerAudio(IN_RATE);
    if (!audio || this.ended) return;
    try {
      for await (const pcm of audio) {
        if (this.ended) break;
        this.onCallerAudio(pcm);
      }
    } catch (err) {
      if (!this.ended) log.warn('caller audio stream ended', { callId: this.session.callId, error: (err as Error).message });
    }
  }

  /** Every caller audio chunk: VAD first (barge-in must not wait for STT), then STT. */
  protected onCallerAudio(pcm: Int16Array): void {
    for (const ev of this.vad.push(pcm, Date.now())) {
      if (ev.type === 'speech_start') this.onSpeechStart(ev.at);
      else this.onSpeechEnd(ev.at);
    }
    this.stt?.write(pcm);
  }

  private clearTurnTimers(): void {
    if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
    if (this.vadEndTimer) { clearTimeout(this.vadEndTimer); this.vadEndTimer = null; }
  }

  /** The caller started talking: they are not done yet, and may be talking over the agent. */
  protected onSpeechStart(at: number): void {
    this.clearTurnTimers();
    if (this.protectedLine) return;
    if (this.turnCfg.bargeIn && (this.speaker.busy || this.turnAbort !== null)) this.bargeIn(at);
  }

  protected onSpeechEnd(at: number): void {
    this.lastSpeechEndAt = at;
    // Fallback end-of-turn when the provider's endpointing is late or missing.
    if (this.pendingUser.length > 0 && !this.vadEndTimer) {
      this.vadEndTimer = setTimeout(() => { this.vadEndTimer = null; this.maybeCommit(); }, this.turnCfg.vadEndpointMs);
    }
  }

  /**
   * Barge-in: the caller talks over the agent. Audio stops now (queued frames dropped),
   * the in-flight LLM stream is aborted, and the agent line is recorded as interrupted with
   * the words the caller actually heard.
   */
  protected bargeIn(speechStartAt: number): void {
    const { heard } = this.speaker.interrupt();
    this.turnAbort?.abort();
    const stoppedAt = Date.now();
    if (this.speakingRec) {
      this.speakingRec.interrupted = true;
      this.speakingRec.text = heard;
      const last = [...this.history].reverse().find((m) => m.role === 'assistant');
      if (last) last.content = heard ? `${heard} —` : '—';
      this.speakingRec = null;
    }
    log.info('barge_in', { callId: this.session.callId, stop_ms: stoppedAt - speechStartAt, heard_words: heard ? heard.split(/\s+/).length : 0 });
    this.observer.onBargeIn?.(stoppedAt - speechStartAt, heard);
  }

  protected onTranscript(t: Transcript): void {
    if (t.final && t.text) this.pendingUser.push(t.text);
    if (t.endOfTurn) this.maybeCommit();
  }

  /** The provider (or VAD silence) says the caller paused: answer now, or hold if it sounds unfinished. */
  private maybeCommit(): void {
    if (this.pendingUser.length === 0 || this.vad.isSpeaking) return;
    const text = this.pendingUser.join(' ');
    if (soundsIncomplete(text)) {
      if (!this.holdTimer) this.holdTimer = setTimeout(() => { this.holdTimer = null; this.commitTurn(); }, this.turnCfg.holdMs);
      return;
    }
    this.commitTurn();
  }

  private commitTurn(): void {
    this.clearTurnTimers();
    if (this.pendingUser.length === 0) return;
    const text = this.pendingUser.join(' ');
    this.pendingUser = [];
    const now = Date.now();
    this.endOfCallerTurn(text, now, this.lastSpeechEndAt !== null ? now - this.lastSpeechEndAt : null);
  }

  /** A complete caller utterance. Turns are answered in order. */
  protected endOfCallerTurn(text: string, endedAt: number, sttMs: number | null = null): void {
    this.record({ speaker: 'caller', text, started_ms: this.elapsed(endedAt), stt_ms: sttMs, interrupted: false });
    this.turnChain = this.turnChain.then(() => this.respond(text, endedAt)).catch((err) => {
      log.error('turn failed', { callId: this.session.callId, error: (err as Error).message });
    });
  }

  /** First caller message carries per-call context, after the cached system prefix. */
  protected userMessage(text: string): ChatMessage {
    const first = !this.history.some((m) => m.role === 'user');
    if (!first) return { role: 'user', content: text };
    const context = `(Call context: it is ${new Date().toUTCString()}.)`;
    return { role: 'user', content: `${context}\n${text}` };
  }

  /**
   * Which LLM answers this turn (TK-4460): the router tags it fast or complex; the tier's
   * layer already points at the tenant's routed provider/model (bootstrap routing).
   */
  protected pickLlm(text: string): { layer: ActiveLayer; layerName: RuntimeLayer; tier: 'fast' | 'complex'; reason: string } {
    const v = classifyTurn(text, this.router);
    const layerName: RuntimeLayer = v.tier === 'complex' ? 'llm_complex' : 'llm_fast';
    return { layer: this.failover.active(layerName), layerName, tier: v.tier, reason: v.reason };
  }

  /**
   * Latency masking (TK-4463), run alongside the tools: speak a short acknowledgement when
   * they are known to be slow, or when they are still running at FILLER_THRESHOLD_MS —
   * unless the model already acknowledged this round, or the call's filler budget says no.
   * Returns the phrase spoken (for the transcript) or null.
   */
  protected async maskLatency(names: string[], running: Promise<unknown>, signal: AbortSignal, acknowledged: boolean): Promise<string | null> {
    if (acknowledged) return null;
    const speak = (why: string, expectedMs: number | null): string | null => {
      if (signal.aborted || this.ended) return null;
      const blocked = this.fillers.blocked();
      if (blocked) {
        log.info('filler suppressed', { callId: this.session.callId, reason: blocked, tools: names });
        return null;
      }
      const phrase = this.fillers.take();
      this.speaker.say(phrase, this.tts);
      log.info('filler', { callId: this.session.callId, phrase, why, expected_ms: expectedMs, tools: names });
      return phrase;
    };
    const observed = this.tools.observedMs(names);
    if (observed !== null && observed > FILLER_THRESHOLD_MS) return speak('expected_slow', observed);
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    const outcome = await Promise.race([
      running.then(() => 'done', () => 'done'),
      new Promise<string>((r) => setTimeout(() => r('slow'), FILLER_THRESHOLD_MS)),
      new Promise<string>((r) => signal.addEventListener('abort', () => r('aborted'), { once: true })),
    ]);
    if (outcome === 'slow' && !settled) return speak('still_running', observed);
    return null;
  }

  /**
   * Answers one caller turn: stream the model's reply, speaking each clause as it forms; if
   * the model calls tools, run them (TK-4462) and stream its follow-up, up to
   * MAX_TOOL_ROUNDS. A barge-in aborts whatever is in flight.
   */
  protected async respond(text: string, endedAt: number): Promise<void> {
    if (this.ended) return;
    this.history.push(this.userMessage(text));
    const { layer, layerName, tier, reason } = this.pickLlm(text);
    const abort = new AbortController();
    this.turnAbort = abort;
    const requestedAt = Date.now();
    const rec = this.record({
      speaker: 'agent', text: '', started_ms: this.elapsed(requestedAt), interrupted: false, model: `${layer.provider}/${layer.model ?? ''}`,
      ttft_ms: null, ttfa_ms: null,
    });
    this.speakingRec = rec;
    let firstTokenAt: number | null = null;
    let firstAudioAt: number | null = null;
    let llmDoneAt = requestedAt;
    let spoken = '';
    let failed = false;
    /** The model's answer: text from a round that ended without further tool calls. */
    let answered = false;
    const toolLog: NonNullable<TurnRecord['tool_calls']> = [];
    this.speaker.onFirstAudio((at) => { firstAudioAt = at; });

    for (let round = 0; round <= MAX_TOOL_ROUNDS && !abort.signal.aborted && !this.ended; round++) {
      const offerTools = (this.tools.size > 0 || this.canTransfer) && round < MAX_TOOL_ROUNDS;
      const req: CompletionRequest = {
        model: layer.model ?? '',
        prompt: [{ role: 'system', content: this.systemPrompt }, ...this.history],
        max_tokens: 400,
        temperature: 0.5,
        stream: true,
        ...(offerTools ? { tools: [...this.tools.manifest(), ...(this.canTransfer ? [transferToolManifest] : [])] } : {}),
      };
      // The round's assistant message goes in first, so a barge-in rewrites THIS message.
      const msg: ChatMessage = { role: 'assistant', content: '' };
      this.history.push(msg);
      const chunker = new ClauseChunker();
      let calls: ToolCallRecord[] = [];
      try {
        for await (const chunk of this.providers.llm(layer.provider).stream(req, Buffer.from(layer.handle.key), { signal: abort.signal })) {
          if (this.ended || abort.signal.aborted) break;
          if (chunk.delta) {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            msg.content += chunk.delta;
            for (const clause of chunker.push(chunk.delta)) this.speaker.say(clause, this.tts);
          }
          if (chunk.tool_calls?.length) calls = chunk.tool_calls;
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          failed = true;
          log.warn('llm turn failed', { callId: this.session.callId, provider: layer.provider, round, error: (err as Error).message });
          // 429 / 5xx: this tier runs on its secondary from the next turn (TK-4465).
          const d = this.failover.report(layerName, (err as { status?: number }).status, (err as Error).message);
          if (d) this.reportDegraded(d);
        }
      }
      llmDoneAt = Date.now();
      if (abort.signal.aborted) break;
      for (const clause of chunker.flush()) this.speaker.say(clause, this.tts);
      spoken += (spoken && msg.content ? ' ' : '') + msg.content;
      if (!failed && calls.length === 0 && msg.content.trim()) answered = true;
      if (failed || calls.length === 0) break;

      const escalate = calls.find((c) => c.tool_sku === TRANSFER_TOOL);
      if (escalate && this.canTransfer) {
        msg.tool_calls = [escalate];
        const said = await this.transferToHuman(escalate, abort.signal);
        spoken += (spoken ? ' ' : '') + said;
        answered = true;
        break;
      }

      msg.tool_calls = calls;
      const names = calls.map((c) => c.tool_sku);
      const running = this.tools.run(calls.map((c) => ({ tool_call_id: c.tool_call_id, name: c.tool_sku, args: c.args })), rec.turn_index, abort.signal);
      // The filler is transcript-only: tool results must directly follow the tool-call message.
      const filler = await this.maskLatency(names, running, abort.signal, msg.content.trim().length > 0);
      if (filler) spoken += (spoken ? ' ' : '') + filler;
      const outcomes = await running;
      for (const o of outcomes) {
        this.history.push({ role: 'tool', tool_call_id: o.tool_call_id, content: toolMessage(o) });
        toolLog.push({ name: o.name, ok: o.ok, error: o.error ?? null, status: o.status ?? null, ms: o.ms });
      }
    }

    // Never leave the caller without an answer: the model produced none (it failed — before
    // or after a tool — or returned nothing) and nobody interrupted -> say the graceful line.
    // A pre-tool "let me check" does not count as the answer.
    if (!abort.signal.aborted && !this.ended && !answered) {
      const line = toolLog.length > 0 ? TOOL_FALLBACK_LINE : FALLBACK_LINE;
      spoken += (spoken ? ' ' : '') + line;
      const last = this.history[this.history.length - 1];
      if (last.role === 'assistant' && !last.tool_calls?.length) last.content = line;
      else this.history.push({ role: 'assistant', content: line });
      this.speaker.say(line, this.tts);
    }
    // Drop empty placeholder messages the model never filled (e.g. aborted before a token).
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i];
      if (m.role === 'assistant' && !m.content && !m.tool_calls?.length) this.history.splice(i, 1);
    }
    if (!rec.interrupted) rec.text = spoken;
    rec.ttft_ms = firstTokenAt !== null ? firstTokenAt - requestedAt : null;
    if (toolLog.length) rec.tool_calls = toolLog;
    await this.speaker.idle();
    if (this.turnAbort === abort) this.turnAbort = null;
    if (this.speakingRec === rec) this.speakingRec = null;
    rec.ttfa_ms = firstAudioAt !== null ? firstAudioAt - endedAt : null;
    // bargeIn() already rewrote rec.text / history to what the caller heard.
    this.store.touch(this.session.callId);
    this.publishTurn(rec, tier, llmDoneAt - requestedAt, failed);
    log.info('turn', {
      callId: this.session.callId,
      turn: rec.turn_index,
      tier,
      route_reason: reason,
      model: rec.model,
      ttft_ms: rec.ttft_ms,
      ttfa_ms: rec.ttfa_ms,
      llm_ms: llmDoneAt - requestedAt,
      first_audio_at: firstAudioAt,
      llm_done_at: llmDoneAt,
      first_audio_before_llm_done: firstAudioAt !== null && firstAudioAt < llmDoneAt,
      interrupted: rec.interrupted,
      llm_aborted: abort.signal.aborted,
      tools: toolLog.length ? toolLog.map((t) => `${t.name}:${t.ok ? 'ok' : t.error}`) : undefined,
      chars: spoken.length,
    });
  }

  /**
   * Warm transfer (TK-4464): acknowledge, write the handoff summary, ask the control plane to
   * transfer, then follow the mode — refer: the caller's leg moves to the human and leaves the
   * room; bridge: brief the human once they join, then leave them with the caller; callback
   * (or failure): tell the caller a colleague will follow up and carry on. Returns what was said.
   */
  private async transferToHuman(call: ToolCallRecord, signal: AbortSignal): Promise<string> {
    const args = (call.args ?? {}) as { reason?: unknown };
    const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 300) : 'caller asked for a person';
    const said: string[] = [];
    const say = (line: string): Promise<void> => { said.push(line); return this.speaker.say(line, this.tts); };
    void say("Of course. I'm connecting you with a colleague now. One moment, please.");
    const fast = this.failover.active('llm_fast');
    const summary = await summarizeForHandoff({ provider: fast.provider, model: fast.model, key: fast.handle.key }, this.session.turns, reason, 4000, this.providers.llm);
    const caller = this.media.caller();
    let result: Awaited<ReturnType<ControlPlane['transfer']>>;
    try {
      result = await this.controlPlane.transfer(this.session.callId, {
        reason,
        summary,
        room: this.media.roomName || this.session.room,
        caller_identity: caller.identity,
        caller_is_sip: caller.isSip,
        transcript: this.session.turns.filter((t) => t.text).map((t) => ({ speaker: t.speaker, text: t.text })),
      });
    } catch (err) {
      log.warn('transfer failed', { callId: this.session.callId, error: (err as Error).message });
      this.history.push({ role: 'tool', tool_call_id: call.tool_call_id, content: JSON.stringify({ ok: false, error: 'transfer_failed' }) });
      await say("I'm sorry, I can't connect you right now. A colleague will follow up with you shortly. Is there anything else I can help with?");
      return said.join(' ');
    }
    this.history.push({ role: 'tool', tool_call_id: call.tool_call_id, content: JSON.stringify({ ok: true, mode: result.mode }) });
    log.info('transfer', { callId: this.session.callId, mode: result.mode, handoff_id: result.handoff_id, reason, summary_chars: summary.length });
    if (result.mode === 'callback') {
      await say('A colleague will call you back shortly. Is there anything else I can help with in the meantime?');
      return said.join(' ');
    }
    if (result.mode === 'refer') {
      await this.speaker.idle();
      return said.join(' ');
    }
    // bridge: wait for the human to join the room, brief them, then leave the two of them.
    const humanId = `human-${this.session.callId}`;
    const joined = await this.media.waitForParticipant(humanId, Number(process.env.VOICE_TRANSFER_ANSWER_MS ?? 45_000), signal);
    if (!joined) {
      await say("I'm sorry, my colleague isn't available right now. They will call you back shortly.");
      return said.join(' ');
    }
    await say(`Hi, this is the AI assistant handing over a call. ${summary} I'll leave you two to it.`);
    await this.speaker.idle();
    this.media.end();
    return said.join(' ');
  }

  protected async cleanup(): Promise<void> {
    this.ended = true;
    this.clearTurnTimers();
    this.turnAbort?.abort();
    this.stt?.close();
    try { this.speaker?.interrupt(); } catch { /* source closed */ }
    await this.media.close().catch(() => undefined);
    await this.source?.close().catch(() => undefined);
  }
}

export function streamingConversation(store: SessionStore, controlPlane: ControlPlane, turnEvents: TurnEventSink = noopTurnSink): Conversation {
  return (room, session, ctx) => new VoiceSession(new LiveKitMedia(room, ctx.signal, session.room), session, ctx.signal, store, controlPlane, { turnEvents }).run();
}
