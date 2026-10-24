-- File archive: the extension downloads Slack files with the browser's Slack session and uploads them here.
-- Bytes live in a pluggable object store (local disk or S3-compatible); PostgreSQL keeps the metadata.

-- One row per distinct file content. Several messages (or a file shared twice) point at the same blob.
CREATE TABLE file_blobs (
    sha256       text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
    mime_type    text,
    storage      text NOT NULL,                 -- driver that holds the bytes: local | s3
    storage_key  text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE message_files
    ADD COLUMN slack_file_id   text,             -- F0123ABCD; the same file is reported under different URLs (permalink, url_private, thumbnails)
    ADD COLUMN download_url    text,             -- files.slack.com URL of the original
    ADD COLUMN thumb_url       text,             -- files.slack.com URL of Slack's preview image (fallback when the original is too big)
    ADD COLUMN mime_type       text,
    ADD COLUMN size_bytes      bigint,           -- size as reported by Slack (unknown for DOM captures)
    ADD COLUMN status          text NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'stored', 'failed', 'skipped')),
    ADD COLUMN variant         text CHECK (variant IN ('original', 'preview')),
    ADD COLUMN blob_sha256     text REFERENCES file_blobs(sha256),
    ADD COLUMN attempts        int NOT NULL DEFAULT 0,
    ADD COLUMN last_error      text,
    ADD COLUMN next_attempt_at timestamptz,
    ADD COLUMN leased_by       uuid,             -- collector currently downloading it
    ADD COLUMN lease_until     timestamptz,
    ADD COLUMN stored_at       timestamptz,
    ADD COLUMN created_at      timestamptz NOT NULL DEFAULT now();

-- Backfill the Slack file id from the URLs captured so far.
UPDATE message_files SET slack_file_id = COALESCE(
    substring(url FROM '/files-(?:pri|tmb)/T[A-Z0-9]+-(F[A-Z0-9]+)'),
    substring(url FROM '/files/[A-Z0-9]+/(F[A-Z0-9]+)'));

-- The DOM and the real-time feed reported the same file under different URLs: keep one row per file.
DELETE FROM message_files f
USING message_files keep
WHERE f.slack_file_id IS NOT NULL
  AND keep.message_id = f.message_id AND keep.slack_file_id = f.slack_file_id AND keep.id < f.id;

-- Existing rows: originals on files.slack.com can be fetched; permalinks get a derived download URL;
-- anything else (external links, Google Drive, …) has nothing to download.
UPDATE message_files f SET download_url = CASE
    WHEN f.url ~ '^https://files\.slack\.com/files-pri/' THEN f.url
    WHEN f.slack_file_id IS NOT NULL AND f.url ~ '/files/[A-Z0-9]+/F[A-Z0-9]+/[^/?#]+' THEN
      'https://files.slack.com/files-pri/' || m.workspace_id || '-' || f.slack_file_id || '/' || substring(f.url FROM '/files/[A-Z0-9]+/F[A-Z0-9]+/([^/?#]+)')
  END
FROM messages m WHERE m.id = f.message_id;
UPDATE message_files SET status = 'skipped', last_error = 'no downloadable source'
WHERE download_url IS NULL AND thumb_url IS NULL;

CREATE UNIQUE INDEX message_files_message_file_uq ON message_files (message_id, slack_file_id) WHERE slack_file_id IS NOT NULL;
CREATE INDEX message_files_pending_idx ON message_files (next_attempt_at) WHERE status = 'pending';
CREATE INDEX message_files_slack_file_idx ON message_files (slack_file_id) WHERE slack_file_id IS NOT NULL;
CREATE INDEX message_files_blob_idx ON message_files (blob_sha256) WHERE blob_sha256 IS NOT NULL;
