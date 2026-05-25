/**
 * Lightweight point-in-polygon implementation for territory geofence
 * lookups. The territory.geom column is JSONB GeoJSON (not PostGIS) so
 * we keep the test in-process — no external geo library and no PostGIS
 * dependency. This is good enough for the AC-2 dispatch loop: a tenant
 * with O(1k) territories per region computes inclusion in microseconds.
 *
 * Supports two GeoJSON shapes:
 *   - Polygon: { type: 'Polygon', coordinates: [[[lng, lat], ...]] }
 *   - MultiPolygon: { type: 'MultiPolygon', coordinates: [[[[lng, lat], ...]]] }
 *
 * Production verticals with millions of territories should swap to a
 * spatial index (R-tree on bbox + PostGIS ST_Contains for fine match).
 * The exported `setGeofenceChecker()` hook supports that swap.
 */

export interface GeoPoint {
  lng: number;
  lat: number;
}

export type GeofenceChecker = (point: GeoPoint, geom: unknown) => boolean;

/**
 * Ray-casting point-in-polygon over a single ring. Returns true when
 * `point` is inside the (closed) polygon defined by `ring`. The ring
 * is `[lng, lat][]` per GeoJSON spec — first/last point should match
 * but we don't enforce.
 */
function pointInRing(point: GeoPoint, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > point.lat !== yj > point.lat &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Default checker: handles GeoJSON Polygon + MultiPolygon. */
export const defaultGeofenceChecker: GeofenceChecker = (point, geom) => {
  if (!geom || typeof geom !== 'object') return false;
  const g = geom as { type?: string; coordinates?: unknown };

  if (g.type === 'Polygon' && Array.isArray(g.coordinates)) {
    const rings = g.coordinates as number[][][];
    if (rings.length === 0) return false;
    // The first ring is the outer boundary; subsequent rings are holes.
    if (!pointInRing(point, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) {
      if (pointInRing(point, rings[i])) return false;
    }
    return true;
  }

  if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
    for (const polygon of g.coordinates as number[][][][]) {
      if (polygon.length === 0) continue;
      if (!pointInRing(point, polygon[0])) continue;
      let inHole = false;
      for (let i = 1; i < polygon.length; i++) {
        if (pointInRing(point, polygon[i])) { inHole = true; break; }
      }
      if (!inHole) return true;
    }
    return false;
  }

  return false;
};

let _checker: GeofenceChecker = defaultGeofenceChecker;

export function setGeofenceChecker(checker: GeofenceChecker): void {
  _checker = checker;
}

export function getGeofenceChecker(): GeofenceChecker {
  return _checker;
}

/** Test hook — restore default checker. */
export function _resetGeofenceChecker(): void {
  _checker = defaultGeofenceChecker;
}

/**
 * Haversine distance in kilometers between two lng/lat points. Used by
 * the radius-based assignment branch when no territory matches.
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371; // Earth radius in km
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
