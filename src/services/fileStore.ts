import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config.js';

/** Inclusive byte range, as in an HTTP Range header. */
export interface ByteRange {
  start: number;
  end: number;
}

/** Where file bytes live. Keys are content-addressed (sha256), so a key is written once and never changes. */
export interface FileStore {
  readonly name: 'local' | 's3';
  /** Moves a finished temp file into the store. The temp file is gone afterwards. */
  put(key: string, tempPath: string, meta: { size: number; mimeType: string | null }): Promise<void>;
  get(key: string, range?: ByteRange): Promise<Readable>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

/** Spreads blobs over 65 536 folders: ab/cd/abcdef… */
export const blobKey = (sha256: string) => `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;

class LocalStore implements FileStore {
  readonly name = 'local';
  constructor(private readonly root: string) {}

  private file(key: string) {
    const p = path.resolve(this.root, 'blobs', key);
    if (!p.startsWith(path.resolve(this.root, 'blobs') + path.sep)) throw new Error('invalid storage key');
    return p;
  }

  async put(key: string, tempPath: string) {
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

class S3Store implements FileStore {
  readonly name = 's3';
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(cfg: typeof config.files.s3) {
    if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
      throw new Error('FILE_STORAGE=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
    }
    this.bucket = cfg.bucket;
    this.prefix = cfg.prefix && !cfg.prefix.endsWith('/') ? `${cfg.prefix}/` : cfg.prefix;
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // R2 rejects the default flexible checksums the AWS SDK now sends on every upload.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async put(key: string, tempPath: string, meta: { size: number; mimeType: string | null }) {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.prefix + key,
          Body: createReadStream(tempPath),
          ContentLength: meta.size,
          ContentType: meta.mimeType ?? 'application/octet-stream',
        }),
      );
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }

  async get(key: string, range?: ByteRange) {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.prefix + key,
          Range: range ? `bytes=${range.start}-${range.end}` : undefined,
        }),
      );
      return res.Body as Readable;
    } catch (err) {
      if (err instanceof NoSuchKey) throw Object.assign(new Error('blob missing from storage'), { code: 'ENOENT' });
      throw err;
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }));
  }
}

/** Uploads stream here first (hashing as they go) before being moved into the store. */
export const tempDir = path.resolve(config.files.dir, 'tmp');

export const fileStore: FileStore = config.files.storage === 's3' ? new S3Store(config.files.s3) : new LocalStore(config.files.dir);
