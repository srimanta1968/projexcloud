-- Migration 002: P5 HDK editor extensions per P5 DataModel §12.2.
-- Additive — adds two columns the hdk-image-editor + hdk-video-editor
-- packages need to persist edit ops + reference raw originals.
--
-- edit_history: append-only sequence of edit ops sourced from hdk-sync
--   replay. CRDT event-sourcing policy on hdk-image.edit.applied.v1 /
--   hdk-video.trim.applied.v1 means appends are deterministic and order-
--   independent across reconnecting devices.
--
-- raw_blob_id: when this row is an edited variant, points to the raw
--   original (which is never overwritten). The FK is self-referencing
--   with ON DELETE RESTRICT so the raw can't be deleted while variants
--   reference it.

ALTER TABLE media.blob ADD COLUMN IF NOT EXISTS edit_history JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE media.blob ADD COLUMN IF NOT EXISTS raw_blob_id  UUID;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blob_raw_fk') THEN
    ALTER TABLE media.blob ADD CONSTRAINT blob_raw_fk
      FOREIGN KEY (raw_blob_id) REFERENCES media.blob(blob_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS blob_raw_idx ON media.blob (raw_blob_id) WHERE raw_blob_id IS NOT NULL;

COMMENT ON COLUMN media.blob.edit_history IS 'P5: append-only edit op sequence from hdk-sync replay (hdk-image.edit.applied.v1 / hdk-video.trim.applied.v1).';
COMMENT ON COLUMN media.blob.raw_blob_id  IS 'P5: edited-variant pointer to raw original. ON DELETE RESTRICT — raw cannot be removed while variants reference it.';
