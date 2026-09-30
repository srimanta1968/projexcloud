import WebSocket from 'ws';
import { log } from '../log';
import { ProviderError, providerUrl, type SttOptions, type SttProvider, type SttStream, type Transcript } from './types';

/**
 * Streaming speech-to-text (VA·E1 · TK-4458): one WebSocket per call, PCM16 mono in,
 * interim + final transcripts out, with the provider's endpointing marking end of turn.
 */

type Listener<T> = (v: T) => void;

/** Shared plumbing: buffers audio until the socket opens, fans events out to listeners. */
abstract class WsStt implements SttStream {
  protected ws: WebSocket;
  private queue: Buffer[] = [];
  private open = false;
  private closed = false;
  protected transcriptCbs: Listener<Transcript>[] = [];
  protected speechCbs: (() => void)[] = [];
  protected errorCbs: Listener<Error>[] = [];

  constructor(protected readonly provider: string, url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers });
    this.ws.on('open', () => {
      this.open = true;
      for (const b of this.queue) this.ws.send(b);
      this.queue = [];
      this.onOpen();
    });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(data)); } catch { return; }
      this.onMessage(msg);
    });
    this.ws.on('unexpected-response', (_req, res) => {
      this.fail(new ProviderError(provider, res.statusCode ?? 0, `${provider} refused the stream (HTTP ${res.statusCode})`));
    });
    this.ws.on('error', (err) => this.fail(new ProviderError(provider, 0, `${provider} stream error: ${err.message}`)));
    this.ws.on('close', (code) => {
      if (!this.closed && code !== 1000) this.fail(new ProviderError(provider, code === 1008 || code === 4001 ? 401 : 503, `${provider} closed the stream (${code})`));
    });
  }

  /** Resolves once connected; rejects if the provider refuses the stream. */
  ready(): Promise<this> {
    if (this.open) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve(this));
      this.errorCbs.push(reject);
    });
  }

  protected onOpen(): void { /* provider hook */ }
  protected abstract onMessage(msg: Record<string, unknown>): void;
  protected abstract closeMessage(): string | null;

  protected emit(t: Transcript): void {
    for (const cb of this.transcriptCbs) cb(t);
  }

  private fail(err: Error): void {
    if (this.closed) return;
    log.warn('stt stream failed', { provider: this.provider, error: err.message });
    for (const cb of this.errorCbs) cb(err);
  }

  write(pcm: Int16Array): void {
    if (this.closed) return;
    const b = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    if (this.open) this.ws.send(b);
    else if (this.queue.length < 500) this.queue.push(Buffer.from(b));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      const m = this.closeMessage();
      if (m && this.open) this.ws.send(m);
      this.ws.close(1000);
    } catch { /* already closed */ }
  }

  onTranscript(cb: Listener<Transcript>): void { this.transcriptCbs.push(cb); }
  onSpeechStart(cb: () => void): void { this.speechCbs.push(cb); }
  onError(cb: Listener<Error>): void { this.errorCbs.push(cb); }
}

/** Deepgram live transcription (nova-3 et al.): /v1/listen, interim results, endpointing. */
class DeepgramStream extends WsStt {
  private keepAlive: NodeJS.Timeout | null = null;
  constructor(opts: SttOptions) {
    const q = new URLSearchParams({
      model: opts.model || 'nova-3',
      language: opts.language || 'en',
      encoding: 'linear16',
      sample_rate: String(opts.sampleRate),
      channels: '1',
      interim_results: 'true',
      endpointing: String((opts.options?.endpointing_ms as number | undefined) ?? 300),
      utterance_end_ms: '1000',
      vad_events: 'true',
      smart_format: 'true',
    });
    super('deepgram', `${providerUrl('deepgram', 'wss://api.deepgram.com').replace(/^http/, 'ws')}/v1/listen?${q}`, { Authorization: `Token ${opts.key}` });
  }
  protected onOpen(): void {
    // Deepgram closes an idle stream after ~10 s without audio or a KeepAlive.
    this.keepAlive = setInterval(() => { try { this.ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch { /* closed */ } }, 5000);
    this.keepAlive.unref();
  }
  protected onMessage(m: Record<string, unknown>): void {
    if (m.type === 'SpeechStarted') { for (const cb of this.speechCbs) cb(); return; }
    if (m.type === 'UtteranceEnd') { this.emit({ text: '', final: true, endOfTurn: true }); return; }
    if (m.type !== 'Results') return;
    const alt = (m.channel as { alternatives?: { transcript?: string }[] } | undefined)?.alternatives?.[0];
    const text = (alt?.transcript ?? '').trim();
    if (!text && !m.speech_final) return;
    this.emit({ text, final: m.is_final === true, endOfTurn: m.speech_final === true });
  }
  protected closeMessage(): string {
    if (this.keepAlive) clearInterval(this.keepAlive);
    return JSON.stringify({ type: 'CloseStream' });
  }
}

/** AssemblyAI Universal-Streaming (v3): turn-based messages with end_of_turn. */
class AssemblyAiStream extends WsStt {
  private lastTurnText = '';
  constructor(opts: SttOptions) {
    const q = new URLSearchParams({ sample_rate: String(opts.sampleRate), encoding: 'pcm_s16le', format_turns: 'true' });
    super('assemblyai', `${providerUrl('assemblyai', 'wss://streaming.assemblyai.com').replace(/^http/, 'ws')}/v3/ws?${q}`, { Authorization: opts.key });
  }
  protected onMessage(m: Record<string, unknown>): void {
    if (m.type !== 'Turn') return;
    const text = String(m.transcript ?? '').trim();
    const end = m.end_of_turn === true;
    // v3 sends the unformatted end-of-turn first, then a formatted copy; emit once.
    if (end && m.turn_is_formatted !== true && m.turn_is_formatted !== undefined) return;
    if (end) {
      if (text === this.lastTurnText) return;
      this.lastTurnText = text;
    }
    if (text) this.emit({ text, final: end, endOfTurn: end });
  }
  protected closeMessage(): string {
    return JSON.stringify({ type: 'Terminate' });
  }
}

export const deepgramStt: SttProvider = {
  id: 'deepgram',
  connect: (opts) => new DeepgramStream(opts).ready(),
};

export const assemblyAiStt: SttProvider = {
  id: 'assemblyai',
  connect: (opts) => new AssemblyAiStream(opts).ready(),
};

const STT: Record<string, SttProvider> = { deepgram: deepgramStt, assemblyai: assemblyAiStt };

export function registerSttProvider(p: SttProvider): void {
  STT[p.id] = p;
}

export function sttProvider(id: string): SttProvider {
  const p = STT[id];
  if (!p) throw new ProviderError(id, 400, `speech-to-text provider ${id} is not supported by the voice runtime`);
  return p;
}
