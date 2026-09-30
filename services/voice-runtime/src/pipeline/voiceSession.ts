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
import type { ChatMessage, CompletionRequest, ToolCallRecord } from '@projexlight/contracts';
import type { Conversation } from '../call/callRunner';
import type { ControlPlane, RuntimeLayerConfig } from '../controlPlane';
import type { JobContext } from '../livekit/worker';
import { log } from '../log';
import { llmAdapter } from '../providers/llm';
import { sttProvider } from '../providers/stt';
import { ttsProvider } from '../providers/tts';
import type { SttStream, Transcript } from '../providers/types';
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
  protected readonly tools: ToolExecutor;
  private readonly fillers: FillerPolicy;
  private readonly controlPlane: ControlPlane;
  /** The agent version can escalate to a human (escalation_rules.transfer). */
  private readonly canTransfer: boolean;
  /** Ends the session while others stay in the room (bridge transfer). */
  private endNow: (() => void) | null = null;
  /** True while the mandatory disclosure plays: barge-in cannot cut it short. */
  private protectedLine = false;

  constructor(
    protected readonly room: Room,
    protected readonly session: SessionContext,
    protected readonly ctx: JobContext,
    protected readonly store: SessionStore,
    controlPlane: ControlPlane,
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
    this.tools = new ToolExecutor(session, controlPlane);
    this.fillers = new FillerPolicy(b.agent.language);
    this.controlPlane = controlPlane;
    this.canTransfer = transferAvailable(b.agent.escalation_rules);
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
    const { layer, tier, reason } = this.pickLlm(text);
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
        for await (const chunk of llmAdapter(layer.provider).stream(req, Buffer.from(layer.primary.key), { signal: abort.signal })) {
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
    const summary = await summarizeForHandoff(this.session.boot.stack.layers.llm_fast, this.session.turns, reason);
    const others = [...this.room.remoteParticipants.values()].filter((p) => p.kind !== ParticipantKind.AGENT);
    const sip = others.find((p) => p.kind === ParticipantKind.SIP);
    const caller = sip ?? others[0];
    let result: Awaited<ReturnType<ControlPlane['transfer']>>;
    try {
      result = await this.controlPlane.transfer(this.session.callId, {
        reason,
        summary,
        room: this.room.name ?? this.session.room,
        caller_identity: caller?.identity ?? null,
        caller_is_sip: !!sip,
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
    const joined = await new Promise<boolean>((resolve) => {
      if (this.room.remoteParticipants.has(humanId)) return resolve(true);
      const t = setTimeout(() => { this.room.off(RoomEvent.ParticipantConnected, on); resolve(false); }, Number(process.env.VOICE_TRANSFER_ANSWER_MS ?? 45_000));
      const on = (p: RemoteParticipant): void => {
        if (p.identity !== humanId) return;
        clearTimeout(t);
        this.room.off(RoomEvent.ParticipantConnected, on);
        resolve(true);
      };
      this.room.on(RoomEvent.ParticipantConnected, on);
      signal.addEventListener('abort', () => { clearTimeout(t); resolve(false); }, { once: true });
    });
    if (!joined) {
      await say("I'm sorry, my colleague isn't available right now. They will call you back shortly.");
      return said.join(' ');
    }
    await say(`Hi, this is the AI assistant handing over a call. ${summary} I'll leave you two to it.`);
    await this.speaker.idle();
    this.endNow?.();
    return said.join(' ');
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
      this.endNow = done;
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

export function streamingConversation(store: SessionStore, controlPlane: ControlPlane): Conversation {
  return (room, session, ctx) => new VoiceSession(room, session, ctx, store, controlPlane).run();
}
