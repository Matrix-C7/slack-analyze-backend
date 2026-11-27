import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { Document } from 'mongodb';
import { z } from 'zod';
import { audit, requireAdmin, requireUser } from '../auth.js';
import { col, nextId } from '../db/mongo.js';
import { bus } from '../events.js';
import { fileStore, tempDir } from '../services/fileStore.js';

/**
 * Desktop app management. Each Slack Analyze desktop app checks in (on start, every minute, and when the live stream
 * says "app_ping"). The answer carries what the admin set for it: the server it must use, an update to install, and
 * notifications to show as Windows toasts. Admin routes (under /api/admin/app) manage those.
 */

const ONLINE_MS = 3 * 60_000;
const POLICY_ID = 'app_policy';
const RELEASE_MAX_BYTES = 400 * 1024 * 1024;

/** "1.2.10" > "1.2.9". Missing parts count as 0; anything non-numeric sorts first. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const version = z.string().trim().regex(/^\d+(\.\d+){1,3}$/, 'version must look like 1.2.3');
const installId = z.string().trim().min(8).max(64);

const checkinBody = z.object({
  installId,
  machine: z.string().trim().max(120).default(''),
  os: z.string().trim().max(120).default(''),
  version,
  serverUrl: z.string().trim().max(500).default(''),
  /** The app currently follows the admin's server policy. */
  managed: z.boolean().default(false),
  update: z
    .object({
      status: z.enum(['idle', 'downloading', 'ready', 'installing', 'failed', 'postponed']),
      version: z.string().max(40).nullish(),
      progress: z.number().min(0).max(1).nullish(),
      error: z.string().max(500).nullish(),
    })
    .nullish(),
});

const policyBody = z.object({
  /** Empty = no managed server: every app keeps its own setting. */
  serverUrl: z
    .string()
    .trim()
    .max(500)
    .refine((s) => s === '' || /^https?:\/\/[^\s/]+/i.test(s), 'server URL must start with http:// or https://'),
  locked: z.boolean().default(false),
  /** null = all users. */
  userIds: z.array(z.number().int().positive()).max(5000).nullable().default(null),
});

const updateBody = z.object({
  /** Apps to update; omitted = every app that is behind `version`. */
  installIds: z.array(installId).max(5000).optional(),
  version: version.optional(),
  /** ask = banner with Restart now / Later; now = restart as soon as it's downloaded. */
  mode: z.enum(['ask', 'now']).default('ask'),
  /** With "ask": restart anyway after this many hours (0 = never force). */
  postponeHours: z.number().int().min(0).max(168).default(24),
});

const notificationBody = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().max(1000).default(''),
  important: z.boolean().default(false),
  /** null = all users. */
  userIds: z.array(z.number().int().positive()).min(1).max(5000).nullable().default(null),
});

const releaseQuery = z.object({ version, notes: z.string().max(2000).default('') });

