import {
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  ParticipantKind,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type Room,
} from '@livekit/rtc-node';
import type { ChatMessage, CompletionRequest } from '@projexlight/contracts';
import type { Conversation } from '../call/callRunner';
import type { RuntimeLayerConfig } from '../controlPlane';
import type { JobContext } from '../livekit/worker';
import { log } from '../log';
import { llmAdapter } from '../providers/llm';
import { sttProvider } from '../providers/stt';
import { ttsProvider } from '../providers/tts';
import type { SttStream, Transcript } from '../providers/types';
import type { SessionContext, SessionStore, TurnRecord } from '../session/sessionStore';
import { ClauseChunker } from './chunker';
import { Speaker, type TtsBinding } from './speaker';
import { soundsIncomplete, turnConfig, type TurnConfig } from './turnDetector';
import { classifyTurn, routerConfig } from './turnRouter';
import { EnergyVad, vadConfig } from './vad';

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

export class VoiceSession {
  readonly history: ChatMessage[] = [];
  private source!: AudioSource;
  protected speaker!: Speaker;
  protected stt: SttStream | null = null;
  private pendingUser: string[] = [];
  private turnChain: Promise<void> = Promise.resolve();
  protected ended = false;
  private callerStream: AudioStream | null = null;
  protected readonly systemPrompt: string;
  protected readonly tts: TtsBinding;
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

  constructor(
    protected readonly room: Room,
    protected readonly session: SessionContext,
    protected readonly ctx: JobContext,
    protected readonly store: SessionStore,
  ) {
    const b = session.boot;
    this.systemPrompt = `${VOICE_RULES}\n\n${b.agent.system_prompt}`;
    const t = b.stack.layers.tts;
    this.tts = { provider: ttsProvider(t.provider), opts: this.ttsOpts(t) };
    const sttOpts = b.stack.layers.stt.options;
    this.turnCfg = turnConfig(sttOpts);
    const td = ((sttOpts?.turn_detection ?? {}) as Record<string, unknown>);
    this.vad = new EnergyVad(vadConfig(td.sensitivity, { minSpeechMs: td.min_interruption_ms, minSilenceMs: td.min_silence_ms }, IN_RATE));
    this.router = routerConfig(b.agent.escalation_rules);
  }

  protected ttsOpts(l: RuntimeLayerConfig) {
    return { key: l.primary.key, model: l.model, voice: l.voice, language: this.session.boot.agent.language, options: l.options };
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
    this.source = new AudioSource(OUT_RATE, 1, 200);
    const track = LocalAudioTrack.createAudioTrack('agent-voice', this.source);
    const opts = new TrackPublishOptions();
    opts.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant!.publishTrack(track, opts);
    this.speaker = new Speaker(this.source, OUT_RATE);

    const sttLayer = b.stack.layers.stt;
    try {
      this.stt = await sttProvider(sttLayer.provider).connect({
        key: sttLayer.primary.key, model: sttLayer.model, language: b.agent.language, sampleRate: IN_RATE, options: sttLayer.options,
      });
    } catch (err) {
      log.error('speech-to-text unavailable, ending call', { callId: this.session.callId, error: (err as Error).message });
      this.speaker.say("Sorry, I'm having trouble on my end. Please call back in a moment.", this.tts);
      await this.speaker.idle();
      return this.cleanup();
    }
    this.stt.onTranscript((t) => this.onTranscript(t));
    this.stt.onError((err) => log.warn('stt error mid-call', { callId: this.session.callId, error: err.message }));

    await this.greet();
    void this.pumpCallerAudio();
    await this.untilCallEnds();
    await this.cleanup();
  }

  /** Opening line. TK-4461 prepends the mandatory AI disclosure here. */
  protected async greet(): Promise<void> {
    const g = this.session.boot.agent.greeting;
    if (g) this.speakAgentLine(g);
  }

  protected speakAgentLine(text: string): void {
    const rec = this.record({ speaker: 'agent', text, started_ms: this.elapsed(), interrupted: false });
    this.history.push({ role: 'assistant', content: text });
    this.speakingRec = rec;
    this.speaker.say(text, this.tts);
    void this.speaker.idle().then(() => { if (this.speakingRec === rec) this.speakingRec = null; });
  }

  private findCallerTrack(): RemoteTrack | null {
    for (const p of this.room.remoteParticipants.values()) {
      if (p.kind === ParticipantKind.AGENT) continue;
      for (const pub of p.trackPublications.values()) {
        if (pub.kind === TrackKind.KIND_AUDIO && pub.track) return pub.track as RemoteTrack;
      }
    }
    return null;
  }

