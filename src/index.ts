import cors from '@fastify/cors';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { pool } from './db/pool.js';
import { adminRoutes } from './routes/admin.js';
import { analyticsRoutes } from './routes/analytics.js';
import { authRoutes } from './routes/auth.js';
import { fileRoutes } from './routes/files.js';
import { ingestRoutes } from './routes/ingest.js';
import { readRoutes } from './routes/read.js';
import { searchRoutes } from './routes/search.js';
import { streamRoutes } from './routes/stream.js';
import { fileStore } from './services/fileStore.js';
import { collectOrphanBlobs } from './services/files.js';

const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024, trustProxy: config.trustProxy });

// The extension (chrome-extension://…) and the frontend both call this API.
// credentials: the dashboard sends its session cookie cross-port (localhost:3000 -> :4000).
await app.register(cors, { origin: true, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: 'validation failed', issues: err.issues });
  }
  app.log.error(err);
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  return reply.code(status).send({ error: status === 500 ? 'internal error' : (err as Error).message });
});

app.get('/health', async () => {
  await pool.query('SELECT 1');
  return { ok: true };
});

await app.register(ingestRoutes, { prefix: '/api/ingest' });
await app.register(authRoutes, { prefix: '/api/auth' });
await app.register(adminRoutes, { prefix: '/api/admin' });
await app.register(readRoutes, { prefix: '/api' });
await app.register(searchRoutes, { prefix: '/api' });
await app.register(analyticsRoutes, { prefix: '/api' });
await app.register(streamRoutes, { prefix: '/api' });
await app.register(fileRoutes, { prefix: '/api' });

await runMigrations(config.migrationsDir, app.log);

app.log.info({ storage: fileStore.name, maxMb: Math.round(config.files.maxBytes / 1048576) }, 'file archive ready');
// Hourly: remove archived files no message refers to any more (deleted, purged, retention).
const gcTimer = setInterval(() => collectOrphanBlobs(app.log).catch((err) => app.log.warn({ err }, 'file cleanup failed')), 3600_000);
gcTimer.unref();

const shutdown = async () => {
  clearInterval(gcTimer);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
