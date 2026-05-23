import crypto from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import type {
  AddressRecord,
  BboxQueryInput,
  CanonicalizeInput,
  GeocodeProvider,
  MergeEventRecord,
} from '../models/geo.model';

const GEO_AUDIT_POOL = process.env.GEO_AUDIT_POOL || 'admin-default';

async function emitGeoAudit(opts: {
  event_type: 'geo.address.canonicalized.v1' | 'geo.address.merged.v1';
  subject_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
  retention_class: 'operational' | 'regulated';
}): Promise<void> {
  try {
    await appendAuditEntry({
      pool_index: GEO_AUDIT_POOL,
      event_type: opts.event_type,
      actor_kind: 'service',
      actor_id: opts.actor_id,
      subject_kind: 'geo.address',
      subject_id: opts.subject_id,
      retention_class: opts.retention_class,
      payload: opts.payload,
    });
  } catch (err) {
     
    console.error('[sdk-geo] audit emit failed', opts.event_type, (err as Error).message);
  }
}

/**
 * sdk-geo service per P3 PRD §5.5 / FR-GEO-1..5.
 *
 * Consolidation pattern: duplicates resolved to one canonical address_id via
 * normalized hash of (street + city + country + postal_code).
 */

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function hashInput(input: CanonicalizeInput): Buffer {
  const norm = [
    normalize(input.street),
    normalize(input.city),
    normalize(input.country),
    input.postal_code ? normalize(input.postal_code) : '',
  ].join('|');
  return crypto.createHash('sha256').update(norm).digest();
}

function rawHash(raw: string): Buffer {
  return crypto.createHash('sha256').update(normalize(raw)).digest();
}

import { defaultProviderChain } from '../providers';

// Active provider is a chain (Mapbox → Google → OSM → Noop) with per-provider
// timeouts (NFR §6 failover ≤5s). Swap via setProvider() for tests.
let activeProvider: GeocodeProvider = defaultProviderChain();

export function setProvider(p: GeocodeProvider): void {
  activeProvider = p;
}

export function getProvider(): GeocodeProvider {
  return activeProvider;
}

/**
 * Consolidation pattern canonicalize (FR-GEO-1). If the raw_input hash already
 * maps to an alias, returns the existing canonical row. Otherwise dedups by
 * normalized (street, city, country, postal_code) hash.
 */
export async function canonicalize(input: CanonicalizeInput): Promise<AddressRecord> {
  const aliasHash = rawHash(input.raw_input);
  const existingAlias = await dataService.one<{ address_id: string }>(
    `SELECT address_id FROM geo.address_alias WHERE hash = $1`,
    [aliasHash],
  );
  if (existingAlias) {
    return readAddress(existingAlias.address_id) as Promise<AddressRecord>;
  }

  const canonicalHash = hashInput(input);
  const sibling = await dataService.one<{ alias_id: string; address_id: string }>(
    `SELECT a.alias_id, a.address_id
       FROM geo.address_alias a
      WHERE a.hash = $1 LIMIT 1`,
    [canonicalHash],
  );

  let address_id: string;
  if (sibling) {
    address_id = sibling.address_id;
  } else {
    const rows = await dataService.rows<{ address_id: string }>(
      `INSERT INTO geo.address
         (street, city, region, postal_code, country, lat, lng, geo_node_id, provider_refs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING address_id`,
      [
        input.street,
        input.city,
        input.region ?? null,
        input.postal_code ?? null,
        input.country,
        input.lat ?? null,
        input.lng ?? null,
        input.geo_node_id ?? null,
        JSON.stringify(input.provider_refs ?? {}),
      ],
    );
    address_id = rows[0].address_id;
    // canonical-hash alias points raw_input == none of the actual input.
    await dataService.query(
      `INSERT INTO geo.address_alias (address_id, raw_input, hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (hash) DO NOTHING`,
      [address_id, `${input.street}, ${input.city}, ${input.country}`, canonicalHash],
    );
  }

  // Always record the alias for the actual raw_input.
  await dataService.query(
    `INSERT INTO geo.address_alias (address_id, raw_input, hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (hash) DO NOTHING`,
    [address_id, input.raw_input, aliasHash],
  );

  // Only emit on first-canonicalization (not on alias-only repeats).
  if (!sibling) {
    await emitGeoAudit({
      event_type: 'geo.address.canonicalized.v1',
      subject_id: address_id,
      actor_id: 'sdk-geo.canonicalize',
      payload: {
        country: input.country,
        city: input.city,
        provider_refs: input.provider_refs ?? {},
      },
      retention_class: 'operational',
    });
  }

  return readAddress(address_id) as Promise<AddressRecord>;
}