interface Policy {
  serverUrl: string;
  locked: boolean;
  userIds: number[] | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

async function readPolicy(): Promise<Policy> {
  const doc = await col.settings.findOne({ _id: POLICY_ID });
  const v = (doc?.value ?? {}) as Partial<Policy>;
  return { serverUrl: v.serverUrl ?? '', locked: v.locked ?? false, userIds: v.userIds ?? null, updatedAt: v.updatedAt ?? null, updatedBy: v.updatedBy ?? null };
}

const appliesTo = (userIds: number[] | null | undefined, userId: number) => !userIds || userIds.includes(userId);

async function latestRelease(): Promise<Document | null> {
  const all = await col.appReleases.find({}, { projection: { _id: 0 } }).toArray();
  all.sort((a, b) => compareVersions(String(b.version), String(a.version)));
  return all[0] ?? null;
}

const releaseView = (r: Document) => ({
  version: r.version,
  size: r.size,
  sha256: r.sha256,
  notes: r.notes ?? '',
  releasedAt: r.released_at,
  releasedBy: r.released_by ?? null,
});

/** Streams the upload to a temp file while hashing it. */
async function spool(body: Readable): Promise<{ tempPath: string; sha256: string; size: number }> {
  await fs.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `${crypto.randomUUID()}.part`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    await pipeline(
      body,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > RELEASE_MAX_BYTES) throw Object.assign(new Error('release file is larger than 400 MB'), { statusCode: 413 });
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
  return { tempPath, sha256: hash.digest('hex'), size };
}

// ---------------------------------------------------------------------------
// The desktop app (any signed-in user)
// ---------------------------------------------------------------------------
export async function appRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireUser);

  app.post('/checkin', async (req) => {
    const body = checkinBody.parse(req.body);
    const user = req.user!;
    const now = new Date();
    const install = await col.appInstalls.findOneAndUpdate(
      { id: body.installId },
      {
        $set: {
          user_id: user.id,
          machine: body.machine,
          os: body.os,
          version: body.version,
          server_url: body.serverUrl,
          managed: body.managed,
          update_state: body.update ?? null,
          last_seen_at: now,
        },
        $setOnInsert: { id: body.installId, first_seen_at: now },
      },
      { upsert: true, returnDocument: 'after' },
    );

    // Server policy
    const policy = await readPolicy();
    const server = policy.serverUrl && appliesTo(policy.userIds, user.id) ? { url: policy.serverUrl, locked: policy.locked, setBy: policy.updatedBy, setAt: policy.updatedAt } : null;

    // Requested update: dropped once the app runs that version (or a newer one).
    let update = null;
    const reqd = install?.update_request as Document | undefined;
    if (reqd) {
      if (compareVersions(body.version, String(reqd.version)) >= 0) {
        await col.appInstalls.updateOne({ id: body.installId }, { $unset: { update_request: '' } });
      } else {
        const rel = await col.appReleases.findOne({ version: reqd.version });
        if (rel)
          update = {
            version: rel.version,
            size: rel.size,
            sha256: rel.sha256,
            notes: rel.notes ?? '',
            url: `api/app/releases/${encodeURIComponent(String(rel.version))}/download`,
            mode: reqd.mode,
            postponeHours: reqd.postpone_hours ?? 0,
            requestedAt: reqd.requested_at,
          };
      }
    }

    // Notifications this app hasn't shown yet (sent after it was first seen, at most a week old).
    const since = new Date(Math.max((install?.first_seen_at as Date | undefined)?.getTime() ?? now.getTime(), now.getTime() - 7 * 86400_000) - 60_000);
    const candidates = await col.appNotifications
      .find({ created_at: { $gte: since }, $or: [{ user_ids: null }, { user_ids: user.id }] })
      .sort({ id: 1 })
      .limit(50)
      .toArray();
    const seen = new Set(
      (await col.appNotificationReceipts.find({ install_id: body.installId, notification_id: { $in: candidates.map((n) => n.id) } }, { projection: { notification_id: 1 } }).toArray()).map(
        (r) => r.notification_id,
      ),
    );
    const fresh = candidates.filter((n) => !seen.has(n.id));
    if (fresh.length) {
      await col.appNotificationReceipts
        .insertMany(
          fresh.map((n) => ({ notification_id: n.id, install_id: body.installId, user_id: user.id, delivered_at: now, read_at: null })),
          { ordered: false },
        )
        .catch(() => {}); // a parallel check-in already delivered some
    }
    const senders = new Map(
      (await col.appUsers.find({ id: { $in: [...new Set(fresh.map((n) => n.created_by))] } }, { projection: { id: 1, name: 1, email: 1 } }).toArray()).map((u) => [u.id, u.name || u.email]),
    );

    return {
      ok: true,
      server,
      update,
      notifications: fresh.map((n) => ({ id: n.id, title: n.title, body: n.body, important: !!n.important, from: senders.get(n.created_by) ?? 'your admin', createdAt: n.created_at })),
      checkinSeconds: 60,
    };
  });

  /** The user opened or dismissed an admin notification. */
  app.post<{ Params: { id: string } }>('/notifications/:id/read', async (req) => {
    const { installId: id } = z.object({ installId }).parse(req.body);
    await col.appNotificationReceipts.updateOne({ notification_id: Number(req.params.id), install_id: id, read_at: null }, { $set: { read_at: new Date() } });
    return { ok: true };
  });

  app.get('/releases/latest', async () => {
    const r = await latestRelease();
    return r ? releaseView(r) : null;
  });

  app.get<{ Params: { version: string } }>('/releases/:version/download', async (req, reply) => {
    const r = await col.appReleases.findOne({ version: req.params.version });
    if (!r) return reply.code(404).send({ error: 'release not found' });
    const stream = await fileStore.get(String(r.storage_key));
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', String(r.size));
    reply.header('Content-Disposition', `attachment; filename="SlackAnalyze-${r.version}.exe"`);
    reply.header('X-Sha256', String(r.sha256));
    return reply.send(stream);
  });
}

