import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  captureSourceRecord,
  normalizeSourceRecord,
  promoteSourceRecord,
  getSourceRecord,
  listSourceRecords,
  linkCrosswalk,
  listCrosswalks,
  SourceRecordNotFound,
  PromotionEvidenceMissing,
  InvalidTrustTransition,
  RecordQuarantined,
} from '../services/sourceRecordService';
import {
  writeAssertion,
  supersedeAssertion,
  queryAssertions,
  AssertionNotFound,
  AssertionAlreadySuperseded,
} from '../services/assertionService';
import {
  signAttestation,
  getAttestation,
  listAttestations,
  checkPermittedUse,
  AttestationEvidenceMissing,
  AttestationNotFound,
  CaptureFingerprintUnknown,
} from '../services/attestationService';
import type {
  EvidenceKind,
  OriginClass,
  TrustState,
  AssertionStatus,
} from '../models/sourceRecord.model';

/**
 * sdk-source-record Fastify routes (P16 · EP-374 · PCF-01-5).
 *
 * Every route is tenant-JWT protected (requireAuth) and carries tenant_id in the
 * body or query, matching the sibling sdk-scheduling / sdk-sequence surfaces.
 *
 * Status codes follow MUST-54: collection-root creates return 201; the action
 * endpoints (/normalize, /promote, /supersede) return 200 because they move an
 * existing resource rather than creating one; reads return 200.
 *
 * The service layer's typed errors carry their own `status` and `code`, so the
 * mapper below returns the SAME code the caller can assert on rather than
 * flattening everything to a generic 400 — a 422 that names the missing evidence
 * is the whole point of the trust ladder's refusals.
 */

interface DomainError {
  status: number;
  code: string;
  message: string;
}

function isDomainError(err: unknown): err is DomainError & Error {
  return (
    err instanceof Error &&
    typeof (err as Partial<DomainError>).status === 'number' &&
    typeof (err as Partial<DomainError>).code === 'string'
  );
}

