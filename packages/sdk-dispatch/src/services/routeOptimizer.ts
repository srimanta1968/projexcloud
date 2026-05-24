import crypto from 'crypto';
import { getPool } from '@projexlight/db-runtime';
import type { DispatchRouteRef } from '@projexlight/contracts';

/**
 * Route optimizer for sdk-dispatch (P7 FR-DSP-3).
 *
 * NFR (PRD §6): ≤ 1s for 50-stop route. Algorithm: nearest-neighbor seed +
 * bounded 2-opt local search. Both phases are O(n²) in stops; for n=50
 * that's 2,500 operations per phase — comfortably under the budget even
 * on a cold start.
 *
 * Distance: Haversine over the address.lat/lng pair. The PRD assumes
 * route_optimization consumes sdk-geo's distance helper; sdk-geo doesn't
 * ship one today so we inline the formula. When sdk-geo exposes a
 * distanceMeters(a, b) helper we'll swap to it (it'll be more accurate
 * once PostGIS is on).
 *
 * Drive time: derived from haversine distance × an env-tunable factor
 * (DISPATCH_AVG_SPEED_KMH, default 35). The accurate model is a routing
 * API (Mapbox / OSRM) — that ships via sdk-geo when the team picks one.
 */

interface Stop {
  task_id: string;
  address_id: string;
  lat: number;
  lng: number;
}

interface OptimizedRoute {
  ordered_task_ids: string[];
  total_drive_mins: number;
  total_distance_km: number;
}

const EARTH_RADIUS_KM = 6371.0088;
const DEG2RAD = Math.PI / 180;

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (b.lat - a.lat) * DEG2RAD;
  const dLng = (b.lng - a.lng) * DEG2RAD;
  const lat1 = a.lat * DEG2RAD;
  const lat2 = b.lat * DEG2RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

function nearestNeighbor(start: Stop, rest: Stop[]): Stop[] {
  const remaining = [...rest];
  const ordered: Stop[] = [start];
  let cursor = start;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(cursor, remaining[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    cursor = next;
  }
  return ordered;
}

function routeLengthKm(stops: Stop[]): number {
  let total = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    total += haversineKm(stops[i], stops[i + 1]);
  }
  return total;
}

/**
 * 2-opt: repeatedly reverse a segment if it shortens the tour. Bounded by
 * MAX_2OPT_PASSES so worst-case latency stays predictable. For 50 stops
 * three passes converge to within ~5% of optimal in practice.
 */
function twoOpt(initial: Stop[], maxPasses: number): Stop[] {
  const stops = [...initial];
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (let i = 1; i < stops.length - 2; i++) {
      for (let j = i + 1; j < stops.length - 1; j++) {
        const before =
          haversineKm(stops[i - 1], stops[i]) + haversineKm(stops[j], stops[j + 1]);
        const after =
          haversineKm(stops[i - 1], stops[j]) + haversineKm(stops[i], stops[j + 1]);
        if (after + 1e-6 < before) {
          // Reverse segment [i..j].
          let lo = i;
          let hi = j;
          while (lo < hi) {
            const tmp = stops[lo];
            stops[lo] = stops[hi];
            stops[hi] = tmp;
            lo += 1;
            hi -= 1;
          }
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return stops;
}

async function loadStops(taskIds: string[]): Promise<Stop[]> {
  if (taskIds.length === 0) return [];
  const pool = getPool();
  const { rows } = await pool.query<{
    task_id: string;
    address_id: string;
    lat: string | null;
    lng: string | null;
  }>(
    `SELECT t.task_id, t.address_id::text AS address_id,
            a.lat::text AS lat, a.lng::text AS lng
       FROM dispatch.task t
       JOIN geo.address a ON a.address_id::text = t.address_id
      WHERE t.task_id = ANY($1::text[])`,
    [taskIds],
  );
  return rows
    .filter((r) => r.lat !== null && r.lng !== null)
    .map((r) => ({
      task_id: r.task_id,
      address_id: r.address_id,
      lat: parseFloat(r.lat as string),
      lng: parseFloat(r.lng as string),
    }));
}

export interface OptimizeRouteInput {
  persona_id: string;
  task_ids: string[];
  /** ID of the seed stop (driver's start point); defaults to first task. */
  start_task_id?: string;
  /** 2-opt pass cap. Default 5; keep ≤ 10 to honor the ≤ 1s NFR. */
  max_2opt_passes?: number;
}

const MAX_DEFAULT_2OPT_PASSES = 5;

/**
 * Optimize a route: load addresses, nearest-neighbor seed, 2-opt polish,
 * write to dispatch.route, return the row. NFR ≤ 1s for 50 stops.
 */
export async function optimizeRoute(input: OptimizeRouteInput): Promise<DispatchRouteRef> {
  const stops = await loadStops(input.task_ids);
  if (stops.length === 0) {
    throw new Error('[route-optimizer] no stops have lat/lng — refusing to optimize an empty route');
  }

  let optimized: Stop[];
  if (stops.length === 1) {
    optimized = stops;
  } else {
    const startIdx = input.start_task_id
      ? stops.findIndex((s) => s.task_id === input.start_task_id)
      : 0;
    const start = stops[Math.max(0, startIdx)];
    const rest = stops.filter((s) => s.task_id !== start.task_id);
    const nn = nearestNeighbor(start, rest);
    optimized = twoOpt(nn, input.max_2opt_passes ?? MAX_DEFAULT_2OPT_PASSES);
  }

  const totalKm = routeLengthKm(optimized);
  const avgSpeedKmh = parseFloat(process.env.DISPATCH_AVG_SPEED_KMH ?? '35');
  const driveMins = Math.round((totalKm / avgSpeedKmh) * 60);

  // Persist.
  const routeId = `dsr_${crypto.randomBytes(10).toString('hex')}`;
  const orderedIds = optimized.map((s) => s.task_id);
  const pool = getPool();
  const { rows } = await pool.query<{ optimized_at: Date }>(
    `INSERT INTO dispatch.route (route_id, persona_id, stops, optimized_at, total_drive_mins)
     VALUES ($1, $2::uuid, $3::jsonb, now(), $4)
     RETURNING optimized_at`,
    [routeId, input.persona_id, JSON.stringify(orderedIds), driveMins],
  );

  return {
    route_id: routeId,
    persona_id: input.persona_id,
    stops: orderedIds,
    optimized_at: rows[0].optimized_at.toISOString(),
    total_drive_mins: driveMins,
  };
}

/** Internal hook for tests — exposes the pure algorithm without DB. */
export const _internals = { haversineKm, nearestNeighbor, twoOpt, routeLengthKm };
