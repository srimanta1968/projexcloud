/**
 * sdk-geo provider abstraction (FR-GEO-2, NFR §6 failover ≤5s).
 *
 * Each provider wraps the upstream API behind a uniform `GeocodeProvider`
 * surface (geocode + reverseGeocode). The chain runs them in order with a
 * configurable per-provider timeout; the first non-null reply wins.
 *
 * Provider classes:
 *  - MapboxProvider   (env: MAPBOX_ACCESS_TOKEN)
 *  - GoogleProvider   (env: GOOGLE_GEOCODE_API_KEY)
 *  - OsmProvider      (env: OSM_USER_AGENT — Nominatim ToS requires one)
 *  - NoopProvider     (default fallback; returns null)
 */
import type { GeocodeProvider } from '../models/geo.model';

type GeocodeResult = NonNullable<Awaited<ReturnType<GeocodeProvider['geocode']>>>;
type ReverseResult = NonNullable<Awaited<ReturnType<GeocodeProvider['reverseGeocode']>>>;

/** Hard timeout for any single provider call (NFR §6: failover ≤5s). */
const PROVIDER_TIMEOUT_MS = parseInt(process.env.GEO_PROVIDER_TIMEOUT_MS || '5000', 10);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`[sdk-geo] provider ${label} timed out after ${ms}ms`);
      resolve(null);
    }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => {
        clearTimeout(timer);
        console.warn(`[sdk-geo] provider ${label} threw:`, (err as Error).message);
        resolve(null);
      },
    );
  });
}

/**
 * Wrap globalThis.fetch with an AbortController so a stuck provider can be
 * killed cleanly (otherwise withTimeout resolves null but the underlying
 * socket keeps the event loop busy). Node 18+ has fetch built-in.
 */
async function abortableFetch(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROVIDER_TIMEOUT_MS - 100);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// Mapbox — https://docs.mapbox.com/api/search/geocoding/
// ============================================================================
export class MapboxProvider implements GeocodeProvider {
  readonly name = 'mapbox' as const;
  constructor(private readonly token: string = process.env.MAPBOX_ACCESS_TOKEN ?? '') {}

  async geocode(raw_input: string): Promise<GeocodeResult | null> {
    if (!this.token) return null;
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(raw_input)}.json?limit=1&access_token=${encodeURIComponent(this.token)}`;
    const res = await abortableFetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      features?: Array<{
        id?: string;
        center?: [number, number];
        context?: Array<{ id?: string; text?: string; short_code?: string }>;
        properties?: { postcode?: string };
      }>;
    };
    const f = body.features?.[0];
    if (!f?.center) return null;
    const [lng, lat] = f.center;
    const region = f.context?.find((c) => c.id?.startsWith('region.'))?.text;
    const postal_code =
      f.properties?.postcode ??
      f.context?.find((c) => c.id?.startsWith('postcode.'))?.text;
    return { lat, lng, region, postal_code, provider_refs: { mapbox: f.id ?? '' } };
  }

  async reverseGeocode(lat: number, lng: number): Promise<ReverseResult | null> {
    if (!this.token) return null;
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?limit=1&access_token=${encodeURIComponent(this.token)}`;
    const res = await abortableFetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      features?: Array<{
        place_name?: string;
        text?: string;
        context?: Array<{ id?: string; text?: string }>;
      }>;
    };
    const f = body.features?.[0];
    if (!f) return null;
    const city = f.context?.find((c) => c.id?.startsWith('place.'))?.text ?? '';
    const country = f.context?.find((c) => c.id?.startsWith('country.'))?.text ?? '';
    return { street: f.text ?? f.place_name ?? '', city, country };
  }
}

// ============================================================================
// Google Maps Geocoding — https://developers.google.com/maps/documentation/geocoding
// ============================================================================
export class GoogleProvider implements GeocodeProvider {
  readonly name = 'google' as const;
  constructor(private readonly apiKey: string = process.env.GOOGLE_GEOCODE_API_KEY ?? '') {}

