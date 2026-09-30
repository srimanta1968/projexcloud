import { describe, expect, it } from 'vitest';
import { LayerFailover, isRetryable } from '../src/pipeline/failover';
import type { RuntimeLayer, RuntimeLayerConfig } from '../src/controlPlane';

const handle = (id: string, priority: 'primary' | 'secondary') => ({ binding_id: id, provider: 'openai', priority, key: `key-${id}` });

function layers(withSecondary: boolean): Record<RuntimeLayer, RuntimeLayerConfig> {
  const l = (name: string): RuntimeLayerConfig => ({
    provider: 'openai',
    model: `${name}-model`,
    primary: handle(`${name}-p`, 'primary'),
    secondary: withSecondary ? { ...handle(`${name}-s`, 'secondary'), config: { provider: 'groq', model: `${name}-fallback` } } : null,
  });
  return { stt: l('stt'), llm_fast: l('fast'), llm_complex: l('complex'), tts: l('tts') };
}

describe('isRetryable', () => {
  it('fails over on rate limits, server errors and unreachable providers only', () => {
    expect([0, 429, 500, 503, 504].every(isRetryable)).toBe(true);
    expect([400, 401, 403, 404, 499].some(isRetryable)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

describe('LayerFailover', () => {
  it('starts every layer on its primary', () => {
    const f = new LayerFailover(layers(true));
    const a = f.active('llm_fast');
    expect(a.handle.key).toBe('key-fast-p');
    expect(a.model).toBe('fast-model');
    expect(a.onSecondary).toBe(false);
  });

  it('switches only the failing layer to the secondary key AND config, once', () => {
    const f = new LayerFailover(layers(true));
    const d = f.report('llm_fast', 429, 'rate limited');
    expect(d).toMatchObject({ layer: 'llm_fast', status: 429, toProvider: 'groq' });
    expect(d?.from.binding_id).toBe('fast-p');
    expect(d?.to?.binding_id).toBe('fast-s');
    const a = f.active('llm_fast');
    expect(a).toMatchObject({ provider: 'groq', model: 'fast-fallback', onSecondary: true });
    expect(a.handle.key).toBe('key-fast-s');
    expect(f.active('llm_complex').onSecondary).toBe(false);
    // A second failure (the secondary, or the primary again) is not re-reported.
    expect(f.report('llm_fast', 503, 'down')).toBeNull();
  });

  it('ignores non-retryable failures', () => {
    const f = new LayerFailover(layers(true));
    expect(f.report('tts', 401, 'bad key')).toBeNull();
    expect(f.active('tts').onSecondary).toBe(false);
  });

  it('without a secondary: reports the degradation but stays on the primary', () => {
    const f = new LayerFailover(layers(false));
    const d = f.report('stt', 0, 'unreachable');
    expect(d).toMatchObject({ to: null, toProvider: null, status: 0 });
    expect(f.active('stt').handle.key).toBe('key-stt-p');
  });
});
