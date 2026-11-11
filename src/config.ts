import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Local development: read .env from the repo root when it exists. On Render the variables come from the dashboard.
try {
  process.loadEnvFile(path.resolve(here, '../.env'));
} catch {
  /* no .env file */
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  // MongoDB Atlas (free M0 cluster) connection string: mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/
  mongodbUri: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
  // Database name inside the cluster.
  mongodbDb: process.env.MONGODB_DB || 'slack_analyze',
  ingestApiKey: process.env.INGEST_API_KEY ?? '',
  // Set COOKIE_SECURE=true when the dashboard is served over HTTPS.
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  // lax on one site (local). none when the dashboard and API are different sites (Vercel + Render).
  cookieSameSite: process.env.COOKIE_SAMESITE === 'none' ? 'none' : 'lax',
  // Render and other reverse proxies. Needed so req.ip is the client, not the proxy.
  trustProxy: process.env.TRUST_PROXY === 'true',
  files: {
    // Where downloaded Slack files are kept: 'gdrive' (a personal Google Drive) or 'local' (disk, for development).
    storage: (process.env.FILE_STORAGE ?? 'gdrive') as 'gdrive' | 'local',
    // Local driver root; also holds in-flight uploads (tmp/) for both drivers.
    dir: process.env.FILE_STORAGE_DIR ?? path.resolve(here, '../data/files'),
    // Hard cap per upload; the extension's own limit can only be lower.
    maxBytes: Math.round(Number(process.env.FILE_MAX_MB ?? 100) * 1024 * 1024),
    gdrive: {
      // OAuth client of type "Desktop app" from Google Cloud Console; the refresh token comes from `npm run gdrive:auth`.
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      refreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? '',
      // Optional: a folder this app created earlier. Otherwise the folder below is created on first use.
      folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || null,
      folderName: process.env.GOOGLE_DRIVE_FOLDER_NAME || 'Slack Analyze files',
    },
  },
};
