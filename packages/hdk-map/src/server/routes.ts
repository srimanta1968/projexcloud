import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';

/**
 * hdk-map — TS facade for native maps (annotations, geofences, routing).
 *
 * Native modules: iOS Swift (MapKit), Android Kotlin (Mapbox SDK).
 * This TS surface exposes capability discovery, supported overlay types,
 * and tile-server provider configuration that the native bridge consumes
 * at runtime.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/hdk/map/capabilities', { preHandler: requireAuth }, async () => {
    return {
      data: {
        overlays: ['pin', 'polyline', 'polygon', 'heatmap', 'cluster'],
        gestures: ['pan', 'pinch_zoom', 'rotate', 'tilt'],
        offline_caching: true,
        geofencing: true,
        routing_modes: ['driving', 'walking', 'cycling', 'transit'],
        native_modules: {
          ios: 'ProjexMapKit.framework',
          android: 'projex-map.aar',
        },
      },
    };
  });

  app.get('/api/hdk/map/tile-providers', { preHandler: requireAuth }, async () => {
    // Tile URLs use {z}/{x}/{y} placeholders the native bridge substitutes
    // per pan/zoom. Auth tokens are NEVER returned here — clients obtain
    // them via sdk-secrets so credentials never live in JS bundles.
    return {
      data: {
        providers: [
          { name: 'mapbox-streets',   pattern: 'mapbox://styles/mapbox/streets-v12',   requires_token: true },
          { name: 'mapbox-satellite', pattern: 'mapbox://styles/mapbox/satellite-v9',  requires_token: true },
          { name: 'apple-standard',   pattern: 'mapkit://standard',                    requires_token: false },
          { name: 'osm',              pattern: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', requires_token: false },
        ],
      },
    };
  });
}
