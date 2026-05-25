import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  NoaaAdapter,
  DtnAdapter,
  WeatherUndergroundAdapter,
  SyntheticStormAdapter,
  buildProviderChain,
} from '../src/services/providers';

describe('sdk-storm providers — availability gates', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.NOAA_INGEST_ENABLED;
    delete process.env.DTN_API_KEY;
    delete process.env.WU_API_KEY;
    delete process.env.NODE_ENV;
    delete process.env.ALLOW_SYNTHETIC_STORM;
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('NoaaAdapter is unavailable without NOAA_INGEST_ENABLED', () => {
    expect(new NoaaAdapter().available()).toBe(false);
  });

  it('NoaaAdapter is available when NOAA_INGEST_ENABLED=true', () => {
    process.env.NOAA_INGEST_ENABLED = 'true';
    expect(new NoaaAdapter().available()).toBe(true);
  });

  it('DtnAdapter is unavailable without DTN_API_KEY', () => {
    expect(new DtnAdapter().available()).toBe(false);
  });

  it('DtnAdapter is available when DTN_API_KEY is set', () => {
    process.env.DTN_API_KEY = 'abc';
    expect(new DtnAdapter().available()).toBe(true);
  });

  it('WeatherUndergroundAdapter requires WU_API_KEY', () => {
    expect(new WeatherUndergroundAdapter().available()).toBe(false);
    process.env.WU_API_KEY = 'xyz';
    expect(new WeatherUndergroundAdapter().available()).toBe(true);
  });

  it('SyntheticStormAdapter is available in dev/test', () => {
    expect(new SyntheticStormAdapter().available()).toBe(true);
  });

  it('SyntheticStormAdapter refuses production without explicit allow', () => {
    process.env.NODE_ENV = 'production';
    expect(new SyntheticStormAdapter().available()).toBe(false);
    process.env.ALLOW_SYNTHETIC_STORM = 'true';
    expect(new SyntheticStormAdapter().available()).toBe(true);
  });

  it('buildProviderChain returns the 4-provider fallback order', () => {
    const chain = buildProviderChain();
    expect(chain.map((p) => p.provider)).toEqual([
      'noaa',
      'dtn',
      'weather-underground',
      'synthetic',
    ]);
  });
});

describe('SyntheticStormAdapter — deterministic outputs', () => {
  it('emits one hail event per fetch window', async () => {
    const a = new SyntheticStormAdapter();
    const events = await a.fetchEvents({
      since: '2026-05-01T00:00:00Z',
      until: '2026-05-02T00:00:00Z',
    });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('hail');
    expect(events[0].provider_event_id).toContain('2026-05-01');
  });

  it('emits 4 intensity cells per event', async () => {
    const a = new SyntheticStormAdapter();
    const cells = await a.fetchIntensityCells('synthetic-2026-05-01');
    expect(cells).toHaveLength(4);
    for (const c of cells) {
      expect(c.hail_in).toBeGreaterThan(0);
      expect(c.wind_mph).toBeGreaterThan(0);
    }
  });
});
