import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Document } from 'mongodb';
import { config } from '../config.js';
import { col, nextId } from '../db/mongo.js';
import type { FileInput } from '../schemas.js';
import { fileStore, tempDir } from './fileStore.js';

/** A collector holds a claimed file this long before another browser may take it over. */
const LEASE_MS = 10 * 60_000;
/** After this many failed downloads a file is marked failed (an admin can retry it). */
export const MAX_ATTEMPTS = 6;
/** Blobs nobody references are kept this long before cleanup, so an upload in flight is never collected. */
const ORPHAN_GRACE_MS = 3600_000;

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
 * Workspace, channel and the message's time are copied onto the file so the download queue needs no join.
 * Returns true when the file still needs downloading.
 */
export async function upsertMessageFile(
  msg: { workspaceId: string; channelId: string; messageId: number; sentAt: Date },
  input: FileInput,
): Promise<boolean> {
  const f = normalize(msg.workspaceId, input);
  const hasSource = Boolean(f.downloadUrl || f.thumbUrl);
  const candidates = await col.messageFiles
    .find({ message_id: msg.messageId, $or: [...(f.slackFileId ? [{ slack_file_id: f.slackFileId }] : []), { url: f.url }] })
    .sort({ id: 1 })
    .toArray();
  const found = candidates.find((c) => f.slackFileId && c.slack_file_id === f.slackFileId) ?? candidates[0];

  let row: Document;
  if (found) {
    const downloadUrl = f.explicitDownload ? f.downloadUrl : (found.download_url ?? f.downloadUrl);
    let status = found.status;
    let attempts = found.attempts ?? 0;
    // A richer capture can make a skipped file downloadable, or give a failed one a better URL.
    if (status === 'skipped' && hasSource) status = 'pending';
    else if (status === 'failed' && f.explicitDownload && found.download_url !== f.downloadUrl) status = 'pending';
    if ((found.status === 'skipped' || found.status === 'failed') && hasSource) attempts = 0;
    const set = {
      name: f.name ?? found.name ?? null,
      slack_file_id: found.slack_file_id ?? f.slackFileId,
      download_url: downloadUrl,
      thumb_url: f.thumbUrl ?? found.thumb_url ?? null,
      mime_type: f.mimeType ?? found.mime_type ?? null,
      size_bytes: f.sizeBytes ?? found.size_bytes ?? null,
      kind: !found.kind || found.kind === 'other' ? f.kind : found.kind,
      status,
      attempts,
    };
    await col.messageFiles.updateOne({ id: found.id }, { $set: set });
    row = { ...found, ...set };
  } else {
    row = {
      id: await nextId('message_files'),
      message_id: msg.messageId,
      workspace_id: msg.workspaceId,
      channel_id: msg.channelId,
      sent_at: msg.sentAt,
      name: f.name,
      url: f.url,
      kind: f.kind,
      slack_file_id: f.slackFileId,
      download_url: f.downloadUrl,
      thumb_url: f.thumbUrl,
      mime_type: f.mimeType,
      size_bytes: f.sizeBytes,
      status: hasSource ? 'pending' : 'skipped',
      variant: null,
      blob_sha256: null,
      attempts: 0,
      last_error: hasSource ? null : 'no downloadable source',
      next_attempt_at: null,
      leased_by: null,
      lease_until: null,
      stored_at: null,
      created_at: new Date(),
    };
    await col.messageFiles.insertOne(row);
  }
  if (row.status !== 'pending') return false;

  // Already archived from another message (same file shared twice, or edited message): reuse the blob.
  if (row.slack_file_id) {
    const [src] = await col.messageFiles
      .aggregate([
        { $match: { workspace_id: msg.workspaceId, slack_file_id: row.slack_file_id, status: 'stored' } },
        { $addFields: { _orig: { $cond: [{ $eq: ['$variant', 'original'] }, 0, 1] } } },
        { $sort: { _orig: 1 } },
        { $limit: 1 },
      ])
      .toArray();
    if (src) {
      await col.messageFiles.updateOne(
        { id: row.id },
        { $set: { status: 'stored', blob_sha256: src.blob_sha256, variant: src.variant, stored_at: new Date(), last_error: null, leased_by: null, lease_until: null } },
      );
      return false;
    }
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
  const now = new Date();
  const [excluded, linked] = await Promise.all([
    col.channels.distinct('id', { workspace_id: opts.workspaceId, capture_excluded: true }),
    opts.accountUserId ? col.channelAccounts.distinct('channel_id', { workspace_id: opts.workspaceId, account_user_id: opts.accountUserId }) : null,
  ]);
  const claimable = {
    status: 'pending',
    $and: [
      { $or: [{ next_attempt_at: null }, { next_attempt_at: { $lte: now } }] },
      { $or: [{ lease_until: null }, { lease_until: { $lt: now } }] },
    ],
  };
  // A missing kind counts as 'other'.
  const kindFilter = opts.kinds.includes('other') ? { $or: [{ kind: { $in: opts.kinds } }, { kind: null }] } : { kind: { $in: opts.kinds } };
  const channelFilter: Document = linked ? { channel_id: { $in: linked.filter((id) => !excluded.includes(id)) } } : { channel_id: { $nin: excluded } };
  const candidates = await col.messageFiles
    .find({
      workspace_id: opts.workspaceId,
      ...channelFilter,
      status: 'pending',
      $and: [
        ...claimable.$and,
        kindFilter,
        // Too big for the original and no preview to fall back to: nothing this browser could fetch.
        { $nor: [{ size_bytes: { $gt: opts.maxBytes }, thumb_url: null }] },
      ],
    })
    .sort({ sent_at: -1 })
    .limit(opts.limit * 4)
    .toArray();

  // Lease one by one: a file another browser took a moment ago is simply skipped (like SKIP LOCKED).
  const out: ClaimedFile[] = [];
  for (const c of candidates) {
    if (out.length >= opts.limit) break;
    const leased = await col.messageFiles.findOneAndUpdate(
      { id: c.id, ...claimable },
      { $set: { leased_by: opts.collectorId, lease_until: new Date(Date.now() + LEASE_MS) } },
      { returnDocument: 'after' },
    );
    if (!leased) continue;
    out.push({
      id: leased.id,
      name: leased.name ?? null,
      kind: leased.kind ?? 'other',
      downloadUrl: leased.download_url ?? null,
      thumbUrl: leased.thumb_url ?? null,
      mimeType: leased.mime_type ?? null,
      size: leased.size_bytes ?? null,
    });
  }
  return out;
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
function looksLikeHtmlPage(head: Buffer, f: { name?: string | null; mime_type?: string | null }): boolean {
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
  const f = await col.messageFiles.findOne({ id: fileId });
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
    if (looksLikeHtmlPage(head, { name: f.name, mime_type: f.mime_type })) throw new UploadError(422, 'received an HTML page instead of the file (Slack session expired?)');
    const mimeType = opts.mimeType || f.mime_type || null;

    if (await col.fileBlobs.findOne({ sha256 }, { projection: { _id: 1 } })) {
      deduplicated = true;
      await fs.rm(tempPath, { force: true });
    } else {
      const key = await fileStore.put(sha256, tempPath, { size, mimeType });
      const res = await col.fileBlobs.updateOne(
        { sha256 },
        { $setOnInsert: { sha256, size_bytes: size, mime_type: mimeType, storage: fileStore.name, storage_key: key, created_at: new Date() } },
        { upsert: true },
      );
      // Two browsers uploaded the same bytes at once: keep the first copy.
      if (!res.upsertedCount && fileStore.name === 'gdrive') await fileStore.delete(key).catch(() => {});
    }
    // A preview never replaces an archived original.
    const sameFile = f.slack_file_id ? [{ workspace_id: f.workspace_id, slack_file_id: f.slack_file_id }] : [];
    await col.messageFiles.updateMany(
      {
        $and: [
          { $or: [{ id: fileId }, ...sameFile] },
          { $or: [{ status: { $ne: 'stored' } }, ...(opts.variant === 'original' ? [{ variant: 'preview' }] : [])] },
        ],
      },
      [
        {
          $set: {
            status: 'stored',
            blob_sha256: sha256,
            variant: opts.variant,
            stored_at: '$$NOW',
            mime_type: { $ifNull: ['$mime_type', { $literal: mimeType }] },
            last_error: null,
            leased_by: null,
            lease_until: null,
            next_attempt_at: null,
          },
        },
      ],
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
  const next = { $add: ['$attempts', 1] };
  const doc = await col.messageFiles.findOneAndUpdate(
    { id: fileId, status: 'pending' },
    [
      {
        $set: {
          attempts: opts.skip ? '$attempts' : next,
          last_error: { $literal: opts.error.slice(0, 1000) },
          leased_by: null,
          lease_until: null,
          status: opts.skip
            ? 'skipped'
            : { $cond: [{ $or: [{ $literal: !opts.retryable }, { $gte: [next, MAX_ATTEMPTS] }] }, 'failed', 'pending'] },
          next_attempt_at: { $add: ['$$NOW', { $multiply: [{ $min: [{ $pow: [2, next] }, 720] }, 60_000] }] },
        },
      },
    ],
    { returnDocument: 'after' },
  );
  return doc?.status ?? null;
}

/** Deletes blobs no message refers to any more (messages deleted, purged or expired by retention). */
export async function collectOrphanBlobs(log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }) {
  const old = await col.fileBlobs
    .find({ created_at: { $lt: new Date(Date.now() - ORPHAN_GRACE_MS) } }, { projection: { sha256: 1, storage: 1, storage_key: 1 } })
    .toArray();
  const used = new Set(await col.messageFiles.distinct('blob_sha256', { blob_sha256: { $in: old.map((b) => b.sha256) } }));
  let removed = 0;
  for (const b of old.filter((x) => !used.has(x.sha256)).slice(0, 500)) {
    if (b.storage !== fileStore.name) continue; // written under another driver: leave it to that configuration
    try {
      // Re-check right before deleting: a new message may have picked the blob up meanwhile.
      if (await col.messageFiles.findOne({ blob_sha256: b.sha256 }, { projection: { _id: 1 } })) continue;
      await fileStore.delete(b.storage_key);
      await col.fileBlobs.deleteOne({ sha256: b.sha256 });
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