export async function readAddress(address_id: string): Promise<AddressRecord | null> {
  return dataService.one<AddressRecord>(
    `SELECT address_id, street, city, region, postal_code, country,
            lat, lng, geo_node_id, provider_refs, created_at
       FROM geo.address WHERE address_id = $1`,
    [address_id],
  );
}

/**
 * Geocode via the active provider. If provider returns coordinates, those
 * decorate the canonicalize call.
 */
export async function geocode(raw_input: string): Promise<AddressRecord | null> {
  const enriched = await activeProvider.geocode(raw_input);
  // Caller supplies street/city/country; the geocode helper only enriches.
  // Without those a canonical row cannot be created — return null and let the
  // caller decide whether to canonicalize with partial data.
  if (!enriched) return null;
  // Minimal degraded canonicalize: treat raw_input as a single-line street.
  return canonicalize({
    raw_input,
    street: raw_input,
    city: '?',
    country: '?',
    region: enriched.region,
    postal_code: enriched.postal_code,
    lat: enriched.lat ?? undefined,
    lng: enriched.lng ?? undefined,
    provider_refs: enriched.provider_refs ?? {},
  });
}

export async function reverseGeocode(lat: number, lng: number): Promise<{ street: string; city: string; country: string } | null> {
  return activeProvider.reverseGeocode(lat, lng);
}

/**
 * Bounding-box query. Uses PostGIS when available; falls back to a
 * straight lat/lng range scan.
 */
export async function bboxQuery(input: BboxQueryInput): Promise<AddressRecord[]> {
  const limit = Math.min(input.limit ?? 100, 1000);
  try {
    return await dataService.rows<AddressRecord>(
      `SELECT address_id, street, city, region, postal_code, country,
              lat, lng, geo_node_id, provider_refs, created_at
         FROM geo.address
        WHERE ST_Intersects(
          geom,
          ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography
        )
        LIMIT $5`,
      [input.min_lng, input.min_lat, input.max_lng, input.max_lat, limit],
    );
  } catch {
    // PostGIS unavailable — fall back to range scan on lat/lng columns.
    return dataService.rows<AddressRecord>(
      `SELECT address_id, street, city, region, postal_code, country,
              lat, lng, geo_node_id, provider_refs, created_at
         FROM geo.address
        WHERE lat BETWEEN $1 AND $2
          AND lng BETWEEN $3 AND $4
          AND lat IS NOT NULL AND lng IS NOT NULL
        LIMIT $5`,
      [input.min_lat, input.max_lat, input.min_lng, input.max_lng, limit],
    );
  }
}

/**
 * Manual merge of two canonical rows. Records the merge_event so operators
 * can trace the consolidation history.
 */
export async function mergeAddresses(
  winner_address_id: string,
  loser_address_id: string,
  operator_id?: string,
): Promise<MergeEventRecord> {
  // Re-point all aliases of the loser to the winner.
  await dataService.query(
    `UPDATE geo.address_alias SET address_id = $1 WHERE address_id = $2`,
    [winner_address_id, loser_address_id],
  );
  const rows = await dataService.rows<MergeEventRecord>(
    `INSERT INTO geo.merge_event (winner_address_id, loser_address_id, operator_id)
     VALUES ($1, $2, $3)
     RETURNING merge_id, winner_address_id, loser_address_id, occurred_at, operator_id`,
    [winner_address_id, loser_address_id, operator_id ?? null],
  );
  await dataService.query(`DELETE FROM geo.address WHERE address_id = $1`, [loser_address_id]);
  const merge = rows[0];
  await emitGeoAudit({
    event_type: 'geo.address.merged.v1',
    subject_id: winner_address_id,
    actor_id: operator_id ?? 'sdk-geo.mergeAddresses',
    payload: { winner_address_id, loser_address_id, merge_id: merge.merge_id },
    retention_class: 'regulated',
  });
  return merge;
}
