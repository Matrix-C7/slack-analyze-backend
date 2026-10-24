import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type pg from 'pg';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import type { FileInput } from '../schemas.js';
import { blobKey, fileStore, tempDir } from './fileStore.js';

/** A collector holds a claimed file this long before another browser may take it over. */
const LEASE = `interval '10 minutes'`;
/** After this many failed downloads a file is marked failed (an admin can retry it). */
export const MAX_ATTEMPTS = 6;
/** Blobs nobody references are kept this long before cleanup, so an upload in flight is never collected. */
const ORPHAN_GRACE = `interval '1 hour'`;

export const FILE_KINDS = ['image', 'video', 'pdf', 'doc', 'other'] as const;

const SLACK_FILE_ID = /(?:\/files-(?:pri|tmb)\/T[A-Z0-9]+-|\/files\/[A-Z0-9]+\/)(F[A-Z0-9]{6,})/;
const PERMALINK = /^https:\/\/[a-z0-9.-]+\.slack\.com\/files\/[A-Z0-9]+\/(F[A-Z0-9]+)\/([^/?#]+)/;

/** The extension fetches these with the user's Slack cookies, so only Slack's own file host is ever handed out. */
function slackFileUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname === 'files.slack.com' ? url.toString() : null;
  } catch {
    return null;
  }
}

interface NormalizedFile {
  name: string | null;
  url: string;
  kind: string;
  slackFileId: string | null;
  downloadUrl: string | null;
  /** downloadUrl came from Slack itself (real-time feed), not derived from a permalink. */
  explicitDownload: boolean;
  thumbUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

function normalize(workspaceId: string, f: FileInput): NormalizedFile {
  const slackFileId = f.slackFileId ?? f.url.match(SLACK_FILE_ID)?.[1] ?? null;
  let downloadUrl = slackFileUrl(f.downloadUrl);
  const explicitDownload = Boolean(downloadUrl);
  if (!downloadUrl && /^https:\/\/files\.slack\.com\/files-pri\//.test(f.url)) downloadUrl = slackFileUrl(f.url);
  if (!downloadUrl) {
    // https://team.slack.com/files/U…/F…/name.png is a web page; the file itself is files-pri/T…-F…/name.png.
    const p = f.url.match(PERMALINK);
    if (p) downloadUrl = `https://files.slack.com/files-pri/${workspaceId}-${p[1]}/${p[2]}`;
  }
  return {
    name: f.name ?? null,
    url: f.url,
    kind: f.kind ?? 'other',
    slackFileId,
    downloadUrl,
    explicitDownload,
    thumbUrl: slackFileUrl(f.thumbUrl),
    mimeType: f.mimeType ?? null,
    sizeBytes: f.size ?? null,
  };
}

/**
 * Records one file of a message. The same file arrives from the DOM (permalink, preview image) and from the
 * real-time feed (url_private, size, type), so rows are matched on the Slack file id and merged.
 * Returns true when the file still needs downloading.
 */
export async function upsertMessageFile(db: pg.PoolClient, workspaceId: string, messageId: number, input: FileInput): Promise<boolean> {
  const f = normalize(workspaceId, input);
  const hasSource = Boolean(f.downloadUrl || f.thumbUrl);
  const { rows: found } = await db.query<{ id: number }>(
    `SELECT id FROM message_files
     WHERE message_id = $1 AND (slack_file_id = $2 OR url = $3)
     ORDER BY (slack_file_id = $2) DESC NULLS LAST, id LIMIT 1`,
    [messageId, f.slackFileId, f.url],
  );

  let row: { id: number; status: string; slack_file_id: string | null };
  if (found[0]) {
    const { rows } = await db.query(
      `UPDATE message_files SET
         name          = COALESCE($2, name),
         slack_file_id = COALESCE(slack_file_id, $3),
         download_url  = CASE WHEN $4::boolean THEN $5 ELSE COALESCE(download_url, $5) END,
         thumb_url     = COALESCE($6, thumb_url),
         mime_type     = COALESCE($7, mime_type),
         size_bytes    = COALESCE($8, size_bytes),
         kind          = CASE WHEN kind IS NULL OR kind = 'other' THEN $9 ELSE kind END,
         -- A richer capture can make a skipped file downloadable, or give a failed one a better URL.
         status        = CASE WHEN status = 'skipped' AND $10::boolean THEN 'pending'
                              WHEN status = 'failed' AND $4::boolean AND download_url IS DISTINCT FROM $5 THEN 'pending'
                              ELSE status END,
         attempts      = CASE WHEN status IN ('skipped', 'failed') AND $10::boolean THEN 0 ELSE attempts END
       WHERE id = $1
       RETURNING id, status, slack_file_id`,
      [found[0].id, f.name, f.slackFileId, f.explicitDownload, f.downloadUrl, f.thumbUrl, f.mimeType, f.sizeBytes, f.kind, hasSource],
    );
    row = rows[0];
  } else {
    const { rows } = await db.query(
      `INSERT INTO message_files (message_id, name, url, kind, slack_file_id, download_url, thumb_url, mime_type, size_bytes, status, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, status, slack_file_id`,
      [
        messageId, f.name, f.url, f.kind, f.slackFileId, f.downloadUrl, f.thumbUrl, f.mimeType, f.sizeBytes,
        hasSource ? 'pending' : 'skipped',
        hasSource ? null : 'no downloadable source',
      ],
    );
    row = rows[0];
  }
  if (row.status !== 'pending') return false;

  // Already archived from another message (same file shared twice, or edited message): reuse the blob.
  if (row.slack_file_id) {
    const { rowCount } = await db.query(
      `UPDATE message_files f SET status = 'stored', blob_sha256 = s.blob_sha256, variant = s.variant, stored_at = now(),
              last_error = NULL, leased_by = NULL, lease_until = NULL
       FROM (SELECT o.blob_sha256, o.variant FROM message_files o JOIN messages om ON om.id = o.message_id
             WHERE o.slack_file_id = $2 AND om.workspace_id = $3 AND o.status = 'stored'
             ORDER BY (o.variant = 'original') DESC LIMIT 1) s
       WHERE f.id = $1`,
      [row.id, row.slack_file_id, workspaceId],
    );
    if (rowCount) return false;
  }
  return true;
}

export interface ClaimedFile {
  id: number;
  name: string | null;
  kind: string;
  downloadUrl: string | null;
  thumbUrl: string | null;
  mimeType: string | null;
  size: number | null;
}

/**
 * Hands a browser the next files to download, newest messages first, and leases them so no other browser
 * downloads the same file meanwhile. Only conversations that browser's Slack account is in are offered:
 * the download uses that account's Slack session.
 */
export async function claimFiles(opts: {
  workspaceId: string;
  collectorId: string;
  accountUserId: string | null;
  kinds: string[];
  maxBytes: number;
  limit: number;
}): Promise<ClaimedFile[]> {
  const { rows } = await pool.query(
    `WITH picked AS (
       SELECT f.id, m.sent_at FROM message_files f
       JOIN messages m ON m.id = f.message_id
       JOIN channels c ON c.workspace_id = m.workspace_id AND c.id = m.channel_id
       WHERE m.workspace_id = $1 AND f.status = 'pending'
         AND (f.next_attempt_at IS NULL OR f.next_attempt_at <= now())
         AND (f.lease_until IS NULL OR f.lease_until < now())
         AND COALESCE(f.kind, 'other') = ANY($4::text[])
         AND (f.size_bytes IS NULL OR f.size_bytes <= $5 OR f.thumb_url IS NOT NULL)
         AND NOT c.capture_excluded
         AND ($3::text IS NULL OR EXISTS (
               SELECT 1 FROM channel_accounts ca
               WHERE ca.workspace_id = m.workspace_id AND ca.channel_id = m.channel_id AND ca.account_user_id = $3))
       ORDER BY m.sent_at DESC
       LIMIT $6
       FOR UPDATE OF f SKIP LOCKED)
     UPDATE message_files f SET leased_by = $2, lease_until = now() + ${LEASE}
     FROM picked WHERE f.id = picked.id
     RETURNING f.id, f.name, f.kind, f.download_url, f.thumb_url, f.mime_type, f.size_bytes, picked.sent_at`,
    [opts.workspaceId, opts.collectorId, opts.accountUserId, opts.kinds, opts.maxBytes, opts.limit],
  );
  // UPDATE … RETURNING does not keep the CTE's order.
  rows.sort((a, b) => b.sent_at - a.sent_at);
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    kind: r.kind ?? 'other',
    downloadUrl: r.download_url,
    thumbUrl: r.thumb_url,
    mimeType: r.mime_type,
    size: r.size_bytes,
  }));
}

