import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  extractContacts,
  extractContactsBatch,
  resolveContactSchema,
} from '../services/contactExtraction';
import { CONTACT_SOURCE_KINDS, type ContactSourceKind } from '../services/contactBackends';

/**
 * sdk-parsing contact-capture routes (P16). All tenant-authed — extraction reads customer
 * text, so the gateway's default-deny gate applies and each route declares requireAuth.
 */

const MAX_BATCH = 100;

function badRequest(reply: any, details: string[]) {
  return reply.code(400).send({ error: 'ValidationError', code: 'VALIDATION_ERROR', details });
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /api/parsing/contact/extract
  // -------------------------------------------------------------------------
  app.post('/api/parsing/contact/extract', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{
      tenant_id: string; source_kind: ContactSourceKind; raw: string;
      structured: unknown; allow_llm: boolean; required_fields: string[];
      taxonomy_version_id: string;
    }>;

    const missing: string[] = [];
    if (!body.tenant_id) missing.push('tenant_id is required');
    if (typeof body.raw !== 'string' || !body.raw.length) {
      // Required even for MOBILE_CONTACTS: every evidence span indexes into raw, so
      // without it no proposal could be verified and the fabrication guard would be blind.
      missing.push('raw is required — evidence spans index into it');
    }
    if (!body.source_kind) missing.push('source_kind is required');
    else if (!CONTACT_SOURCE_KINDS.includes(body.source_kind)) {
      missing.push(`source_kind must be one of: ${CONTACT_SOURCE_KINDS.join(', ')}`);
    }
    if (missing.length) return badRequest(reply, missing);

    const result = await extractContacts({
      tenant_id: body.tenant_id!,
      source_kind: body.source_kind!,
      raw: body.raw!,
      structured: body.structured,
      // Absent means false. Reaching a model with tenant text is the caller's call to make.
      allow_llm: body.allow_llm === true,
      required_fields: body.required_fields,
      taxonomy_version_id: body.taxonomy_version_id,
    });
    return reply.code(200).send({ data: result });
  });

  // -------------------------------------------------------------------------
  // POST /api/parsing/contact/extract-batch
  // -------------------------------------------------------------------------
  app.post('/api/parsing/contact/extract-batch', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<{
      tenant_id: string; allow_llm: boolean;
      items: Array<{ id?: string; source_kind: ContactSourceKind; raw: string; structured?: unknown; required_fields?: string[] }>;
    }>;

    const missing: string[] = [];
    if (!body.tenant_id) missing.push('tenant_id is required');
    if (!Array.isArray(body.items) || body.items.length === 0) {
      missing.push('items must be a non-empty array');
    } else if (body.items.length > MAX_BATCH) {
      missing.push(`items may not exceed ${MAX_BATCH} per request`);
    } else {
      body.items.forEach((it, i) => {
        if (!it || typeof it.raw !== 'string' || !it.raw.length) missing.push(`items[${i}].raw is required`);
        if (!it || !CONTACT_SOURCE_KINDS.includes(it.source_kind)) {
          missing.push(`items[${i}].source_kind must be one of: ${CONTACT_SOURCE_KINDS.join(', ')}`);
        }
      });
    }
    if (missing.length) return badRequest(reply, missing);

    const result = await extractContactsBatch({
      tenant_id: body.tenant_id!,
      allow_llm: body.allow_llm === true,
      items: body.items!,
    });
    // 200 even with per-item failures: the batch itself succeeded, and each entry carries
    // its own ok/error. A 4xx here would hide the items that did extract cleanly.
    return reply.code(200).send({ data: result });
  });

  // -------------------------------------------------------------------------
  // GET /api/parsing/contact/schemas
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { tenant_id?: string; taxonomy_version_id?: string } }>(
    '/api/parsing/contact/schemas',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query?.tenant_id) return badRequest(reply, ['tenant_id query param required']);
      const schema = await resolveContactSchema({
        tenant_id: req.query.tenant_id,
        taxonomy_version_id: req.query.taxonomy_version_id,
      });
      return reply.code(200).send({
        data: {
          schema,
          // Returned so a client can build its capture UI from the server's answer rather
          // than hard-coding a list that drifts the moment a backend is added.
          source_kinds: CONTACT_SOURCE_KINDS,
        },
      });
    },
  );
}
