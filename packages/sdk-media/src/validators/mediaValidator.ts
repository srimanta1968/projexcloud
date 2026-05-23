import type {
  IssueUploadUrlInput,
  RequestTranscodeInput,
  TranscodePipeline,
} from '../models/media.model';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const VALID_PIPELINES: TranscodePipeline[] = ['video-mp4-hls', 'image-optimize', 'pdf-thumbnail'];
const MAX_BYTE_SIZE = 5 * 1024 * 1024 * 1024; // 5 GiB upper bound for a single upload

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function validateIssueUploadUrl(body: unknown): ValidationResult<IssueUploadUrlInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(b.tenant_id);
  const persona_id = asString(b.persona_id);
  const content_type = asString(b.content_type);
  const byte_size = typeof b.byte_size === 'number' ? b.byte_size : Number.NaN;
  const encounter_id = typeof b.encounter_id === 'string' ? b.encounter_id : undefined;
  const ttl_seconds = typeof b.ttl_seconds === 'number' ? b.ttl_seconds : undefined;

  if (!tenant_id) errors.push('tenant_id is required');
  if (!persona_id) errors.push('persona_id is required');
  if (!content_type) errors.push('content_type is required');
  if (!Number.isFinite(byte_size) || byte_size <= 0) errors.push('byte_size must be a positive number');
  if (byte_size > MAX_BYTE_SIZE) errors.push(`byte_size cannot exceed ${MAX_BYTE_SIZE} bytes`);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { tenant_id, persona_id, content_type, byte_size, encounter_id, ttl_seconds } };
}

export function validateRequestTranscode(body: unknown): ValidationResult<RequestTranscodeInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const pipeline = asString(b.pipeline) as TranscodePipeline;
  if (!VALID_PIPELINES.includes(pipeline)) {
    errors.push(`pipeline must be one of ${VALID_PIPELINES.join(', ')}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { pipeline } };
}

export function validateMarkReady(body: unknown): ValidationResult<{ checksum_hex: string }> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const checksum_hex = asString(b.checksum_hex);
  if (!checksum_hex || !/^[0-9a-fA-F]{64}$/.test(checksum_hex.replace(/^0x/, ''))) {
    return { ok: false, errors: ['checksum_hex must be a 64-char hex SHA-256'] };
  }
  return { ok: true, value: { checksum_hex } };
}