export class UploadError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Streams to a temp file while hashing; rejects bodies over the limit without buffering them. */
async function spool(body: Readable): Promise<{ tempPath: string; sha256: string; size: number; head: Buffer }> {
  await fs.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `${crypto.randomUUID()}.part`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  let head = Buffer.alloc(0);
  try {
    await pipeline(
      body,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > config.files.maxBytes) throw new UploadError(413, `file is larger than the ${Math.round(config.files.maxBytes / 1048576)} MB limit`);
          if (head.length < 512) head = Buffer.concat([head, chunk.subarray(0, 512 - head.length)]);
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(tempPath),
    );
  } catch (err) {
    await fs.rm(tempPath, { force: true });
    throw err;
  }
  return { tempPath, sha256: hash.digest('hex'), size, head };
}

/** A failed download often returns Slack's sign-in page with status 200 instead of the file. */
function looksLikeHtmlPage(head: Buffer, f: { name: string | null; mime_type: string | null }): boolean {
  if (/html/i.test(f.mime_type ?? '') || /\.html?$/i.test(f.name ?? '')) return false;
  return /^\s*(<!doctype html|<html)/i.test(head.toString('utf8'));
}

/**
 * Stores an uploaded file and marks it — and every other message sharing the same Slack file — as stored.
 * Identical bytes are kept once.
 */
