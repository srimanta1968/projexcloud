/**
 * End-of-turn decision (VA·E1 · TK-4459).
 *
 * Provider endpointing (a pause) says the caller STOPPED; this decides whether they are
 * DONE. An utterance that trails off mid-thought — a conjunction, a preposition, a filler
 * ("um", "so"), a trailing comma or ellipsis — gets `holdMs` more before the agent answers;
 * if the caller resumes within it, the turn keeps growing. A complete-sounding utterance is
 * answered at once. Per-agent tuning lives in the stack's stt options.turn_detection.
 */

const TRAILING = /(?:,|…|\.\.\.|\b(?:and|but|or|so|because|cause|if|then|um+|uh+|er+|erm|like|the|a|an|to|of|for|with|at|on|in|my|your|is|was|i'm|it's|that|which|who|when|where)\s*)$/i;

/** True when `text` sounds unfinished. */
export function soundsIncomplete(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/[.?!]["')]?$/.test(t)) return false;
  return TRAILING.test(t);
}

export interface TurnConfig {
  /** Extra wait after an unfinished-sounding utterance. */
  holdMs: number;
  /** Commit from VAD silence alone when the provider has not endpointed by then. */
  vadEndpointMs: number;
  /** Stop agent audio when the caller talks over it. */
  bargeIn: boolean;
}

export function turnConfig(opts: Record<string, unknown> | undefined): TurnConfig {
  const td = (opts?.turn_detection ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    holdMs: num(td.hold_ms, 700),
    vadEndpointMs: num(td.vad_endpoint_ms, 900),
    bargeIn: td.barge_in !== false,
  };
}
