import { createReadStream, openAsBlob } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { config } from '../config.js';
import { col } from '../db/mongo.js';

/** Inclusive byte range, as in an HTTP Range header. */
export interface ByteRange {
  start: number;
  end: number;
}

/** Where file bytes live. Content is addressed by sha256, so a blob is written once and never changes. */
export interface FileStore {
  readonly name: 'local' | 'gdrive';
  /** Moves a finished temp file into the store and returns the key to read it back. The temp file is gone afterwards. */
  put(sha256: string, tempPath: string, meta: { size: number; mimeType: string | null }): Promise<string>;
  get(key: string, range?: ByteRange): Promise<Readable>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

const missing = () => Object.assign(new Error('blob missing from storage'), { code: 'ENOENT' });

/** Spreads blobs over 65 536 folders: ab/cd/abcdef… */
const blobKey = (sha256: string) => `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;

class LocalStore implements FileStore {
  readonly name = 'local';
  constructor(private readonly root: string) {}

  private file(key: string) {
    const p = path.resolve(this.root, 'blobs', key);
    if (!p.startsWith(path.resolve(this.root, 'blobs') + path.sep)) throw new Error('invalid storage key');
    return p;
  }

  async put(sha256: string, tempPath: string) {
    const key = blobKey(sha256);
    const dest = this.file(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.rename(tempPath, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      // Temp dir on another volume: copy instead of rename.
      await fs.copyFile(tempPath, dest);
      await fs.rm(tempPath, { force: true });
    }
    return key;
  }

  async get(key: string, range?: ByteRange) {
    const p = this.file(key);
    await fs.access(p);
    return createReadStream(p, range);
  }

  async delete(key: string) {
    await fs.rm(this.file(key), { force: true });
  }
}

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_SETTING = 'gdrive_folder';

/**
 * A personal Google Drive (15 GB free), reached with an OAuth refresh token for the `drive.file` scope: the app
 * only sees files it created itself. Blobs go into one folder ("Slack Analyze files"); the storage key is the
 * Drive file id.
 */
class GoogleDriveStore implements FileStore {
  readonly name = 'gdrive';
  private token: { value: string; expires: number } | null = null;
  private folder: Promise<string> | null = null;

  constructor(private readonly cfg: typeof config.files.gdrive) {
    if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
      throw new Error('FILE_STORAGE=gdrive needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN (see README → Google Drive)');
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: this.cfg.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) {
      // invalid_grant: the refresh token was revoked, or expired because the OAuth app is still in "Testing".
      throw new Error(`Google sign-in failed: ${body.error ?? res.status} ${body.error_description ?? ''}`.trim());
    }
    this.token = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** Authorized Drive request; retries rate limits and server errors with back-off. `body` must be re-readable. */
  private async call(url: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await this.accessToken()}` },
    });
    if (res.status === 401 && attempt === 0) {
      this.token = null;
      return this.call(url, init, attempt + 1);
    }
    if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < 4) {
      const text = res.status === 403 ? await res.clone().text() : '';
      if (res.status !== 403 || /rateLimitExceeded|userRateLimitExceeded/.test(text)) {
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
        return this.call(url, init, attempt + 1);
      }
    }
    return res;
  }

  private async failed(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => '');
    throw new Error(`Google Drive ${what} failed: ${res.status} ${text.slice(0, 300)}`);
  }

  /** The folder holding the blobs: configured, remembered in the database, found by name, or created. */
  private folderId(): Promise<string> {
    this.folder ??= (async () => {
      if (this.cfg.folderId) return this.cfg.folderId;
      const saved = await col.settings.findOne({ _id: FOLDER_SETTING });
      if (typeof saved?.value === 'string') return saved.value;
      const q = `name = '${this.cfg.folderName.replace(/['\\]/g, '\\$&')}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
      const found = await this.call(`${DRIVE}/files?${new URLSearchParams({ q, fields: 'files(id)', spaces: 'drive', pageSize: '1' })}`);
      if (!found.ok) await this.failed(found, 'folder lookup');
      let id = ((await found.json()) as { files: { id: string }[] }).files[0]?.id;
      if (!id) {
        const made = await this.call(`${DRIVE}/files?fields=id`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: this.cfg.folderName, mimeType: FOLDER_MIME }),
        });
        if (!made.ok) await this.failed(made, 'folder create');
        id = ((await made.json()) as { id: string }).id;
      }
      await col.settings.updateOne({ _id: FOLDER_SETTING }, { $set: { value: id } }, { upsert: true });
      return id;
    })().catch((err) => {
      this.folder = null; // try again next time
      throw err;
    });
    return this.folder;
  }

  async put(sha256: string, tempPath: string, meta: { size: number; mimeType: string | null }) {
    try {
      const mimeType = meta.mimeType ?? 'application/octet-stream';
      // Resumable upload: one request for the metadata, one PUT streaming the bytes (files up to FILE_MAX_MB).
      const start = await this.call(`${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(meta.size),
        },
        body: JSON.stringify({ name: sha256, parents: [await this.folderId()], mimeType, appProperties: { sha256 } }),
      });
      if (!start.ok) await this.failed(start, 'upload start');
      const session = start.headers.get('location');
      if (!session) throw new Error('Google Drive upload start returned no session URL');
      // A file-backed Blob streams from disk and sets Content-Length.
      const put = await fetch(session, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: await openAsBlob(tempPath) });
      if (!put.ok) await this.failed(put, 'upload');
      return ((await put.json()) as { id: string }).id;
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }

  async get(key: string, range?: ByteRange) {
    const res = await this.call(`${DRIVE}/files/${encodeURIComponent(key)}?alt=media`, {
      headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {},
    });
    if (res.status === 404) throw missing();
    if (!res.ok || !res.body) await this.failed(res, 'download');
    return Readable.fromWeb(res.body as unknown as WebReadableStream);
  }

  async delete(key: string) {
    const res = await this.call(`${DRIVE}/files/${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) await this.failed(res, 'delete');
  }
}

/** Uploads stream here first (hashing as they go) before being moved into the store. */
export const tempDir = path.resolve(config.files.dir, 'tmp');

export const fileStore: FileStore = config.files.storage === 'local' ? new LocalStore(config.files.dir) : new GoogleDriveStore(config.files.gdrive);
