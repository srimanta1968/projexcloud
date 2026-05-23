import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  bboxQuery,
  canonicalize,
  geocode,
  mergeAddresses,
  readAddress,
  reverseGeocode,
} from '../services/geoService';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/geo/canonicalize', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      raw_input: string;
      street: string;
      city: string;
      country: string;
      region: string;
      postal_code: string;
      lat: number;
      lng: number;
      geo_node_id: string;
      provider_refs: Record<string, string>;
    }>;
    if (!body.raw_input || !body.street || !body.city || !body.country) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const record = await canonicalize({
      raw_input: body.raw_input,
      street: body.street,
      city: body.city,
      country: body.country,
      region: body.region,
      postal_code: body.postal_code,
      lat: body.lat,
      lng: body.lng,
      geo_node_id: body.geo_node_id,
      provider_refs: body.provider_refs,
    });
    return reply.code(200).send({ data: { address: record } });
  });

  app.get<{ Params: { address_id: string } }>(
    '/api/geo/addresses/:address_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const record = await readAddress(req.params.address_id);
      if (!record) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { address: record } });
    },
  );

  app.post('/api/geo/geocode', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ raw_input: string }>;
    if (!body.raw_input) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing raw_input'] });
    }
    const record = await geocode(body.raw_input);
    return reply.code(200).send({ data: { address: record } });
  });

  app.post('/api/geo/reverse-geocode', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ lat: number; lng: number }>;
    if (typeof body.lat !== 'number' || typeof body.lng !== 'number') {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing lat/lng'] });
    }
    const result = await reverseGeocode(body.lat, body.lng);
    return reply.code(200).send({ data: { address: result } });
  });

  app.post('/api/geo/bbox-query', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      min_lat: number;
      min_lng: number;
      max_lat: number;
      max_lng: number;
      limit: number;
    }>;
    if (
      typeof body.min_lat !== 'number' ||
      typeof body.min_lng !== 'number' ||
      typeof body.max_lat !== 'number' ||
      typeof body.max_lng !== 'number'
    ) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing bbox coords'] });
    }
    const addresses = await bboxQuery({
      min_lat: body.min_lat,
      min_lng: body.min_lng,
      max_lat: body.max_lat,
      max_lng: body.max_lng,
      limit: body.limit,
    });
    return reply.code(200).send({ data: { addresses } });
  });

  app.post('/api/geo/merge', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ winner_address_id: string; loser_address_id: string; operator_id: string }>;
    if (!body.winner_address_id || !body.loser_address_id) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const record = await mergeAddresses(body.winner_address_id, body.loser_address_id, body.operator_id);
    return reply.code(200).send({ data: { merge: record } });
  });
}
