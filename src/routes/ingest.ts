import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { bus } from '../events.js';
import { pool } from '../db/pool.js';
import {
  commandResultBody,
  fileClaimBody,
  fileFailureBody,
  heartbeatBody,
  ingestChannelsBody,
  ingestMessagesBody,
  syncRunFinishBody,
  syncRunStartBody,
} from '../schemas.js';
import {
  collectorStatus,
  finishSyncRun,
  recordCollector,
  ingestChannels,
  ingestMessages,
  recordSource,
  startSyncRun,
  upsertWorkspace,
} from '../services/ingest.js';
import { UploadError, claimFiles, reportFileFailure, storeUpload } from '../services/files.js';
import { buildNotification } from '../services/notifications.js';

function keyMatches(given: string | undefined): boolean {
  if (!config.ingestApiKey) return true;
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.ingestApiKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Write endpoints used by the Chrome extension. Protected by X-API-Key when INGEST_API_KEY is set. */
export async function ingestRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (!keyMatches(req.headers['x-api-key'] as string | undefined)) {
      return reply.code(401).send({ error: 'invalid or missing X-API-Key' });
    }
  });

  // Lets the extension's "Test connection" button check URL + key in one call.
  app.get('/ping', async () => ({ ok: true }));

  // File uploads arrive as a raw stream (the file's real type travels in X-File-Type), never buffered in memory.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  // Admin control: revoked installs may not write at all; paused installs may only heartbeat.
  app.addHook('preHandler', async (req, reply) => {
    const collectorId =
      (req.body as { source?: { collector?: { id?: string } } } | undefined)?.source?.collector?.id ??
      (req.headers['x-collector-id'] as string | undefined);
    if (!collectorId || !['POST', 'PUT'].includes(req.method) || req.url.endsWith('/heartbeat')) return;
    const status = await collectorStatus(collectorId);
    if (status === 'revoked') return reply.code(403).send({ error: 'this browser was revoked by an admin' });
    if (status === 'paused') return reply.code(423).send({ error: 'capture paused by an admin' });
  });

  /**
   * Sent every 30–60 s by each extension install, so the dashboard shows which browsers are online.
   * The response carries the install's status, conversations excluded from capture, and pending admin commands.
   */
  app.post('/heartbeat', async (req, reply) => {
    const body = heartbeatBody.parse(req.body);
    let accountId: string | null = null;
    if (body.workspace) {
      await upsertWorkspace(pool, body.workspace);
      accountId = await recordSource(pool, body.workspace.id, body.source);
    } else {
      await recordCollector(pool, body.source.collector, null, null);
    }
    const { rows: c } = await pool.query('SELECT status, workspace_id FROM collectors WHERE id = $1', [body.source.collector.id]);
    const status = c[0]?.status ?? 'active';
    if (status === 'revoked') return reply.code(403).send({ error: 'this browser was revoked by an admin', status });

    const { rows: commands } = await pool.query(
      `UPDATE collector_commands SET status = 'delivered', delivered_at = now()
       WHERE collector_id = $1 AND status = 'pending'
       RETURNING id, type, payload`,
      [body.source.collector.id],
    );
    const { rows: excluded } = await pool.query<{ id: string }>(
      'SELECT id FROM channels WHERE workspace_id = $1 AND capture_excluded',
      [body.workspace?.id ?? c[0]?.workspace_id ?? null],
    );
    return {
      ok: true,
      accountId,
      status,
      excludedChannelIds: excluded.map((r) => r.id),
      commands: commands.map((r) => ({ id: Number(r.id), type: r.type, payload: r.payload })),
    };
  });

  /** The extension reports how an admin command went. */
  app.post<{ Params: { id: string } }>('/commands/:id', async (req, reply) => {
    const body = commandResultBody.parse(req.body);
    const { rowCount } = await pool.query(
      `UPDATE collector_commands SET status = $2, result = $3, finished_at = now()
       WHERE id = $1 AND status IN ('pending', 'delivered')`,
      [req.params.id, body.status, body.result ?? null],
    );
    if (!rowCount) return reply.code(404).send({ error: 'command not found' });
    bus.emitSyncRun({ id: `command:${req.params.id}`, status: body.status });
    return { ok: true };
  });

  app.post('/channels', async (req) => {
    const body = ingestChannelsBody.parse(req.body);
    const count = await ingestChannels(body.workspace, body.channels, body.source);
    return { ok: true, count };
  });

  app.post('/messages', async (req) => {
    const body = ingestMessagesBody.parse(req.body);
    const result = await ingestMessages(body);
    if (result.inserted + result.updated > 0) {
      bus.emitMessages({
        workspaceId: body.workspace.id,
        channelId: body.channel.id,
        channelName: body.channel.name,
        inserted: result.inserted,
        updated: result.updated,
        newestTs: result.newestTs,
      });
    }
    if (result.newMessages.length) {
      // Notifications are best-effort: a failure here must not make the extension retry the batch.
      buildNotification(body, result.newMessages).then(
        (n) => n && bus.emitNotification(n),
        (err) => req.log.warn({ err }, 'building notification failed'),
      );
    }
    const { newMessages: _fresh, ...counts } = result;
    return { ok: true, ...counts };
  });

  /**
   * File archive, step 1: a browser asks for files to download from one workspace. Each file is leased to
   * that browser for 10 minutes so other browsers capturing the same workspace don't fetch it too.
   */
  app.post('/files/claim', async (req) => {
    const body = fileClaimBody.parse(req.body);
    const files = await claimFiles({
      workspaceId: body.workspaceId,
      collectorId: body.source.collector.id,
      accountUserId: body.source.account?.userId ?? null,
      kinds: body.kinds,
      maxBytes: Math.min(body.maxBytes ?? config.files.maxBytes, config.files.maxBytes),
      limit: body.limit,
    });
    return { files, maxBytes: config.files.maxBytes };
  });

  /** Step 2: the file's bytes (Content-Type: application/octet-stream; X-File-Type: real type; ?variant=preview for Slack's preview image). */
  app.put<{ Params: { id: string }; Querystring: { variant?: string } }>('/files/:id/content', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid file id' });
    if (!(req.body && typeof (req.body as NodeJS.ReadableStream).pipe === 'function')) {
      return reply.code(415).send({ error: 'send the file as application/octet-stream' });
    }
    const mimeType = String(req.headers['x-file-type'] ?? '').slice(0, 200) || null;
    try {
      const result = await storeUpload(id, req.body as Readable, {
        variant: req.query.variant === 'preview' ? 'preview' : 'original',
        mimeType: mimeType && /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ? mimeType : null,
      });
      return { ok: true, ...result };
    } catch (err) {
      if (err instanceof UploadError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  /** Step 2 (alternative): the browser could not get the file. */
  app.post<{ Params: { id: string } }>('/files/:id/failure', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid file id' });
    const body = fileFailureBody.parse(req.body);
    const status = await reportFileFailure(id, body);
    if (!status) return reply.code(404).send({ error: 'file not found or not pending' });
    return { ok: true, status };
  });

  app.post('/runs', async (req) => {
    const body = syncRunStartBody.parse(req.body);
    await startSyncRun(body);
    bus.emitSyncRun({ id: body.id, status: 'running' });
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const body = syncRunFinishBody.parse(req.body);
    const found = await finishSyncRun(req.params.id, body);
    if (!found) return reply.code(404).send({ error: 'run not found' });
    bus.emitSyncRun({ id: req.params.id, status: body.status });
    return { ok: true };
  });
}