  private waitForCallerTrack(): Promise<RemoteTrack | null> {
    const now = this.findCallerTrack();
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const on = (track: RemoteTrack, _pub: unknown, p: RemoteParticipant): void => {
        if (track.kind !== TrackKind.KIND_AUDIO || p.kind === ParticipantKind.AGENT) return;
        this.room.off(RoomEvent.TrackSubscribed, on);
        resolve(track);
      };
      this.room.on(RoomEvent.TrackSubscribed, on);
      this.ctx.signal.addEventListener('abort', () => { this.room.off(RoomEvent.TrackSubscribed, on); resolve(null); }, { once: true });
    });
  }

  /** Caller audio -> STT, as 16 kHz mono PCM, until the call ends. */
  private async pumpCallerAudio(): Promise<void> {
    const track = await this.waitForCallerTrack();
    if (!track || this.ended) return;
    this.callerStream = new AudioStream(track, IN_RATE, 1);
    const reader = this.callerStream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || this.ended) break;
        this.onCallerAudio(value.data);
      }
    } catch (err) {
      if (!this.ended) log.warn('caller audio stream ended', { callId: this.session.callId, error: (err as Error).message });
    } finally {
      reader.releaseLock();
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
  protected pickLlm(text: string): { layer: RuntimeLayerConfig; tier: 'fast' | 'complex'; reason: string } {
    const v = classifyTurn(text, this.router);
    const layers = this.session.boot.stack.layers;
    return { layer: v.tier === 'complex' ? layers.llm_complex : layers.llm_fast, tier: v.tier, reason: v.reason };
  }

  protected async respond(text: string, endedAt: number): Promise<void> {
    if (this.ended) return;
    this.history.push(this.userMessage(text));
    const { layer, tier, reason } = this.pickLlm(text);
    const req: CompletionRequest = {
      model: layer.model ?? '',
      prompt: [{ role: 'system', content: this.systemPrompt }, ...this.history],
      max_tokens: 400,
      temperature: 0.5,
      stream: true,
    };
    const chunker = new ClauseChunker();
    let reply = '';
    let failed = false;
    let firstTokenAt: number | null = null;
    let firstAudioAt: number | null = null;
    const requestedAt = Date.now();
    const abort = new AbortController();
    this.turnAbort = abort;
    // Recorded up front so a barge-in during this reply can mark it interrupted.
    const rec = this.record({
      speaker: 'agent', text: '', started_ms: this.elapsed(requestedAt), interrupted: false, model: `${layer.provider}/${layer.model ?? ''}`,
      ttft_ms: null, ttfa_ms: null,
    });
    this.history.push({ role: 'assistant', content: '' });
    this.speakingRec = rec;
    this.speaker.onFirstAudio((at) => { firstAudioAt = at; });
    try {
      for await (const chunk of llmAdapter(layer.provider).stream(req, Buffer.from(layer.primary.key), { signal: abort.signal })) {
        if (this.ended || abort.signal.aborted) break;
        if (chunk.delta) {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          reply += chunk.delta;
          for (const clause of chunker.push(chunk.delta)) this.speaker.say(clause, this.tts);
        }
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        failed = true;
        log.warn('llm turn failed', { callId: this.session.callId, provider: layer.provider, error: (err as Error).message });
      }
    }
    const llmDoneAt = Date.now();
    const interruptedDuringLlm = abort.signal.aborted;
    if (!interruptedDuringLlm) {
      for (const clause of chunker.flush()) this.speaker.say(clause, this.tts);
      if (failed && !reply) {
        reply = FALLBACK_LINE;
        this.speaker.say(reply, this.tts);
      }
      rec.text = reply;
      this.history[this.history.length - 1].content = reply;
    }
    rec.ttft_ms = firstTokenAt !== null ? firstTokenAt - requestedAt : null;
    await this.speaker.idle();
    if (this.turnAbort === abort) this.turnAbort = null;
    if (this.speakingRec === rec) this.speakingRec = null;
    rec.ttfa_ms = firstAudioAt !== null ? firstAudioAt - endedAt : null;
    // bargeIn() already rewrote rec.text / history to what the caller heard.
    this.store.touch(this.session.callId);
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
      llm_aborted: interruptedDuringLlm,
      chars: reply.length,
    });
  }

  private untilCallEnds(): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        this.room.off(RoomEvent.ParticipantDisconnected, onLeft);
        this.room.off(RoomEvent.Disconnected, done);
        resolve();
      };
      const onLeft = (p: RemoteParticipant): void => {
        if (p.kind === ParticipantKind.AGENT) return;
        const callers = [...this.room.remoteParticipants.values()].filter((x) => x.kind !== ParticipantKind.AGENT);
        if (callers.length === 0) done();
      };
      this.room.on(RoomEvent.ParticipantDisconnected, onLeft);
      this.room.on(RoomEvent.Disconnected, done);
      this.ctx.signal.addEventListener('abort', done, { once: true });
      if ([...this.room.remoteParticipants.values()].every((x) => x.kind === ParticipantKind.AGENT)) done();
    });
  }

  protected async cleanup(): Promise<void> {
    this.ended = true;
    this.clearTurnTimers();
    this.turnAbort?.abort();
    this.stt?.close();
    try { this.speaker?.interrupt(); } catch { /* source closed */ }
    await this.callerStream?.cancel().catch(() => undefined);
    await this.source?.close().catch(() => undefined);
  }
}

export function streamingConversation(store: SessionStore): Conversation {
  return (room, session, ctx) => new VoiceSession(room, session, ctx, store).run();
}