  async geocode(raw_input: string): Promise<GeocodeResult | null> {
    if (!this.apiKey) return null;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(raw_input)}&key=${encodeURIComponent(this.apiKey)}`;
    const res = await abortableFetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      status?: string;
      results?: Array<{
        place_id?: string;
        geometry?: { location?: { lat: number; lng: number } };
        address_components?: Array<{ types: string[]; long_name: string; short_name: string }>;
      }>;
    };
    if (body.status !== 'OK') return null;
    const r = body.results?.[0];
    const loc = r?.geometry?.location;
    if (!loc) return null;
    const comps = r?.address_components ?? [];
    const find = (t: string): string | undefined =>
      comps.find((c) => c.types.includes(t))?.long_name;
    return {
      lat: loc.lat,
      lng: loc.lng,
      region: find('administrative_area_level_1'),
      postal_code: find('postal_code'),
      provider_refs: { google: r?.place_id ?? '' },
    };
  }

  async reverseGeocode(lat: number, lng: number): Promise<ReverseResult | null> {
    if (!this.apiKey) return null;
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${encodeURIComponent(this.apiKey)}`;
    const res = await abortableFetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      status?: string;
      results?: Array<{
        formatted_address?: string;
        address_components?: Array<{ types: string[]; long_name: string }>;
      }>;
    };
    if (body.status !== 'OK') return null;
    const r = body.results?.[0];
    if (!r) return null;
    const comps = r.address_components ?? [];
    const find = (t: string): string =>
      comps.find((c) => c.types.includes(t))?.long_name ?? '';
    const street_number = find('street_number');
    const route = find('route');
    return {
      street: [street_number, route].filter(Boolean).join(' ') || r.formatted_address || '',
      city: find('locality') || find('postal_town'),
      country: find('country'),
    };
  }
}

// ============================================================================
// OSM Nominatim — https://nominatim.org/release-docs/develop/api/Search/
// Nominatim's usage policy requires a meaningful User-Agent and ≤1 req/sec.
// ============================================================================
export class OsmProvider implements GeocodeProvider {
  readonly name = 'osm' as const;
  constructor(
    private readonly userAgent: string = process.env.OSM_USER_AGENT ?? '',
    private readonly baseUrl: string = process.env.OSM_NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org',
  ) {}

  async geocode(raw_input: string): Promise<GeocodeResult | null> {
    if (!this.userAgent) return null;
    const url = `${this.baseUrl}/search?q=${encodeURIComponent(raw_input)}&format=json&addressdetails=1&limit=1`;
    const res = await abortableFetch(url, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) return null;
    const body = (await res.json()) as Array<{
      lat: string;
      lon: string;
      place_id?: number;
      address?: { state?: string; postcode?: string };
    }>;
    const r = body[0];
    if (!r) return null;
    return {
      lat: Number(r.lat),
      lng: Number(r.lon),
      region: r.address?.state,
      postal_code: r.address?.postcode,
      provider_refs: { osm: String(r.place_id ?? '') },
    };
  }

  async reverseGeocode(lat: number, lng: number): Promise<ReverseResult | null> {
    if (!this.userAgent) return null;
    const url = `${this.baseUrl}/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
    const res = await abortableFetch(url, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      address?: { road?: string; house_number?: string; city?: string; town?: string; village?: string; country?: string };
    };
    const a = body.address ?? {};
    return {
      street: [a.house_number, a.road].filter(Boolean).join(' '),
      city: a.city ?? a.town ?? a.village ?? '',
      country: a.country ?? '',
    };
  }
}

// ============================================================================
// Noop — terminal fallback when no provider is configured.
// ============================================================================
export class NoopProvider implements GeocodeProvider {
  readonly name = 'noop' as const;
  async geocode(): Promise<null> { return null; }
  async reverseGeocode(): Promise<null> { return null; }
}

/**
 * Provider chain: runs members in order, returns the first non-null reply.
 * NFR §6: each provider is given PROVIDER_TIMEOUT_MS before failover.
 */
export class ProviderChain implements GeocodeProvider {
  readonly name = 'noop' as const; // chain identifies as noop to callers
  constructor(private readonly chain: GeocodeProvider[]) {}
  async geocode(raw_input: string): Promise<GeocodeResult | null> {
    for (const p of this.chain) {
      const res = await withTimeout(p.geocode(raw_input), PROVIDER_TIMEOUT_MS, `${p.name}.geocode`);
      if (res) return res;
    }
    return null;
  }
  async reverseGeocode(lat: number, lng: number): Promise<ReverseResult | null> {
    for (const p of this.chain) {
      const res = await withTimeout(p.reverseGeocode(lat, lng), PROVIDER_TIMEOUT_MS, `${p.name}.reverse`);
      if (res) return res;
    }
    return null;
  }
}

/**
 * Build the default provider chain from env. Order: Mapbox → Google → OSM →
 * Noop. Each provider's geocode/reverse returns null immediately when its
 * credentials aren't set, so unconfigured deployments degrade to the noop
 * tail with no upstream calls made.
 */
export function defaultProviderChain(): ProviderChain {
  return new ProviderChain([
    new MapboxProvider(),
    new GoogleProvider(),
    new OsmProvider(),
    new NoopProvider(),
  ]);
}
