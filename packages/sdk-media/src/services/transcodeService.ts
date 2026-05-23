import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import type {
  RequestTranscodeInput,
  TranscodeJobRecord,
  TranscodePipeline,
} from '../models/media.model';
import { BlobNotFoundError, TenantOwnershipError, getBlob } from './blobService';

/**
 * sdk-media transcoding pipeline per FR-MED-3.
 *
 * Two halves:
 *   - requestTranscode(): client/SDK caller path. Validates the source blob
 *     exists, enqueues a media.transcode_job row (status=queued).
 *   - runQueuedJobs(): worker tick. Pulls queued rows, runs the appropriate
 *     pipeline (video-mp4-hls / image-optimize / pdf-thumbnail), writes
 *     output blob rows, emits media.transcode.completed.v1.
 *
 * The actual codec work is plug-replaceable. Dev/test runs synthetic
 * "transcoded" markers (so chain logic is testable without ffmpeg-wasm).
 * Production swaps in ffmpeg-wasm in-process or fires off to a Lambda /
 * MediaConvert pipeline per pipeline kind.
 */

const POOL_INDEX = process.env.POOL_INDEX || 'admin';

const PIPELINE_BILLED_UNITS: Record<TranscodePipeline, { unit: 'mb' | 'min'; per: number }> = {
  'video-mp4-hls':   { unit: 'min', per: 1 },
  'image-optimize':  { unit: 'mb',  per: 1 },
  'pdf-thumbnail':   { unit: 'mb',  per: 1 },
};

export async function requestTranscode(
  blob_id: string,
  input: RequestTranscodeInput,
  actor_tenant_id?: string,
): Promise<TranscodeJobRecord> {
  const blob = await getBlob(blob_id);
  if (!blob) throw new BlobNotFoundError(blob_id);
  if (actor_tenant_id && blob.tenant_id !== actor_tenant_id) {
    throw new TenantOwnershipError(`requestTranscode: caller tenant ${actor_tenant_id} does not own blob ${blob_id}`);
  }
  if (blob.status === 'shredded') {
    throw new Error(`Blob ${blob_id} has been shredded; cannot transcode`);
  }
  const rows = await dataService.rows<TranscodeJobRecord>(
    `INSERT INTO media.transcode_job (blob_id, pipeline, status)
     VALUES ($1, $2, 'queued')
     RETURNING job_id, blob_id, pipeline, status, started_at, completed_at,
               output_blob_ids, billed_units, error_message`,
    [blob_id, input.pipeline],
  );
  return rows[0];
}

/**
 * Computes billed_units from blob size + pipeline kind. video-mp4-hls bills
 * per minute (approximated from byte_size + content_type bitrate hint);
 * image / pdf bill per MB.
 */
function computeBilledUnits(byte_size: number, pipeline: TranscodePipeline): number {
  const spec = PIPELINE_BILLED_UNITS[pipeline];
  if (spec.unit === 'mb') {
    return Math.max(0.01, byte_size / (1024 * 1024));
  }
  // Video minutes — synthetic 1Mbps assumption when codec metadata isn't available.
  const approxMb = byte_size / (1024 * 1024);
  return Math.max(0.01, approxMb / 7.5);
}

/**
 * Worker tick: pull the oldest N queued jobs, mark running, run the synthetic
 * pipeline, mark succeeded. Returns the count processed. Production swaps the
 * synthetic implementation for the real codec runner per pipeline.
 */
export async function runQueuedJobs(batch_size = 20): Promise<number> {
  const queued = await dataService.rows<{ job_id: string; blob_id: string; pipeline: TranscodePipeline }>(
    `UPDATE media.transcode_job
        SET status = 'running', started_at = now()
      WHERE job_id IN (
        SELECT job_id FROM media.transcode_job
         WHERE status = 'queued'
         ORDER BY job_id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING job_id, blob_id, pipeline`,
    [batch_size],
  );

  for (const job of queued) {
    try {
      const blob = await getBlob(job.blob_id);
      if (!blob) throw new BlobNotFoundError(job.blob_id);
      const billed_units = computeBilledUnits(blob.byte_size, job.pipeline);

      // Synthetic output: one variant per pipeline, output_blob_ids contains
      // the source blob_id as placeholder. Real codec impl inserts new
      // media.blob rows for each variant and updates parent blob.variants.
      const variantKey = job.pipeline.replace(/-/g, '_');
      await dataService.query(
        `UPDATE media.blob
            SET status = 'transcoded',
                variants = variants || jsonb_build_object($1::text, blob.s3_key || '.' || $1::text)
            FROM media.blob blob
          WHERE media.blob.blob_id = $2 AND blob.blob_id = $2`,
        [variantKey, job.blob_id],
      );

      await dataService.query(
        `UPDATE media.transcode_job
            SET status = 'succeeded', completed_at = now(),
                output_blob_ids = ARRAY[$2]::text[], billed_units = $3
          WHERE job_id = $1`,
        [job.job_id, job.blob_id, billed_units],
      );

      await emitEvent({
        event_type: 'media.transcode.completed.v1',
        payload: {
          job_id: job.job_id,
          blob_id: job.blob_id,
          pipeline: job.pipeline,
          billed_units,
        },
        pool_index: POOL_INDEX,
        actor_kind: 'service',
        actor_id: 'sdk-media.transcodeWorker',
        tenant_id: blob.tenant_id,
        subject_kind: 'media.blob',
        subject_id: job.blob_id,
      });
    } catch (err) {
      await dataService.query(
        `UPDATE media.transcode_job
            SET status = 'failed', completed_at = now(), error_message = $2
          WHERE job_id = $1`,
        [job.job_id, (err as Error).message.slice(0, 500)],
      );
    }
  }
  return queued.length;
}

/**
 * Background scheduler that drains queued transcode jobs. Returns a handle
 * with stop() that clears the interval. Wired into api-gateway startup.
 */
export function startTranscodeWorker(opts: {
  enabled?: boolean;
  intervalMs?: number;
  batchSize?: number;
} = {}): { stop: () => void } {
  const enabled = opts.enabled !== false;
  const intervalMs = opts.intervalMs ?? 15_000;
  const batchSize = opts.batchSize ?? 20;
  if (!enabled) return { stop: () => undefined };

  const timer = setInterval(async () => {
    try {
      await runQueuedJobs(batchSize);
    } catch (err) {
      console.warn('[media.transcodeWorker] tick failed:', (err as Error).message);
    }
  }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  return { stop: () => clearInterval(timer) };
}

export async function getTranscodeJob(job_id: string): Promise<TranscodeJobRecord | null> {
  return dataService.one<TranscodeJobRecord>(
    `SELECT job_id, blob_id, pipeline, status, started_at, completed_at,
            output_blob_ids, billed_units, error_message
       FROM media.transcode_job WHERE job_id = $1`,
    [job_id],
  );
}
