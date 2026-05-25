/**
 * Unit tests for the territory geofence + haversine helpers.
 *
 * No DB required — pure functional logic over GeoJSON shapes.
 */

import { describe, expect, it } from 'vitest';
import { defaultGeofenceChecker, haversineKm, type GeoPoint } from '../src/services/geofence';

const austinPolygon = {
  type: 'Polygon',
  coordinates: [[
    [-97.95, 30.10],
    [-97.55, 30.10],
    [-97.55, 30.50],
    [-97.95, 30.50],
    [-97.95, 30.10],
  ]],
};

const usCoastsMultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [[
      [-124.0, 32.0],
      [-117.0, 32.0],
      [-117.0, 42.0],
      [-124.0, 42.0],
      [-124.0, 32.0],
    ]],
    [[
      [-80.0, 25.0],
      [-72.0, 25.0],
      [-72.0, 41.0],
      [-80.0, 41.0],
      [-80.0, 25.0],
    ]],
  ],
};

const polygonWithHole = {
  type: 'Polygon',
  coordinates: [
    [
      [-98.0, 30.0],
      [-97.0, 30.0],
      [-97.0, 31.0],
      [-98.0, 31.0],
      [-98.0, 30.0],
    ],
    [
      [-97.75, 30.25],
      [-97.25, 30.25],
      [-97.25, 30.75],
      [-97.75, 30.75],
      [-97.75, 30.25],
    ],
  ],
};

describe('defaultGeofenceChecker · Polygon', () => {
  it('returns true for an interior point', () => {
    const austin: GeoPoint = { lng: -97.75, lat: 30.27 };
    expect(defaultGeofenceChecker(austin, austinPolygon)).toBe(true);
  });

  it('returns false for an exterior point', () => {
    const houston: GeoPoint = { lng: -95.36, lat: 29.76 };
    expect(defaultGeofenceChecker(houston, austinPolygon)).toBe(false);
  });

  it('respects holes (donut polygon)', () => {
    const insideHole: GeoPoint = { lng: -97.5, lat: 30.5 };
    expect(defaultGeofenceChecker(insideHole, polygonWithHole)).toBe(false);

    const insidePolygonOutsideHole: GeoPoint = { lng: -97.9, lat: 30.1 };
    expect(defaultGeofenceChecker(insidePolygonOutsideHole, polygonWithHole)).toBe(true);

    const exterior: GeoPoint = { lng: -90.0, lat: 30.5 };
    expect(defaultGeofenceChecker(exterior, polygonWithHole)).toBe(false);
  });
});

describe('defaultGeofenceChecker · MultiPolygon', () => {
  it('returns true when point is in any polygon', () => {
    const sf: GeoPoint = { lng: -122.42, lat: 37.77 };
    const nyc: GeoPoint = { lng: -74.0, lat: 40.71 };
    expect(defaultGeofenceChecker(sf, usCoastsMultiPolygon)).toBe(true);
    expect(defaultGeofenceChecker(nyc, usCoastsMultiPolygon)).toBe(true);
  });

  it('returns false when point is in neither polygon', () => {
    const denver: GeoPoint = { lng: -104.99, lat: 39.74 };
    expect(defaultGeofenceChecker(denver, usCoastsMultiPolygon)).toBe(false);
  });
});

describe('defaultGeofenceChecker · invalid inputs', () => {
  it('returns false for non-GeoJSON', () => {
    expect(defaultGeofenceChecker({ lng: 0, lat: 0 }, null)).toBe(false);
    expect(defaultGeofenceChecker({ lng: 0, lat: 0 }, {})).toBe(false);
    expect(defaultGeofenceChecker({ lng: 0, lat: 0 }, { type: 'Point' })).toBe(false);
  });
});

describe('haversineKm', () => {
  it('returns 0 for identical points', () => {
    const p: GeoPoint = { lng: -97.7, lat: 30.3 };
    expect(haversineKm(p, p)).toBeCloseTo(0, 5);
  });

  it('matches a known SF → NYC distance within 1%', () => {
    const sf: GeoPoint = { lng: -122.42, lat: 37.77 };
    const nyc: GeoPoint = { lng: -74.0, lat: 40.71 };
    const d = haversineKm(sf, nyc);
    // The published SF↔NYC great-circle distance is ~4140 km.
    expect(d).toBeGreaterThan(4100);
    expect(d).toBeLessThan(4180);
  });

  it('is symmetric', () => {
    const a: GeoPoint = { lng: -97.7, lat: 30.3 };
    const b: GeoPoint = { lng: -95.4, lat: 29.8 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 6);
  });
});