/** Map a typed service error onto its declared status + code, or rethrow. */
function sendDomainError(reply: import('fastify').FastifyReply, err: unknown): unknown {
  if (!isDomainError(err)) throw err;
  const body: Record<string, unknown> = {
    error: err.name,
    code: err.code,
    message: err.message,
  };
  if (err instanceof PromotionEvidenceMissing) {
    body.missing_evidence = err.missing_evidence;
    body.from_state = err.from_state;
    body.to_state = err.to_state;
  }
  if (err instanceof InvalidTrustTransition) {
    body.from_state = err.from_state;
    body.to_state = err.to_state;
    body.allowed = err.allowed;
  }
  if (err instanceof AssertionAlreadySuperseded) {
    body.superseded_by = err.superseded_by;
  }
  return reply.code(err.status).send(body);
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------- source records */

  app.post('/api/source-records', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      source_system: string;
      raw_evidence: Record<string, unknown>;
      fingerprint: string;
      source_external_id: string;
      origin_class: string;
      evidence_kind: EvidenceKind;
      evidence_ref: string;
      subject_ref: string;
      retrieved_at: string;
      metadata: Record<string, unknown>;
      actor_id: string;
      purpose: string;
      causation_id: string;
    }>;
    if (!body.tenant_id || !body.source_system || !body.raw_evidence) {
      return reply.code(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_ERROR',
        message: 'tenant_id, source_system and raw_evidence are required',
      });
    }
    const result = await captureSourceRecord({
      tenant_id: body.tenant_id,
      source_system: body.source_system,
      raw_evidence: body.raw_evidence,
      fingerprint: body.fingerprint,
      source_external_id: body.source_external_id,
      origin_class: body.origin_class,
      evidence_kind: body.evidence_kind,
      evidence_ref: body.evidence_ref,
      subject_ref: body.subject_ref,
      retrieved_at: body.retrieved_at,
      metadata: body.metadata,
      actor_id: body.actor_id,
      purpose: body.purpose,
      causation_id: body.causation_id,
    });
    // 201 whether the capture was created or deduped: the caller's capture exists
    // and the body says which happened, so a retry is not an error.
    return reply.code(201).send({
      data: {
        source_record: result.record,
        created: result.created,
        quarantined: result.quarantined,
      },
    });
  });

  app.get<{
    Querystring: {
      tenant_id?: string;
      trust_state?: TrustState;
      origin_class?: OriginClass;
      source_system?: string;
      subject_ref?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/source-records', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.query.tenant_id) {
      return reply.code(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_ERROR',
        message: 'tenant_id query param required',
      });
    }
    const source_records = await listSourceRecords({
      tenant_id: req.query.tenant_id,
      trust_state: req.query.trust_state,
      origin_class: req.query.origin_class,
      source_system: req.query.source_system,
      subject_ref: req.query.subject_ref,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    return reply.code(200).send({ data: { source_records, count: source_records.length } });
  });

  app.get<{ Params: { capture_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/source-records/:capture_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query.tenant_id) {
        return reply.code(400).send({
          error: 'ValidationError',
          code: 'VALIDATION_ERROR',
          message: 'tenant_id query param required',
        });
      }
      try {
        const source_record = await getSourceRecord(req.query.tenant_id, req.params.capture_id);
        const crosswalks = await listCrosswalks(req.query.tenant_id, req.params.capture_id);
        return reply.code(200).send({ data: { source_record, crosswalks } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.post<{ Params: { capture_id: string } }>(
    '/api/source-records/:capture_id/normalize',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as Partial<{
        tenant_id: string;
        actor_id: string;
        purpose: string;
        causation_id: string;
      }>;
      if (!body.tenant_id) {
        return reply.code(400).send({
          error: 'ValidationError',
          code: 'VALIDATION_ERROR',
          message: 'tenant_id is required',
        });
      }
      try {
        const source_record = await normalizeSourceRecord({
          tenant_id: body.tenant_id,
          capture_id: req.params.capture_id,
          actor_id: body.actor_id,
          purpose: body.purpose,
          causation_id: body.causation_id,
        });
        return reply.code(200).send({ data: { source_record } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.post<{ Params: { capture_id: string } }>(
    '/api/source-records/:capture_id/promote',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as Partial<{
        tenant_id: string;
        to_state: TrustState;
        evidence_ref: string;
        evidence_origin_class: string;
        subject_ref: string;
        actor_id: string;
        purpose: string;
        causation_id: string;
        decision_ref: string;
      }>;
      if (!body.tenant_id || !body.to_state) {
        return reply.code(400).send({
          error: 'ValidationError',
          code: 'VALIDATION_ERROR',
          message: 'tenant_id and to_state are required',
        });
      }
      try {
        const source_record = await promoteSourceRecord({
          tenant_id: body.tenant_id,
          capture_id: req.params.capture_id,
          to_state: body.to_state,
          evidence_ref: body.evidence_ref,
          evidence_origin_class: body.evidence_origin_class,
          subject_ref: body.subject_ref,
          actor_id: body.actor_id,
          purpose: body.purpose,
          causation_id: body.causation_id,
          decision_ref: body.decision_ref,
        });
        return reply.code(200).send({ data: { source_record } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.post<{ Params: { capture_id: string } }>(
    '/api/source-records/:capture_id/crosswalks',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as Partial<{
        tenant_id: string;
        external_system: string;
        external_id: string;
        subject_ref: string;
        metadata: Record<string, unknown>;
        actor_id: string;
        purpose: string;
        causation_id: string;
      }>;
      if (!body.tenant_id || !body.external_system || !body.external_id) {
        return reply.code(400).send({
          error: 'ValidationError',
          code: 'VALIDATION_ERROR',
          message: 'tenant_id, external_system and external_id are required',
        });
      }
      try {
        const crosswalk = await linkCrosswalk({
          tenant_id: body.tenant_id,
          capture_id: req.params.capture_id,
          external_system: body.external_system,
          external_id: body.external_id,
          subject_ref: body.subject_ref,
          metadata: body.metadata,
          actor_id: body.actor_id,
          purpose: body.purpose,
          causation_id: body.causation_id,
        });
        return reply.code(201).send({ data: { crosswalk } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  /* ---------------------------------------------------------- assertions */

  app.post('/api/source-assertions', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      subject_ref: string;
      attribute: string;
      value: string;
      origin_class: OriginClass;
      capture_id: string;
      confidence: number;
      effective_from: string;
      effective_to: string;
      retrieved_at: string;
      status: AssertionStatus;
      evidence_ref: string;
      is_pii: boolean;
      metadata: Record<string, unknown>;
      actor_id: string;
      purpose: string;
      causation_id: string;
    }>;
    if (!body.tenant_id || !body.subject_ref || !body.attribute || body.value == null || !body.origin_class) {
      return reply.code(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_ERROR',
        message: 'tenant_id, subject_ref, attribute, value and origin_class are required',
      });
    }
    const assertion = await writeAssertion({
      tenant_id: body.tenant_id,
      subject_ref: body.subject_ref,
      attribute: body.attribute,
      value: body.value,
      origin_class: body.origin_class,
      capture_id: body.capture_id,
      confidence: body.confidence,
      effective_from: body.effective_from,
      effective_to: body.effective_to,
      retrieved_at: body.retrieved_at,
      status: body.status,
      evidence_ref: body.evidence_ref,
      is_pii: body.is_pii,
      metadata: body.metadata,
      actor_id: body.actor_id,
      purpose: body.purpose,
      causation_id: body.causation_id,
    });
    return reply.code(201).send({ data: { assertion } });
  });

  app.get<{
    Querystring: {
      tenant_id?: string;
      subject_ref?: string;
      attribute?: string;
      origin_class?: OriginClass;
      status?: AssertionStatus;
      effective_at?: string;
      exclude_superseded?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/source-assertions', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.query.tenant_id) {
      return reply.code(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_ERROR',
        message: 'tenant_id query param required',
      });
    }
    const assertions = await queryAssertions({
      tenant_id: req.query.tenant_id,
      subject_ref: req.query.subject_ref,
      attribute: req.query.attribute,
      origin_class: req.query.origin_class,
      status: req.query.status,
      effective_at: req.query.effective_at,
      exclude_superseded: req.query.exclude_superseded === 'true',
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    // Values stay enveloped in the list response — reading the identifier behind a
    // claim is a separate, narrower operation than listing the claims.
    return reply.code(200).send({ data: { assertions, count: assertions.length } });
  });

  app.post<{ Params: { assertion_id: string } }>(
    '/api/source-assertions/:assertion_id/supersede',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as Partial<{
        tenant_id: string;
        value: string;
        origin_class: OriginClass;
        subject_ref: string;
        attribute: string;
        capture_id: string;
        confidence: number;
        effective_from: string;
        effective_to: string;
        retrieved_at: string;
        status: AssertionStatus;
        evidence_ref: string;
        is_pii: boolean;
        metadata: Record<string, unknown>;
        reason: string;
        actor_id: string;
        purpose: string;
        causation_id: string;
      }>;
      if (!body.tenant_id || body.value == null) {
        return reply.code(400).send({
          error: 'ValidationError',
          code: 'VALIDATION_ERROR',
          message: 'tenant_id and the replacement value are required',
        });
      }
      try {
        const { prior, replacement } = await supersedeAssertion({
          tenant_id: body.tenant_id,
          assertion_id: req.params.assertion_id,
          reason: body.reason,
          actor_id: body.actor_id,
          purpose: body.purpose,
          causation_id: body.causation_id,
          replacement: {
            value: body.value,
            origin_class: body.origin_class as OriginClass,
            subject_ref: body.subject_ref,
            attribute: body.attribute,
            capture_id: body.capture_id,
            confidence: body.confidence,
            effective_from: body.effective_from,
            effective_to: body.effective_to,
            retrieved_at: body.retrieved_at,
            status: body.status,
            evidence_ref: body.evidence_ref,
            is_pii: body.is_pii,
            metadata: body.metadata,
          },
        });
        return reply.code(200).send({ data: { prior, replacement } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  /* -------------------------------------------------------- source rights */

  app.post('/api/source-rights/attestations', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      attestor_principal: string;
      origin_class: OriginClass;
      permitted_uses: string[];
      capture_id: string;
      source_fingerprint: string;
      jurisdiction: string;
      license_ref: string;
      collection_period_start: string;
      collection_period_end: string;
      evidence_blob_ref: string;
      evidence_payload: Record<string, unknown>;
      evidence_kind: EvidenceKind;
      mapping_version: string;
      metadata: Record<string, unknown>;
      purpose: string;
      causation_id: string;
    }>;
    if (
      !body.tenant_id ||
      !body.attestor_principal ||
      !body.origin_class ||
      !Array.isArray(body.permitted_uses)
    ) {
      return reply.code(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_ERROR',
        message: 'tenant_id, attestor_principal, origin_class and permitted_uses[] are required',
      });
    }
    try {
      const attestation = await signAttestation({
        tenant_id: body.tenant_id,
        attestor_principal: body.attestor_principal,
        origin_class: body.origin_class,
        permitted_uses: body.permitted_uses,
        capture_id: body.capture_id,
        source_fingerprint: body.source_fingerprint,
        jurisdiction: body.jurisdiction,
        license_ref: body.license_ref,
        collection_period_start: body.collection_period_start,
        collection_period_end: body.collection_period_end,
        evidence_blob_ref: body.evidence_blob_ref,
        evidence_payload: body.evidence_payload,
        evidence_kind: body.evidence_kind,
        mapping_version: body.mapping_version,
        metadata: body.metadata,
        purpose: body.purpose,
        causation_id: body.causation_id,
      });
      return reply.code(201).send({ data: { attestation } });
    } catch (err) {
      if (err instanceof AttestationEvidenceMissing || err instanceof CaptureFingerprintUnknown) {
        return sendDomainError(reply, err);
      }
      return sendDomainError(reply, err);
    }
  });

  app.get<{ Params: { attestation_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/source-rights/attestations/:attestation_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.query.tenant_id) {
        return reply.code(400).send({
          error: 'ValidationError',
          code: 'VALIDATION_ERROR',
          message: 'tenant_id query param required',
        });
      }
      try {
        const attestation = await getAttestation(req.query.tenant_id, req.params.attestation_id);
        return reply.code(200).send({ data: { attestation } });
      } catch (err) {
        return sendDomainError(reply, err);
      }
    },
  );

  app.get<{
    Querystring: {
      tenant_id?: string;
      capture_id?: string;
      origin_class?: OriginClass;
      limit?: string;
      offset?: string;
    };
  }>('/api/source-rights/attestations', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.query.tenant_id) {
      return reply.code(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_ERROR',
        message: 'tenant_id query param required',
      });
    }
    const attestations = await listAttestations({
      tenant_id: req.query.tenant_id,
      capture_id: req.query.capture_id,
      origin_class: req.query.origin_class,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    return reply.code(200).send({ data: { attestations, count: attestations.length } });
  });

  /**
   * The refusal mechanism, over HTTP. A consumer in another service asks whether a
   * purpose is covered before acting; a false verdict names WHY and lists the uses
   * that are granted. Always 200 — "not permitted" is a successful answer to the
   * question, not a failure of the request.
   */
  app.get<{
    Querystring: {
      tenant_id?: string;
      purpose?: string;
      subject_ref?: string;
      capture_id?: string;
      source_fingerprint?: string;
      at?: string;
    };
  }>('/api/source-rights/permitted-use', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.query.tenant_id || !req.query.purpose) {
      return reply.code(400).send({
        error: 'ValidationError',
        code: 'VALIDATION_ERROR',
        message: 'tenant_id and purpose query params are required',
      });
    }
    const verdict = await checkPermittedUse({
      tenant_id: req.query.tenant_id,
      purpose: req.query.purpose,
      subject_ref: req.query.subject_ref,
      capture_id: req.query.capture_id,
      source_fingerprint: req.query.source_fingerprint,
      at: req.query.at,
    });
    return reply.code(200).send({ data: verdict });
  });
}

/* Re-exported so a consuming app can narrow on the same error identities. */
export {
  SourceRecordNotFound,
  PromotionEvidenceMissing,
  InvalidTrustTransition,
  RecordQuarantined,
  AssertionNotFound,
  AssertionAlreadySuperseded,
  AttestationEvidenceMissing,
  AttestationNotFound,
  CaptureFingerprintUnknown,
};
