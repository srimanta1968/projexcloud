import { FastifyReply, FastifyRequest } from 'fastify';
import {
  BlobNotFoundError,
  SealedEncounterError,
  TenantOwnershipError,
  issuePlaybackUrl,
  issueUploadUrl,
  markBlobReady,
} from '../../services/blobService';
import { getTranscodeJob, requestTranscode } from '../../services/transcodeService';
import {
  validateIssueUploadUrl,
  validateMarkReady,
  validateRequestTranscode,
} from '../../validators/mediaValidator';

function authTenant(req: FastifyRequest, reply: FastifyReply): string | null {
  const tid = req.auth?.tenant_id;
  if (!tid) {
    reply.code(403).send({ error: 'Forbidden', details: ['JWT missing tenant_id claim'] });
    return null;
  }
  return tid;
}

function fail(req: FastifyRequest, reply: FastifyReply, err: unknown): void {
  if (err instanceof BlobNotFoundError) {
    reply.code(404).send({ error: err.code, details: [err.message] });
    return;
  }
  if (err instanceof SealedEncounterError) {
    reply.code(409).send({ error: err.code, details: [err.message] });
    return;
  }
  if (err instanceof TenantOwnershipError) {
    reply.code(403).send({ error: err.code, details: [err.message] });
    return;
  }
  const msg = (err as Error).message;
  if (msg.includes('No active vault tenant key')) {
    reply.code(400).send({ error: 'VaultKeyMissing', details: [msg] });
    return;
  }
  if (msg.includes('shredded')) {
    reply.code(410).send({ error: 'Gone', details: [msg] });
    return;
  }
  req.log.error(err);
  reply.code(500).send({ error: 'InternalError' });
}

/** POST /api/media/upload-url - issue presigned upload URL per FR-MED-1. */
export async function issueUploadUrlHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const body = { ...(req.body as Record<string, unknown> ?? {}), tenant_id: tid };
  const v = validateIssueUploadUrl(body);
  if (!v.ok) {
    reply.code(400).send({ error: 'ValidationError', details: v.errors });
    return;
  }
  try {
    const result = await issueUploadUrl(v.value);
    reply.code(201).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/media/:blob_id/ready - client commits upload + reports checksum. */
export async function markReadyHandler(
  req: FastifyRequest<{ Params: { blob_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const v = validateMarkReady(req.body);
  if (!v.ok) {
    reply.code(400).send({ error: 'ValidationError', details: v.errors });
    return;
  }
  try {
    const blob = await markBlobReady(req.params.blob_id, v.value.checksum_hex, tid);
    reply.code(200).send({ data: { blob } });
  } catch (err) { fail(req, reply, err); }
}

/** GET /api/media/:blob_id/playback-url - issue presigned download URL per FR-MED-4. */
export async function issuePlaybackUrlHandler(
  req: FastifyRequest<{ Params: { blob_id: string }; Querystring: { ttl_seconds?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  if (!req.auth?.sub) {
    reply.code(401).send({ error: 'Unauthorized', details: ['Missing person_id in JWT'] });
    return;
  }
  const ttl_seconds = req.query.ttl_seconds ? Number(req.query.ttl_seconds) : undefined;
  if (ttl_seconds !== undefined && (!Number.isFinite(ttl_seconds) || ttl_seconds <= 0)) {
    reply.code(400).send({ error: 'ValidationError', details: ['ttl_seconds must be a positive number'] });
    return;
  }
  try {
    const result = await issuePlaybackUrl(req.params.blob_id, req.auth.sub, ttl_seconds, tid);
    reply.code(200).send({ data: result });
  } catch (err) { fail(req, reply, err); }
}

/** POST /api/media/:blob_id/transcode - enqueue transcode job per FR-MED-3. */
export async function requestTranscodeHandler(
  req: FastifyRequest<{ Params: { blob_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const tid = authTenant(req, reply); if (!tid) return;
  const v = validateRequestTranscode(req.body);
  if (!v.ok) {
    reply.code(400).send({ error: 'ValidationError', details: v.errors });
    return;
  }
  try {
    const job = await requestTranscode(req.params.blob_id, v.value, tid);
    reply.code(201).send({ data: { job } });
  } catch (err) { fail(req, reply, err); }
}

/** GET /api/media/transcode-jobs/:job_id - poll transcode status. */
export async function getTranscodeJobHandler(
  req: FastifyRequest<{ Params: { job_id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  try {
    const job = await getTranscodeJob(req.params.job_id);
    if (!job) {
      reply.code(404).send({ error: 'NotFound', details: [`No transcode job ${req.params.job_id}`] });
      return;
    }
    reply.code(200).send({ data: { job } });
  } catch (err) { fail(req, reply, err); }
}
