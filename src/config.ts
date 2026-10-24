import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Neon (and any other hosted Postgres) requires TLS. Local URLs stay unchanged. */
function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? 'postgres://slack:change-me@localhost:5433/slack_analyze';
  if (process.env.DATABASE_SSL !== 'true' || /[?&]sslmode=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}sslmode=require`;
}

/** migrations/ at the repo root, next to src/ and dist/. */
function migrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? path.resolve(here, '../migrations');
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: databaseUrl(),
  ingestApiKey: process.env.INGEST_API_KEY ?? '',
  // Set COOKIE_SECURE=true when the dashboard is served over HTTPS.
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  // lax on one site (local). none when the dashboard and API are different sites (Vercel + Render).
  cookieSameSite: process.env.COOKIE_SAMESITE === 'none' ? 'none' : 'lax',
  // Render and other reverse proxies. Needed so req.ip is the client, not the proxy.
  trustProxy: process.env.TRUST_PROXY === 'true',
  migrationsDir: migrationsDir(),
  files: {
    // Where downloaded Slack files are kept: 'local' (disk) or 's3' (any S3-compatible bucket: R2, B2, MinIO, AWS).
    storage: (process.env.FILE_STORAGE ?? 'local') as 'local' | 's3',
    // Local driver root; also holds in-flight uploads (tmp/) for both drivers.
    dir: process.env.FILE_STORAGE_DIR ?? path.resolve(here, '../data/files'),
    // Hard cap per upload; the extension's own limit can only be lower.
    maxBytes: Math.round(Number(process.env.FILE_MAX_MB ?? 100) * 1024 * 1024),
    s3: {
      bucket: process.env.S3_BUCKET ?? '',
      region: process.env.S3_REGION ?? 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined, // e.g. https://<account>.r2.cloudflarestorage.com
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true', // MinIO and most self-hosted stores
      prefix: (process.env.S3_PREFIX ?? 'slack-files/').replace(/^\/+/, ''),
    },
  },
};
