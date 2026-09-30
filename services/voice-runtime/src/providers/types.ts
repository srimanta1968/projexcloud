/**
 * Speech provider contracts (VA·E1 · TK-4458). A stack layer's provider id picks the
 * implementation; the key comes from the call bootstrap and lives only in memory.
 *
 * Base URLs default to each vendor's public API and can be redirected per deployment with
 * VOICE_PROVIDER_URL_<PROVIDER> (regional endpoints, a proxy, or a protocol stub in tests).
 */

export interface Transcript {
  text: string;
  /** The provider will not revise this text any more. */
  final: boolean;
  /** The provider's endpointing says the caller finished speaking. */
  endOfTurn: boolean;
}

export interface SttOptions {
  key: string;
  model?: string;
  language: string;
  /** PCM16 mono sample rate the runtime sends. */
  sampleRate: number;
  options?: Record<string, unknown>;
}

export interface SttStream {
  /** One chunk of PCM16 mono audio at the negotiated sample rate. */
  write(pcm: Int16Array): void;
  close(): void;
  onTranscript(cb: (t: Transcript) => void): void;
  /** Speech started (provider VAD), when the provider reports it. */
  onSpeechStart(cb: () => void): void;
  onError(cb: (err: Error) => void): void;
}

export interface SttProvider {
  readonly id: string;
  connect(opts: SttOptions): Promise<SttStream>;
}

export interface TtsOptions {
  key: string;
  model?: string;
  voice?: string;
  language: string;
  options?: Record<string, unknown>;
}

export interface TtsProvider {
  readonly id: string;
  /** Sample rate of the PCM16 mono audio synthesize() yields. */
  sampleRate(opts: TtsOptions): number;
  /** Streams PCM16 mono audio for `text`; aborting `signal` stops it (and the HTTP body). */
  synthesize(text: string, opts: TtsOptions, signal: AbortSignal): AsyncIterable<Int16Array>;
}

export class ProviderError extends Error {
  constructor(public readonly provider: string, public readonly status: number, message: string) {
    super(message);
    this.name = 'ProviderError';
  }
  /** 429 / 5xx / network: the layer may fail over to its secondary (TK-4465). */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export function providerUrl(provider: string, fallback: string): string {
  return (process.env[`VOICE_PROVIDER_URL_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] || fallback).replace(/\/+$/, '');
}

/** Little-endian PCM16 bytes -> samples. Carries an odd trailing byte to the next call. */
export class Pcm16Decoder {
  private carry: Buffer | null = null;
  push(bytes: Uint8Array): Int16Array {
    let buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (this.carry) {
      buf = Buffer.concat([this.carry, buf]);
      this.carry = null;
    }
    if (buf.length % 2 === 1) {
      this.carry = buf.subarray(buf.length - 1);
      buf = buf.subarray(0, buf.length - 1);
    }
    const out = new Int16Array(buf.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
    return out;
  }
}
