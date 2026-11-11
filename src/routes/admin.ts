import type { FastifyInstance } from 'fastify';
import type { Document } from 'mongodb';
import { z } from 'zod';
import { audit, hashPassword, requireAdmin } from '../auth.js';
import { config } from '../config.js';
import { col, db, deleteChannelData, deleteMessages, isDuplicateKey, nextId } from '../db/mongo.js';
import { fileStore } from '../services/fileStore.js';
import { lookupMap } from '../services/messages.js';
import { passwordSchema } from './auth.js';
import { isOnline, ONLINE_MS } from './read.js';

const DAY_MS = 86_400_000;

const fileRetryBody = z.object({ status: z.enum(['failed', 'skipped']) });

const userCreate = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().max(200).optional(),
  role: z.enum(['admin', 'viewer']).default('viewer'),
  password: passwordSchema,
});
const workspaceAccess = z.object({
  allWorkspaces: z.boolean(),
  workspaceIds: z.array(z.string().min(1).max(32)).max(1000).default([]),
});
const accountAccess = z.object({
  allAccounts: z.boolean(),
  accounts: z.array(z.object({ workspaceId: z.string().min(1).max(32), accountId: z.string().min(1).max(200) })).max(5000).default([]),
});
const userPatch = z.object({
  name: z.string().trim().max(200).nullish(),
  role: z.enum(['admin', 'viewer']).optional(),
  isActive: z.boolean().optional(),
  password: passwordSchema.optional(),
});
const collectorPatch = z.object({
  label: z.string().trim().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
  status: z.enum(['active', 'paused', 'revoked']).optional(),
});
const commandCreate = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sync_channels'), payload: z.object({ channelIds: z.array(z.string().max(32)).min(1).max(2000) }) }),
  z.object({ type: z.literal('sync_open'), payload: z.object({}).default({}) }),
  z.object({ type: z.literal('refresh_channels'), payload: z.object({}).default({}) }),
  z.object({ type: z.literal('stop'), payload: z.object({}).default({}) }),
  z.object({
    type: z.literal('set_settings'),
    payload: z
      .object({
        rangeValue: z.number().int().min(1).max(1200),
        rangeUnit: z.enum(['days', 'months', 'all']),
        autoEnabled: z.boolean(),
        autoIntervalMinutes: z.number().int().min(5).max(1440),
        incremental: z.boolean(),
        liveCapture: z.boolean(),
        keepSlackActive: z.boolean(),
        keepSlackActiveMinutes: z.number().int().min(1).max(60),
        captureThreads: z.boolean(),
        verifyPass: z.boolean(),
        loadPatienceSec: z.number().int().min(10).max(600),
        scrollDelayMs: z.number().int().min(300).max(10000),
        selectedChannelIds: z.array(z.string().max(32)).max(5000),
      })
      .partial(),
  }),
]);
const accountPatch = z.object({ isHidden: z.boolean() });
const channelPatch = z.object({ isHidden: z.boolean().optional(), captureExcluded: z.boolean().optional() });
const channelBulk = z.object({
  workspaceId: z.string().min(1),
  channelIds: z.array(z.string().min(1)).min(1).max(5000),
  action: z.enum(['hide', 'unhide', 'exclude', 'include', 'purge']),
});
const purgeBody = z.object({ before: z.string().date().optional() });
const workspacePatch = z.object({ name: z.string().trim().max(200).optional(), retentionDays: z.number().int().min(1).max(36500).nullable().optional() });
const exportQuery = z.object({
  workspaceId: z.string().min(1),
  channelId: z.string().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const lower = (s: unknown) => String(s ?? '').toLowerCase();
const k2 = (a: string, b: string) => `${a}\u0000${b}`;

async function userView(u: Document) {
  const sessions = await col.appSessions.countDocuments({ user_id: u.id, expires_at: { $gt: new Date() } });
  return {
    id: Number(u.id),
    email: u.email,
    name: u.name ?? null,
    role: u.role,
    isActive: u.is_active !== false,
    lastLoginAt: u.last_login_at ?? null,
    createdAt: u.created_at,
    activeSessions: sessions,
    allWorkspaces: u.all_workspaces !== false,
    workspaceIds: [...(u.workspace_ids ?? [])].sort(),
    allAccounts: u.all_accounts !== false,
    accounts: [...(u.account_grants ?? [])].sort((a, b) => byText(a.workspaceId, b.workspaceId) || byText(a.accountId, b.accountId)),
  };
}

/** Which Slack accounts a user can see. Unknown accounts are ignored. */
async function accountAccessUpdate(access: z.infer<typeof accountAccess>) {
  const wanted = access.accounts;
  const known = wanted.length ? await col.accounts.find({ $or: wanted.map((x) => ({ workspace_id: x.workspaceId, user_id: x.accountId })) }).toArray() : [];
  const grants = [...new Map(known.map((a) => [k2(a.workspace_id, a.user_id), { workspaceId: a.workspace_id as string, accountId: a.user_id as string }])).values()];
  return { all_accounts: access.allAccounts, account_grants: grants };
}

/** A user's community access. Unknown workspace ids are ignored. */
async function workspaceAccessUpdate(access: z.infer<typeof workspaceAccess>) {
  const ids = access.workspaceIds.length ? await col.workspaces.distinct('id', { id: { $in: access.workspaceIds } }) : [];
  return { all_workspaces: access.allWorkspaces, workspace_ids: ids };
}

/** Keeps at least one active admin: true if changing `userId` as described would leave none. */
async function wouldRemoveLastAdmin(userId: number, next: { role?: string; isActive?: boolean; deleted?: boolean }) {
  const [self, others] = await Promise.all([
    col.appUsers.findOne({ id: userId, role: 'admin', is_active: true }),
    col.appUsers.countDocuments({ id: { $ne: userId }, role: 'admin', is_active: true }),
  ]);
  const losesAdmin = next.deleted || next.isActive === false || (next.role !== undefined && next.role !== 'admin');
  return Boolean(self) && Boolean(losesAdmin) && others === 0;
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Admin-only API: status, dashboard users, collectors, content controls, export, audit log. */
export async function adminRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireAdmin);

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------
  app.get('/overview', async () => {
    const now = Date.now();
    const day = new Date(now - DAY_MS);
    const hourMs = 3600_000;
    const currentHour = Math.floor(now / hourMs) * hourMs;
    const n = (c: keyof typeof col, f: Document = {}) => col[c].countDocuments(f);
    const [
      messages, threadReplies, messages24h, last, channels, hiddenChannels, excludedChannels, workspaces, people, accounts,
      collectors, collectorsOnline, collectorsPaused, appUsers, deletedMessages, commandsOpen, runs, hourly, failures, stats,
    ] = await Promise.all([
      col.messages.estimatedDocumentCount(),
      n('messages', { thread_ts: { $type: 'string' }, $expr: { $ne: ['$thread_ts', '$ts'] } }),
      n('messages', { captured_at: { $gt: day } }),
      col.messages.find({}, { projection: { captured_at: 1 } }).sort({ captured_at: -1 }).limit(1).next(),
      n('channels'),
      n('channels', { is_hidden: true }),
      n('channels', { capture_excluded: true }),
      n('workspaces'),
      n('slackUsers'),
      n('accounts'),
      n('collectors'),
      n('collectors', { last_seen_at: { $gt: new Date(now - ONLINE_MS) }, status: { $ne: 'revoked' } }),
      n('collectors', { status: 'paused' }),
      n('appUsers'),
      n('deletedMessages'),
      n('collectorCommands', { status: { $in: ['pending', 'delivered'] } }),
      col.syncRuns.aggregate([{ $match: { started_at: { $gt: day } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
      col.messages
        .aggregate([
          { $match: { captured_at: { $gt: new Date(currentHour - 47 * hourMs) } } },
          { $group: { _id: { $dateTrunc: { date: '$captured_at', unit: 'hour' } }, n: { $sum: 1 } } },
        ])
        .toArray(),
      col.syncRuns.find({ status: 'failed' }).sort({ started_at: -1 }).limit(8).toArray(),
      db.command({ dbStats: 1 }),
    ]);
    const [chans, ks] = await Promise.all([
      lookupMap('channels', failures.filter((r) => r.channel_id).map((r) => ({ ws: r.workspace_id, id: r.channel_id }))),
      col.collectors.find({ id: { $in: failures.map((r) => r.collector_id).filter(Boolean) } }).toArray(),
    ]);
    const kBy = new Map(ks.map((x) => [x.id, x]));
    const runCounts = Object.fromEntries(runs.map((r) => [r._id, r.n]));
    const hourBy = new Map(hourly.map((h) => [(h._id as Date).getTime(), h.n]));
    return {
      totals: {
        messages,
        threadReplies,
        messages24h,
        lastIngestAt: last?.captured_at ?? null,
        channels,
        hiddenChannels,
        excludedChannels,
        workspaces,
        people,
        accounts,
        collectors,
        collectorsOnline,
        collectorsPaused,
        appUsers,
        deletedMessages,
        commandsOpen,
      },
      runs24h: {
        completed: runCounts.completed ?? 0,
        failed: runCounts.failed ?? 0,
        running: runCounts.running ?? 0,
        cancelled: runCounts.cancelled ?? 0,
      },
      hourly: Array.from({ length: 48 }, (_, i) => {
        const t = currentHour - (47 - i) * hourMs;
        return { hour: new Date(t).toISOString().replace('.000Z', 'Z'), messages: hourBy.get(t) ?? 0 };
      }),
      recentFailures: failures.map((r) => {
        const k = r.collector_id ? kBy.get(r.collector_id) : undefined;
        return {
          id: r.id,
          workspaceId: r.workspace_id,
          channelId: r.channel_id ?? null,
          channelName: r.channel_id ? (chans.get(k2(r.workspace_id, r.channel_id))?.name ?? null) : null,
          error: r.error ?? null,
          startedAt: r.started_at,
          collector: k?.label || k?.browser || null,
        };
      }),
      // Stored size on disk (data + indexes). Atlas M0 allows 512 MB.
      databaseBytes: Number(stats.storageSize ?? 0) + Number(stats.indexSize ?? 0),
    };
  });

  // ---------------------------------------------------------------------------
  // File archive
  // ---------------------------------------------------------------------------
  app.get('/files', async () => {
    const [byStatus, blobs, byKind, failures] = await Promise.all([
      col.messageFiles.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
      col.fileBlobs.aggregate([{ $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: '$size_bytes' } } }]).toArray(),
      col.messageFiles
        .aggregate([
          { $match: { blob_sha256: { $type: 'string' } } },
          { $group: { _id: { kind: { $ifNull: ['$kind', 'other'] }, sha: '$blob_sha256' } } },
          { $lookup: { from: 'file_blobs', localField: '_id.sha', foreignField: 'sha256', as: 'b' } },
          { $unwind: '$b' },
          { $group: { _id: '$_id.kind', files: { $sum: 1 }, bytes: { $sum: '$b.size_bytes' } } },
          { $sort: { bytes: -1 } },
        ])
        .toArray(),
      col.messageFiles.find({ status: 'failed' }).sort({ id: -1 }).limit(20).toArray(),
    ]);
    const [chans, msgs] = await Promise.all([
      lookupMap('channels', failures.map((f) => ({ ws: f.workspace_id, id: f.channel_id }))),
      col.messages.find({ id: { $in: failures.map((f) => f.message_id) } }, { projection: { id: 1, ts: 1, sent_at: 1 } }).toArray(),
    ]);
    const msgBy = new Map(msgs.map((m) => [m.id, m]));
    const counts = Object.fromEntries(byStatus.map((r) => [r._id, r.n]));
    return {
      storage: fileStore.name,
      maxBytes: config.files.maxBytes,
      counts: { stored: counts.stored ?? 0, pending: counts.pending ?? 0, failed: counts.failed ?? 0, skipped: counts.skipped ?? 0 },
      blobs: blobs[0]?.n ?? 0,
      bytes: blobs[0]?.bytes ?? 0,
      byKind: byKind.map((r) => ({ kind: r._id, files: r.files, bytes: r.bytes })),
      recentFailures: failures.map((f) => ({
        id: f.id,
        name: f.name ?? null,
        kind: f.kind ?? null,
        attempts: f.attempts ?? 0,
        error: f.last_error ?? null,
        workspaceId: f.workspace_id,
        channelId: f.channel_id,
        channelName: chans.get(k2(f.workspace_id, f.channel_id))?.name ?? null,
        ts: msgBy.get(f.message_id)?.ts ?? null,
        sentAt: msgBy.get(f.message_id)?.sent_at ?? f.sent_at ?? null,
      })),
    };
  });

  /** Puts failed (or skipped) files back in the download queue, e.g. after raising the size limit. */
  app.post('/files/retry', async (req) => {
    const body = fileRetryBody.parse(req.body);
    const res = await col.messageFiles.updateMany(
      { status: body.status, $or: [{ download_url: { $type: 'string' } }, { thumb_url: { $type: 'string' } }] },
      { $set: { status: 'pending', attempts: 0, next_attempt_at: null, leased_by: null, lease_until: null } },
    );
    await audit(req, 'files.retry', body.status, { files: res.modifiedCount });
    return { ok: true, queued: res.modifiedCount };
  });

  // ---------------------------------------------------------------------------
  // Dashboard users
  // ---------------------------------------------------------------------------
  app.get('/users', async () => {
    const users = await col.appUsers.find({}).toArray();
    users.sort((a, b) => byText(a.role, b.role) || byText(lower(a.email), lower(b.email)));
    return Promise.all(users.map(userView));
  });

  app.post('/users', async (req, reply) => {
    const body = userCreate.parse(req.body);
    const access = workspaceAccess.optional().parse((req.body as { access?: unknown })?.access);
    const acctAccess = accountAccess.optional().parse((req.body as { accountAccess?: unknown })?.accountAccess);
    if (await col.appUsers.findOne({ email: body.email })) return reply.code(409).send({ error: 'a user with that email already exists' });
    const now = new Date();
    const doc: Document = {
      id: await nextId('app_users'),
      email: body.email,
      name: body.name || null,
      role: body.role,
      password_hash: await hashPassword(body.password),
      is_active: true,
      last_login_at: null,
      all_workspaces: true,
      workspace_ids: [],
      all_accounts: true,
      account_grants: [],
      created_at: now,
      updated_at: now,
      ...(access ? await workspaceAccessUpdate(access) : {}),
      ...(acctAccess ? await accountAccessUpdate(acctAccess) : {}),
    };
    try {
      await col.appUsers.insertOne(doc);
    } catch (err) {
      if (isDuplicateKey(err)) return reply.code(409).send({ error: 'a user with that email already exists' });
      throw err;
    }
    await audit(req, 'user.create', String(doc.id), { email: body.email, role: body.role, ...access, ...acctAccess });
    return userView(doc);
  });

  /** Which Slack accounts a user can see (and "view as"). Takes effect on the user's next request. */
  app.put<{ Params: { id: string } }>('/users/:id/accounts', async (req, reply) => {
    const id = Number(req.params.id);
    const access = accountAccess.parse(req.body);
    const u = await col.appUsers.findOneAndUpdate({ id }, { $set: { ...(await accountAccessUpdate(access)), updated_at: new Date() } }, { returnDocument: 'after' });
    if (!u) return reply.code(404).send({ error: 'user not found' });
    await audit(req, 'user.accounts', String(id), { allAccounts: access.allAccounts, accounts: access.accounts.map((x) => `${x.workspaceId}/${x.accountId}`) });
    return userView(u);
  });

  /** Which communities (workspaces) a user can see. Takes effect on the user's next request; no re-login needed. */
  app.put<{ Params: { id: string } }>('/users/:id/workspaces', async (req, reply) => {
    const id = Number(req.params.id);
    const access = workspaceAccess.parse(req.body);
    const u = await col.appUsers.findOneAndUpdate({ id }, { $set: { ...(await workspaceAccessUpdate(access)), updated_at: new Date() } }, { returnDocument: 'after' });
    if (!u) return reply.code(404).send({ error: 'user not found' });
    await audit(req, 'user.workspaces', String(id), access);
    return userView(u);
  });

  app.patch<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const body = userPatch.parse(req.body);
    if (await wouldRemoveLastAdmin(id, body)) return reply.code(400).send({ error: 'there must be at least one active admin' });
    const set: Document = { updated_at: new Date() };
    if (body.name !== undefined) set.name = body.name ?? null;
    if (body.role) set.role = body.role;
    if (body.isActive !== undefined) set.is_active = body.isActive;
    if (body.password) set.password_hash = await hashPassword(body.password);
    const u = await col.appUsers.findOneAndUpdate({ id }, { $set: set }, { returnDocument: 'after' });
    if (!u) return reply.code(404).send({ error: 'user not found' });
    // Deactivation, role change and password reset all end the user's existing sessions.
    if (body.isActive === false || body.password || body.role) await col.appSessions.deleteMany({ user_id: id });
    await audit(req, 'user.update', String(id), { ...body, password: body.password ? '(reset)' : undefined });
    return userView(u);
  });

  app.delete<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (id === req.user!.id) return reply.code(400).send({ error: "you can't delete your own account" });
    if (await wouldRemoveLastAdmin(id, { deleted: true })) return reply.code(400).send({ error: 'there must be at least one active admin' });
    const u = await col.appUsers.findOneAndDelete({ id });
    if (!u) return reply.code(404).send({ error: 'user not found' });
    await Promise.all([
      col.appSessions.deleteMany({ user_id: id }),
      col.channelReads.deleteMany({ app_user_id: id }),
      col.auditLog.updateMany({ user_id: id }, { $set: { user_id: null } }),
      col.collectorCommands.updateMany({ created_by: id }, { $set: { created_by: null } }),
      col.deletedMessages.updateMany({ deleted_by: id }, { $set: { deleted_by: null } }),
    ]);
    await audit(req, 'user.delete', String(id), { email: u.email });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Collectors (extension installs) + remote commands
  // ---------------------------------------------------------------------------
  app.get('/collectors', async () => {
    const collectors = await col.collectors.find({}).toArray();
    const ids = collectors.map((k) => k.id);
    const pairs = collectors.filter((k) => k.workspace_id && k.account_user_id).map((k) => ({ ws: k.workspace_id, id: k.account_user_id }));
    const day = new Date(Date.now() - DAY_MS);
    const [workspaces, accounts, users, runs, cmds] = await Promise.all([
      col.workspaces.find({ id: { $in: [...new Set(collectors.map((k) => k.workspace_id))] } }).toArray(),
      pairs.length ? col.accounts.find({ $or: pairs.map((p) => ({ workspace_id: p.ws, user_id: p.id })) }).toArray() : [],
      lookupMap('slackUsers', pairs),
      col.syncRuns
        .aggregate([
          { $match: { collector_id: { $in: ids } } },
          {
            $group: {
              _id: '$collector_id',
              n: { $sum: 1 },
              failed24h: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'failed'] }, { $gt: ['$started_at', day] }] }, 1, 0] } },
              received: { $sum: '$messages_received' },
              lastRun: { $max: '$started_at' },
            },
          },
        ])
        .toArray(),
      col.collectorCommands
        .aggregate([{ $match: { collector_id: { $in: ids }, status: { $in: ['pending', 'delivered'] } } }, { $group: { _id: '$collector_id', n: { $sum: 1 } } }])
        .toArray(),
    ]);
    const wsName = new Map(workspaces.map((w) => [w.id, w.name ?? null]));
    const acc = new Map(accounts.map((a) => [k2(a.workspace_id, a.user_id), a]));
    const runBy = new Map(runs.map((r) => [r._id, r]));
    const cmdBy = new Map(cmds.map((c) => [c._id, c.n]));
    collectors.sort(
      (a, b) => Number(a.status === 'revoked') - Number(b.status === 'revoked') || (b.last_seen_at?.getTime() ?? 0) - (a.last_seen_at?.getTime() ?? 0),
    );
    return collectors.map((k) => {
      const a = acc.get(k2(k.workspace_id, k.account_user_id));
      const su = users.get(k2(k.workspace_id, k.account_user_id));
      const r = runBy.get(k.id);
      return {
        id: k.id,
        label: k.label ?? null,
        browser: k.browser ?? null,
        version: k.extension_version ?? null,
        status: k.status ?? 'active',
        notes: k.notes ?? null,
        workspaceId: k.workspace_id ?? null,
        workspaceName: wsName.get(k.workspace_id) ?? null,
        accountId: k.account_user_id ?? null,
        accountName: a?.display_name ?? su?.display_name ?? null,
        accountAvatar: a?.avatar_url ?? su?.avatar_url ?? null,
        online: isOnline(k.last_seen_at) && k.status !== 'revoked',
        firstSeenAt: k.first_seen_at,
        lastSeenAt: k.last_seen_at,
        lastRunAt: r?.lastRun ?? null,
        runCount: r?.n ?? 0,
        failed24h: r?.failed24h ?? 0,
        messagesReceived: r?.received ?? 0,
        openCommands: cmdBy.get(k.id) ?? 0,
      };
    });
  });

  app.patch<{ Params: { id: string } }>('/collectors/:id', async (req, reply) => {
    const body = collectorPatch.parse(req.body);
    const set: Document = {};
    if (body.label !== undefined) set.label = body.label || null;
    if (body.notes !== undefined) set.notes = body.notes || null;
    if (body.status) set.status = body.status;
    const found = Object.keys(set).length
      ? (await col.collectors.updateOne({ id: req.params.id }, { $set: set })).matchedCount > 0
      : Boolean(await col.collectors.findOne({ id: req.params.id }, { projection: { _id: 1 } }));
    if (!found) return reply.code(404).send({ error: 'collector not found' });
    if (body.status === 'revoked') {
      await col.collectorCommands.updateMany({ collector_id: req.params.id, status: 'pending' }, { $set: { status: 'cancelled' } });
    }
    await audit(req, body.status ? `collector.${body.status === 'active' ? 'resume' : body.status === 'paused' ? 'pause' : 'revoke'}` : 'collector.update', req.params.id, body);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/collectors/:id', async (req, reply) => {
    const res = await col.collectors.deleteOne({ id: req.params.id });
    if (!res.deletedCount) return reply.code(404).send({ error: 'collector not found' });
    await col.collectorCommands.deleteMany({ collector_id: req.params.id });
    await audit(req, 'collector.delete', req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/collectors/:id/commands', async (req, reply) => {
    const cmd = commandCreate.parse(req.body);
    const k = await col.collectors.findOne({ id: req.params.id }, { projection: { status: 1 } });
    if (!k) return reply.code(404).send({ error: 'collector not found' });
    if (k.status === 'revoked') return reply.code(400).send({ error: 'collector is revoked' });
    const id = await nextId('collector_commands');
    await col.collectorCommands.insertOne({
      id,
      collector_id: req.params.id,
      type: cmd.type,
      payload: cmd.payload,
      status: 'pending',
      result: null,
      created_by: req.user!.id,
      created_at: new Date(),
      delivered_at: null,
      finished_at: null,
    });
    await audit(req, `command.${cmd.type}`, req.params.id, cmd.payload);
    return { ok: true, id };
  });

  app.get<{ Querystring: { collectorId?: string; limit?: string } }>('/commands', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 500);
    const cmds = await col.collectorCommands
      .find(req.query.collectorId ? { collector_id: req.query.collectorId } : {})
      .sort({ created_at: -1, id: -1 })
      .limit(limit)
      .toArray();
    const [ks, us] = await Promise.all([
      col.collectors.find({ id: { $in: [...new Set(cmds.map((c) => c.collector_id))] } }).toArray(),
      col.appUsers.find({ id: { $in: [...new Set(cmds.map((c) => c.created_by).filter((x) => x != null))] } }, { projection: { id: 1, email: 1 } }).toArray(),
    ]);
    const kBy = new Map(ks.map((x) => [x.id, x]));
    const uBy = new Map(us.map((x) => [x.id, x.email]));
    return cmds
      .filter((c) => kBy.has(c.collector_id))
      .map((c) => {
        const k = kBy.get(c.collector_id)!;
        return {
          id: c.id,
          collectorId: c.collector_id,
          collector: k.label || k.browser || null,
          type: c.type,
          payload: c.payload,
          status: c.status,
          result: c.result ?? null,
          createdBy: c.created_by != null ? (uBy.get(c.created_by) ?? null) : null,
          createdAt: c.created_at,
          deliveredAt: c.delivered_at ?? null,
          finishedAt: c.finished_at ?? null,
        };
      });
  });

  app.post<{ Params: { id: string } }>('/commands/:id/cancel', async (req, reply) => {
    const res = await col.collectorCommands.updateOne({ id: Number(req.params.id), status: 'pending' }, { $set: { status: 'cancelled', finished_at: new Date() } });
    if (!res.matchedCount) return reply.code(400).send({ error: 'only pending commands can be cancelled' });
    await audit(req, 'command.cancel', req.params.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Content
  // ---------------------------------------------------------------------------
  app.get('/workspaces', async () => {
    const [workspaces, msgStats, chStats] = await Promise.all([
      col.workspaces.find({}).toArray(),
      col.messages.aggregate([{ $group: { _id: '$workspace_id', n: { $sum: 1 }, oldest: { $min: '$sent_at' } } }]).toArray(),
      col.channels.aggregate([{ $group: { _id: '$workspace_id', n: { $sum: 1 } } }]).toArray(),
    ]);
    const msg = new Map(msgStats.map((s) => [s._id, s]));
    const ch = new Map(chStats.map((s) => [s._id, s.n]));
    workspaces.sort((a, b) => Number(a.name == null) - Number(b.name == null) || byText(a.name ?? '', b.name ?? ''));
    return workspaces.map((w) => ({
      id: w.id,
      name: w.name ?? null,
      domain: w.domain ?? null,
      iconUrl: w.icon_url ?? null,
      retentionDays: w.retention_days ?? null,
      messageCount: msg.get(w.id)?.n ?? 0,
      channelCount: ch.get(w.id) ?? 0,
      oldestMessageAt: msg.get(w.id)?.oldest ?? null,
      createdAt: w.created_at,
    }));
  });

  app.patch<{ Params: { id: string } }>('/workspaces/:id', async (req, reply) => {
    const body = workspacePatch.parse(req.body);
    const set: Document = { updated_at: new Date() };
    if (body.name) set.name = body.name;
    if (body.retentionDays !== undefined) set.retention_days = body.retentionDays;
    const w = await col.workspaces.findOneAndUpdate({ id: req.params.id }, { $set: set }, { returnDocument: 'after' });
    if (!w) return reply.code(404).send({ error: 'workspace not found' });
    let purged = 0;
    if (w.retention_days) {
      purged = await deleteMessages({ workspace_id: req.params.id, sent_at: { $lt: new Date(Date.now() - w.retention_days * DAY_MS) } });
    }
    await audit(req, 'workspace.update', req.params.id, { ...body, purged });
    return { ok: true, purged };
  });

  app.delete<{ Params: { id: string } }>('/workspaces/:id', async (req, reply) => {
    const ws = req.params.id;
    const res = await col.workspaces.deleteOne({ id: ws });
    if (!res.deletedCount) return reply.code(404).send({ error: 'workspace not found' });
    const f = { workspace_id: ws };
    await Promise.all([
      col.channels.deleteMany(f),
      col.messages.deleteMany(f),
      col.messageFiles.deleteMany(f),
      col.slackUsers.deleteMany(f),
      col.accounts.deleteMany(f),
      col.channelAccounts.deleteMany(f),
      col.channelReads.deleteMany(f),
      col.syncRuns.deleteMany(f),
      col.appUsers.updateMany({}, { $pull: { workspace_ids: ws, account_grants: { workspaceId: ws } } as Document }),
      col.collectors.updateMany(f, { $set: { workspace_id: null, account_user_id: null } }),
    ]);
    await audit(req, 'workspace.delete', ws);
    return { ok: true };
  });

  /** Captured Slack accounts (of one community, or all of them), with their visibility to viewers. */
  app.get<{ Querystring: { workspaceId?: string } }>('/accounts', async (req) => {
    const filter = req.query.workspaceId ? { workspace_id: req.query.workspaceId } : {};
    const accounts = await col.accounts.find(filter).toArray();
    const [users, links, online] = await Promise.all([
      lookupMap('slackUsers', accounts.map((a) => ({ ws: a.workspace_id, id: a.user_id }))),
      col.channelAccounts
        .aggregate([{ $match: filter }, { $group: { _id: { ws: '$workspace_id', a: '$account_user_id' }, n: { $sum: 1 }, last: { $max: '$last_synced_at' } } }])
        .toArray(),
      col.collectors.find({ ...filter, last_seen_at: { $gt: new Date(Date.now() - ONLINE_MS) } }, { projection: { workspace_id: 1, account_user_id: 1 } }).toArray(),
    ]);
    const linkBy = new Map(links.map((l) => [k2(l._id.ws, l._id.a), l]));
    const onlineSet = new Set(online.map((k) => k2(k.workspace_id, k.account_user_id)));
    const rows = accounts.map((a) => {
      const key = k2(a.workspace_id, a.user_id);
      const su = users.get(key);
      return {
        workspaceId: a.workspace_id,
        id: a.user_id,
        name: a.display_name ?? su?.display_name ?? null,
        avatarUrl: a.avatar_url ?? su?.avatar_url ?? null,
        isHidden: Boolean(a.is_hidden),
        online: onlineSet.has(key),
        channelCount: linkBy.get(key)?.n ?? 0,
        firstSeenAt: a.first_seen_at,
        lastSeenAt: a.last_seen_at,
        lastSyncedAt: linkBy.get(key)?.last ?? null,
      };
    });
    return rows.sort((a, b) => byText(a.workspaceId, b.workspaceId) || byText(lower(a.name ?? a.id), lower(b.name ?? b.id)));
  });

  app.patch<{ Params: { ws: string; id: string } }>('/accounts/:ws/:id', async (req, reply) => {
    const body = accountPatch.parse(req.body);
    const res = await col.accounts.updateOne({ workspace_id: req.params.ws, user_id: req.params.id }, { $set: { is_hidden: body.isHidden } });
    if (!res.matchedCount) return reply.code(404).send({ error: 'account not found' });
    await audit(req, body.isHidden ? 'account.hide' : 'account.show', `${req.params.ws}/${req.params.id}`);
    return { ok: true };
  });

  app.get<{ Querystring: { workspaceId?: string; q?: string; filter?: string; limit?: string; offset?: string } }>('/channels', async (req, reply) => {
    const { workspaceId, q, filter } = req.query;
    if (!workspaceId) return reply.code(400).send({ error: 'workspaceId is required' });
    // Paged when `limit` is given (infinite scroll); otherwise the full list.
    const limit = req.query.limit ? Math.min(Number(req.query.limit) || 100, 500) : null;
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const [channels, stats, links] = await Promise.all([
      col.channels.find({ workspace_id: workspaceId }).toArray(),
      col.messages
        .aggregate([
          { $match: { workspace_id: workspaceId } },
          {
            $group: {
              _id: '$channel_id',
              n: { $sum: 1 },
              replies: { $sum: { $cond: [{ $and: [{ $eq: [{ $type: '$thread_ts' }, 'string'] }, { $ne: ['$thread_ts', '$ts'] }] }, 1, 0] } },
              first: { $min: '$sent_at' },
              last: { $max: '$sent_at' },
            },
          },
        ])
        .toArray(),
      col.channelAccounts.aggregate([{ $match: { workspace_id: workspaceId } }, { $group: { _id: '$channel_id', n: { $sum: 1 } } }]).toArray(),
    ]);
    const s = new Map(stats.map((x) => [x._id, x]));
    const l = new Map(links.map((x) => [x._id, x.n]));
    const needle = q?.trim().toLowerCase() || null;
    const rows = channels
      .filter((c) => !needle || lower(c.name).includes(needle) || c.id === q?.trim())
      .filter((c) => {
        const n = s.get(c.id)?.n;
        if (!filter) return true;
        if (filter === 'hidden') return c.is_hidden;
        if (filter === 'excluded') return c.capture_excluded;
        if (filter === 'empty') return !n;
        if (filter === 'incomplete') return !c.reached_start && Boolean(n);
        return false;
      })
      .map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        isHidden: Boolean(c.is_hidden),
        captureExcluded: Boolean(c.capture_excluded),
        reachedStart: Boolean(c.reached_start),
        lastSyncedAt: c.last_synced_at ?? null,
        messageCount: s.get(c.id)?.n ?? 0,
        replyCount: s.get(c.id)?.replies ?? 0,
        firstMessageAt: s.get(c.id)?.first ?? null,
        lastMessageAt: s.get(c.id)?.last ?? null,
        accountCount: l.get(c.id) ?? 0,
      }))
      .sort((a, b) => b.messageCount - a.messageCount || byText(lower(a.name), lower(b.name)) || byText(a.id, b.id));
    return limit === null ? rows.slice(offset) : rows.slice(offset, offset + limit);
  });

  app.patch<{ Params: { ws: string; ch: string } }>('/channels/:ws/:ch', async (req, reply) => {
    const body = channelPatch.parse(req.body);
    const set: Document = { updated_at: new Date() };
    if (body.isHidden !== undefined) set.is_hidden = body.isHidden;
    if (body.captureExcluded !== undefined) set.capture_excluded = body.captureExcluded;
    const res = await col.channels.updateOne({ workspace_id: req.params.ws, id: req.params.ch }, { $set: set });
    if (!res.matchedCount) return reply.code(404).send({ error: 'channel not found' });
    await audit(req, 'channel.update', `${req.params.ws}/${req.params.ch}`, body);
    return { ok: true };
  });

  app.post('/channels/bulk', async (req) => {
    const body = channelBulk.parse(req.body);
    const ids = body.channelIds;
    let affected = 0;
    if (body.action === 'purge') {
      affected = await deleteMessages({ workspace_id: body.workspaceId, channel_id: { $in: ids } });
      await col.channels.updateMany(
        { workspace_id: body.workspaceId, id: { $in: ids } },
        { $set: { oldest_synced_ts: null, newest_synced_ts: null, reached_start: false } },
      );
    } else {
      const field = body.action === 'hide' || body.action === 'unhide' ? 'is_hidden' : 'capture_excluded';
      const val = body.action === 'hide' || body.action === 'exclude';
      const res = await col.channels.updateMany({ workspace_id: body.workspaceId, id: { $in: ids } }, { $set: { [field]: val, updated_at: new Date() } });
      affected = res.matchedCount;
    }
    await audit(req, `channel.bulk_${body.action}`, body.workspaceId, { channelIds: ids, affected });
    return { ok: true, affected };
  });

  /** Deletes a conversation's messages (optionally only those before a date). They can be captured again later. */
  app.post<{ Params: { ws: string; ch: string } }>('/channels/:ws/:ch/purge', async (req) => {
    const body = purgeBody.parse(req.body ?? {});
    const deleted = await deleteMessages({
      workspace_id: req.params.ws,
      channel_id: req.params.ch,
      ...(body.before ? { sent_at: { $lt: new Date(`${body.before}T00:00:00Z`) } } : {}),
    });
    await col.channels.updateOne(
      { workspace_id: req.params.ws, id: req.params.ch },
      { $set: body.before ? { reached_start: false } : { oldest_synced_ts: null, newest_synced_ts: null, reached_start: false } },
    );
    await audit(req, 'channel.purge', `${req.params.ws}/${req.params.ch}`, { before: body.before, deleted });
    return { ok: true, deleted };
  });

  app.delete<{ Params: { ws: string; ch: string } }>('/channels/:ws/:ch', async (req, reply) => {
    const res = await col.channels.deleteOne({ workspace_id: req.params.ws, id: req.params.ch });
    if (!res.deletedCount) return reply.code(404).send({ error: 'channel not found' });
    await deleteChannelData(req.params.ws, [req.params.ch]);
    await audit(req, 'channel.delete', `${req.params.ws}/${req.params.ch}`);
    return { ok: true };
  });

  /** Deletes one message and remembers it so a later sync doesn't bring it back. */
  app.delete<{ Params: { id: string } }>('/messages/:id', async (req, reply) => {
    const m = await col.messages.findOne({ id: Number(req.params.id) });
    if (!m) return reply.code(404).send({ error: 'message not found' });
    await col.deletedMessages.updateOne(
      { workspace_id: m.workspace_id, channel_id: m.channel_id, ts: m.ts },
      { $setOnInsert: { deleted_by: req.user!.id, deleted_at: new Date() } },
      { upsert: true },
    );
    // Thread replies go with their parent.
    const replies = await col.messages.distinct('id', { workspace_id: m.workspace_id, channel_id: m.channel_id, thread_ts: m.ts });
    await deleteMessages({ id: { $in: [m.id, ...replies] } });
    await audit(req, 'message.delete', `${m.workspace_id}/${m.channel_id}/${m.ts}`, { user: m.user_name ?? null, preview: String(m.text ?? '').slice(0, 200) });
    return { ok: true };
  });

  /** Streams messages as JSON (array) or CSV, page by page, so large exports don't sit in memory. */
  app.get('/export', async (req, reply) => {
    const q = exportQuery.parse(req.query);
    const name = `slack-${q.workspaceId}${q.channelId ? `-${q.channelId}` : ''}-${new Date().toISOString().slice(0, 10)}.${q.format}`;
    await audit(req, 'content.export', q.workspaceId, q);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Credentials': 'true',
    });
    const cols = ['workspace_id', 'channel_id', 'channel_name', 'channel_type', 'ts', 'sent_at', 'thread_ts', 'user_id', 'user_name', 'text', 'reply_count', 'is_edited', 'is_bot', 'reactions', 'files'];
    res.write(q.format === 'csv' ? `﻿${cols.join(',')}\n` : '[\n');
    const filter: Document = { workspace_id: q.workspaceId };
    if (q.channelId) filter.channel_id = q.channelId;
    if (q.from || q.to) {
      filter.sent_at = {
        ...(q.from ? { $gte: new Date(`${q.from}T00:00:00Z`) } : {}),
        ...(q.to ? { $lt: new Date(Date.parse(`${q.to}T00:00:00Z`) + DAY_MS) } : {}),
      };
    }
    let lastId = 0;
    let first = true;
    for (;;) {
      const page = await col.messages.find({ ...filter, id: { $gt: lastId } }).sort({ id: 1 }).limit(5000).toArray();
      if (!page.length) break;
      lastId = page.at(-1)!.id;
      const [chans, users, files] = await Promise.all([
        lookupMap('channels', page.map((m) => ({ ws: m.workspace_id, id: m.channel_id }))),
        lookupMap('slackUsers', page.filter((m) => m.user_id).map((m) => ({ ws: m.workspace_id, id: m.user_id }))),
        col.messageFiles.find({ message_id: { $in: page.filter((m) => m.has_files).map((m) => m.id) } }, { projection: { message_id: 1, url: 1 } }).toArray(),
      ]);
      const filesBy = new Map<number, string[]>();
      for (const f of files) filesBy.set(f.message_id, [...(filesBy.get(f.message_id) ?? []), f.url]);
      const rows = page.map((m) => {
        const c = chans.get(k2(m.workspace_id, m.channel_id));
        const su = m.user_id ? users.get(k2(m.workspace_id, m.user_id)) : undefined;
        return {
          workspace_id: m.workspace_id,
          channel_id: m.channel_id,
          channel_name: c?.name ?? null,
          channel_type: c?.type ?? null,
          ts: m.ts,
          sent_at: m.sent_at,
          thread_ts: m.thread_ts ?? null,
          user_id: m.user_id ?? null,
          user_name: m.user_name ?? su?.display_name ?? su?.real_name ?? null,
          text: m.text ?? '',
          reply_count: m.reply_count ?? 0,
          is_edited: Boolean(m.is_edited),
          is_bot: Boolean(m.is_bot),
          reactions: (m.reactions ?? []).length ? (m.reactions as Document[]).map((r) => `${r.emoji}:${r.count}`).join(' ') : null,
          files: filesBy.get(m.id)?.join(' ') ?? null,
        } as Record<string, unknown>;
      });
      const chunk =
        q.format === 'csv'
          ? rows.map((r) => cols.map((c) => csvCell(c === 'sent_at' ? (r[c] as Date).toISOString() : r[c])).join(',')).join('\n') + '\n'
          : rows
              .map((r) => {
                const s = `${first ? '' : ',\n'}${JSON.stringify(r)}`;
                first = false;
                return s;
              })
              .join('');
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    }
    res.end(q.format === 'csv' ? '' : '\n]\n');
  });

  // ---------------------------------------------------------------------------
  // Audit log
  // ---------------------------------------------------------------------------
  app.get<{ Querystring: { limit?: string; action?: string; before?: string } }>('/audit', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const filter: Document = {};
    if (req.query.action) filter.action = { $regex: `^${req.query.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` };
    if (req.query.before) filter.id = { $lt: Number(req.query.before) };
    const rows = await col.auditLog.find(filter).sort({ id: -1 }).limit(limit).toArray();
    return rows.map((r) => ({
      id: r.id,
      userEmail: r.user_email ?? null,
      action: r.action,
      target: r.target ?? null,
      details: r.details ?? null,
      createdAt: r.created_at,
    }));
  });
}