export async function storeUpload(
  fileId: number,
  body: Readable,
  opts: { variant: 'original' | 'preview'; mimeType: string | null },
): Promise<{ sha256: string; size: number; deduplicated: boolean; alreadyStored: boolean }> {
  const { rows } = await pool.query(
    `SELECT f.id, f.name, f.mime_type, f.status, f.slack_file_id, f.blob_sha256, m.workspace_id
     FROM message_files f JOIN messages m ON m.id = f.message_id WHERE f.id = $1`,
    [fileId],
  );
  const f = rows[0];
  if (!f) {
    body.resume();
    throw new UploadError(404, 'file not found (message deleted?)');
  }
  if (f.status === 'stored') {
    body.resume();
    return { sha256: f.blob_sha256, size: 0, deduplicated: true, alreadyStored: true };
  }

  const { tempPath, sha256, size, head } = await spool(body);
  let deduplicated = false;
  try {
    if (size === 0) throw new UploadError(422, 'empty file');
    if (looksLikeHtmlPage(head, f)) throw new UploadError(422, 'received an HTML page instead of the file (Slack session expired?)');
    const mimeType = opts.mimeType || f.mime_type || null;

    const { rowCount: exists } = await pool.query('SELECT 1 FROM file_blobs WHERE sha256 = $1', [sha256]);
    if (exists) {
      deduplicated = true;
      await fs.rm(tempPath, { force: true });
    } else {
      const key = blobKey(sha256);
      await fileStore.put(key, tempPath, { size, mimeType });
      await pool.query(
        `INSERT INTO file_blobs (sha256, size_bytes, mime_type, storage, storage_key) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (sha256) DO NOTHING`,
        [sha256, size, mimeType, fileStore.name, key],
      );
    }
    // A preview never replaces an archived original.
    await pool.query(
      `UPDATE message_files f SET status = 'stored', blob_sha256 = $2, variant = $3, stored_at = now(),
              mime_type = COALESCE(f.mime_type, $4), last_error = NULL, leased_by = NULL, lease_until = NULL, next_attempt_at = NULL
       FROM messages m
       WHERE m.id = f.message_id
         AND (f.id = $1 OR ($5::text IS NOT NULL AND f.slack_file_id = $5 AND m.workspace_id = $6))
         AND (f.status <> 'stored' OR (f.variant = 'preview' AND $3 = 'original'))`,
      [fileId, sha256, opts.variant, mimeType, f.slack_file_id, f.workspace_id],
    );
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
  return { sha256, size, deduplicated, alreadyStored: false };
}

/**
 * A browser could not download a file. Retryable errors back off (2, 4, 8 … minutes, at most 12 h) until
 * MAX_ATTEMPTS; `skip` marks files deliberately not archived (too large, type turned off).
 */
export async function reportFileFailure(fileId: number, opts: { error: string; retryable: boolean; skip: boolean }): Promise<string | null> {
  const { rows } = await pool.query<{ status: string }>(
    `UPDATE message_files SET
       attempts        = attempts + CASE WHEN $4 THEN 0 ELSE 1 END,
       last_error      = $2,
       leased_by       = NULL,
       lease_until     = NULL,
       status          = CASE WHEN $4 THEN 'skipped'
                              WHEN NOT $3 OR attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed'
                              ELSE 'pending' END,
       next_attempt_at = now() + make_interval(mins => LEAST(power(2, attempts + 1), 720)::int)
     WHERE id = $1 AND status = 'pending'
     RETURNING status`,
    [fileId, opts.error.slice(0, 1000), opts.retryable, opts.skip],
  );
  return rows[0]?.status ?? null;
}

/** Deletes blobs no message refers to any more (messages deleted, purged or expired by retention). */
export async function collectOrphanBlobs(log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }) {
  const { rows } = await pool.query<{ sha256: string; storage: string; storage_key: string }>(
    `SELECT b.sha256, b.storage, b.storage_key FROM file_blobs b
     WHERE b.created_at < now() - ${ORPHAN_GRACE}
       AND NOT EXISTS (SELECT 1 FROM message_files f WHERE f.blob_sha256 = b.sha256)
     LIMIT 500`,
  );
  let removed = 0;
  for (const b of rows) {
    if (b.storage !== fileStore.name) continue; // written under another driver: leave it to that configuration
    try {
      await fileStore.delete(b.storage_key);
      await pool.query(
        'DELETE FROM file_blobs b WHERE sha256 = $1 AND NOT EXISTS (SELECT 1 FROM message_files f WHERE f.blob_sha256 = b.sha256)',
        [b.sha256],
      );
      removed++;
    } catch (err) {
      log.warn({ err, sha256: b.sha256 }, 'deleting orphaned file failed');
    }
  }
  if (removed) log.info({ removed }, 'deleted orphaned files');
  // Uploads interrupted mid-stream leave .part files behind.
  const cutoff = Date.now() - 6 * 3600_000;
  for (const name of await fs.readdir(tempDir).catch(() => [] as string[])) {
    const p = path.join(tempDir, name);
    const st = await fs.stat(p).catch(() => null);
    if (st && st.mtimeMs < cutoff) await fs.rm(p, { force: true });
  }
}