// ---------------------------------------------------------------------------
// Admin: /api/admin/app
// ---------------------------------------------------------------------------
export async function appAdminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAdmin);
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.get('/installs', async () => {
    const [installs, latest, policy] = await Promise.all([col.appInstalls.find({}).sort({ last_seen_at: -1 }).limit(2000).toArray(), latestRelease(), readPolicy()]);
    const users = new Map(
      (await col.appUsers.find({ id: { $in: [...new Set(installs.map((i) => i.user_id))] } }, { projection: { id: 1, name: 1, email: 1, avatar_version: 1 } }).toArray()).map((u) => [u.id, u]),
    );
    const now = Date.now();
    return {
      latest: latest ? releaseView(latest) : null,
      policy,
      installs: installs.map((i) => {
        const u = users.get(i.user_id);
        const req = i.update_request as Document | undefined;
        return {
          id: i.id,
          userId: i.user_id,
          userName: u?.name ?? null,
          userEmail: u?.email ?? null,
          machine: i.machine || null,
          os: i.os || null,
          version: i.version,
          serverUrl: i.server_url || null,
          managed: !!i.managed,
          online: now - new Date(i.last_seen_at).getTime() < ONLINE_MS,
          lastSeenAt: i.last_seen_at,
          firstSeenAt: i.first_seen_at,
          updateState: i.update_state ?? null,
          updateRequest: req ? { version: req.version, mode: req.mode, postponeHours: req.postpone_hours ?? 0, requestedAt: req.requested_at } : null,
        };
      }),
    };
  });

  app.delete<{ Params: { id: string } }>('/installs/:id', async (req) => {
    await col.appInstalls.deleteOne({ id: req.params.id });
    await col.appNotificationReceipts.deleteMany({ install_id: req.params.id });
    await audit(req, 'app.install.delete', req.params.id);
    return { ok: true };
  });

  app.get('/policy', async () => readPolicy());

  app.put('/policy', async (req) => {
    const body = policyBody.parse(req.body);
    const value: Policy = { ...body, serverUrl: body.serverUrl.replace(/\/+$/, ''), updatedAt: new Date(), updatedBy: req.user!.email };
    await col.settings.updateOne({ _id: POLICY_ID }, { $set: { value } }, { upsert: true });
    await audit(req, 'app.policy', null, { serverUrl: value.serverUrl, locked: value.locked, users: value.userIds?.length ?? 'all' });
    bus.emitAppPing({ userIds: value.userIds });
    return value;
  });

  app.get('/releases', async () => {
    const all = await col.appReleases.find({}).toArray();
    all.sort((a, b) => compareVersions(String(b.version), String(a.version)));
    return all.map(releaseView);
  });

  /** Upload a release: the single-file SlackAnalyze.exe as application/octet-stream, ?version=1.2.3&notes=… */
  app.post('/releases', { bodyLimit: RELEASE_MAX_BYTES }, async (req, reply) => {
    const q = releaseQuery.parse(req.query);
    if (!String(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) return reply.code(415).send({ error: 'send the exe as application/octet-stream' });
    const { tempPath, sha256, size } = await spool(req.body as Readable);
    if (size < 1024 * 1024) {
      await fs.rm(tempPath, { force: true });
      return reply.code(400).send({ error: 'that file is too small to be the app' });
    }
    const key = await fileStore.put(sha256, tempPath, { size, mimeType: 'application/octet-stream' });
    const doc = { version: q.version, sha256, size, storage_key: key, notes: q.notes, released_at: new Date(), released_by: req.user!.email };
    await col.appReleases.updateOne({ version: q.version }, { $set: doc }, { upsert: true });
    await audit(req, 'app.release', q.version, { size, sha256 });
    return releaseView(doc);
  });

  app.delete<{ Params: { version: string } }>('/releases/:version', async (req) => {
    await col.appReleases.deleteOne({ version: req.params.version });
    await col.appInstalls.updateMany({ 'update_request.version': req.params.version }, { $unset: { update_request: '' } });
    await audit(req, 'app.release.delete', req.params.version);
    return { ok: true };
  });

  /** Ask apps to update. */
  app.post('/updates', async (req, reply) => {
    const body = updateBody.parse(req.body);
    const rel = body.version ? await col.appReleases.findOne({ version: body.version }) : await latestRelease();
    if (!rel) return reply.code(400).send({ error: 'upload a release first' });
    const target = String(rel.version);
    const installs = await col.appInstalls.find(body.installIds ? { id: { $in: body.installIds } } : {}, { projection: { id: 1, user_id: 1, version: 1 } }).toArray();
    const behind = installs.filter((i) => compareVersions(String(i.version), target) < 0);
    if (behind.length) {
      await col.appInstalls.updateMany(
        { id: { $in: behind.map((i) => i.id) } },
        { $set: { update_request: { version: target, mode: body.mode, postpone_hours: body.postponeHours, requested_at: new Date(), requested_by: req.user!.email } } },
      );
    }
    await audit(req, 'app.update', target, { apps: behind.length, mode: body.mode });
    bus.emitAppPing({ userIds: [...new Set(behind.map((i) => Number(i.user_id)))] });
    return { ok: true, version: target, requested: behind.length, alreadyCurrent: installs.length - behind.length };
  });

  app.delete<{ Params: { id: string } }>('/updates/:id', async (req) => {
    await col.appInstalls.updateOne({ id: req.params.id }, { $unset: { update_request: '' } });
    await audit(req, 'app.update.cancel', req.params.id);
    return { ok: true };
  });

  app.post('/notifications', async (req) => {
    const body = notificationBody.parse(req.body);
    const id = await nextId('app_notifications');
    await col.appNotifications.insertOne({ id, title: body.title, body: body.body, important: body.important, user_ids: body.userIds, created_by: req.user!.id, created_at: new Date() });
    await audit(req, 'app.notify', String(id), { title: body.title, users: body.userIds?.length ?? 'all', important: body.important });
    bus.emitAppPing({ userIds: body.userIds });
    return { ok: true, id };
  });

  app.get('/notifications', async () => {
    const list = await col.appNotifications.find({}).sort({ id: -1 }).limit(100).toArray();
    const ids = list.map((n) => n.id);
    const [counts, users, installs] = await Promise.all([
      col.appNotificationReceipts
        .aggregate([{ $match: { notification_id: { $in: ids } } }, { $group: { _id: '$notification_id', delivered: { $sum: 1 }, read: { $sum: { $cond: [{ $ne: ['$read_at', null] }, 1, 0] } } } }])
        .toArray(),
      col.appUsers.find({}, { projection: { id: 1, name: 1, email: 1 } }).toArray(),
      col.appInstalls.find({}, { projection: { user_id: 1, first_seen_at: 1 } }).toArray(),
    ]);
    const byId = new Map(counts.map((c) => [c._id, c]));
    const names = new Map(users.map((u) => [u.id, u.name || u.email]));
    return list.map((n) => {
      const c = byId.get(n.id);
      const targets = installs.filter((i) => appliesTo(n.user_ids, Number(i.user_id)) && new Date(i.first_seen_at).getTime() <= new Date(n.created_at).getTime() + 60_000).length;
      return {
        id: n.id,
        title: n.title,
        body: n.body,
        important: !!n.important,
        userIds: n.user_ids ?? null,
        to: n.user_ids ? n.user_ids.map((u: number) => names.get(u) ?? `#${u}`) : null,
        createdBy: names.get(n.created_by) ?? null,
        createdAt: n.created_at,
        delivered: c?.delivered ?? 0,
        read: c?.read ?? 0,
        targets,
      };
    });
  });

  /** Sends the same message again as a new notification (every app shows it once more). */
  app.post<{ Params: { id: string } }>('/notifications/:id/resend', async (req, reply) => {
    const n = await col.appNotifications.findOne({ id: Number(req.params.id) });
    if (!n) return reply.code(404).send({ error: 'notification not found' });
    const id = await nextId('app_notifications');
    await col.appNotifications.insertOne({ id, title: n.title, body: n.body, important: n.important, user_ids: n.user_ids ?? null, created_by: req.user!.id, created_at: new Date() });
    await audit(req, 'app.notify', String(id), { resendOf: n.id });
    bus.emitAppPing({ userIds: n.user_ids ?? null });
    return { ok: true, id };
  });
}
