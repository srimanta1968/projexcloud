/**
 * TypeScript model mirroring media.* tables per P4-Operational-Billing-DataModel §4.
 */

export type BlobStatus = 'uploading' | 'ready' | 'transcoded' | 'shredded';
export type SignedUrlKind = 'upload' | 'download';
export type TranscodePipeline = 'video-mp4-hls' | 'image-optimize' | 'pdf-thumbnail';
export type TranscodeStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface BlobRecord {
  blob_id: string;
  tenant_id: string;
  encounter_id: string | null;
  persona_id: string;
  s3_key: string;
  content_type: string;
  byte_size: number;
  vault_key_ref: string;
  checksum: Buffer;
  variants: Record<string, string>;
  uploaded_at: Date;
  status: BlobStatus;
}

export interface SignedUrlRecord {
  url_id: string;
  blob_id: string;
  kind: SignedUrlKind;
  persona_id: string;
  expires_at: Date;
  issued_at: Date;
}

export interface TranscodeJobRecord {
  job_id: string;
  blob_id: string;
  pipeline: TranscodePipeline;
  status: TranscodeStatus;
  started_at: Date | null;
  completed_at: Date | null;
  output_blob_ids: string[];
  billed_units: number;
  error_message: string | null;
}

export interface IssueUploadUrlInput {
  tenant_id: string;
  persona_id: string;
  encounter_id?: string;
  content_type: string;
  byte_size: number;
  /** TTL in seconds; capped to 3600 (1h) for upload URLs per FR-MED-4 NFR. */
  ttl_seconds?: number;
}

export interface IssueUploadUrlResult {
  blob_id: string;
  url_id: string;
  upload_url: string;
  expires_at: Date;
  s3_key: string;
}

export interface IssuePlaybackUrlResult {
  url_id: string;
  playback_url: string;
  expires_at: Date;
}

export interface RequestTranscodeInput {
  pipeline: TranscodePipeline;
}
