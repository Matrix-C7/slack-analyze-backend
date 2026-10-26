import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { audit, hashPassword, requireAdmin } from '../auth.js';
import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { fileStore } from '../services/fileStore.js';
import { passwordSchema } from './auth.js';

const ONLINE_WINDOW = `interval '3 minutes'`;

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

const toUser = (r: Record<string, unknown>) => ({
  id: Number(r.id),
  email: r.email,
  name: r.name,
  role: r.role,
  isActive: r.is_active,
  lastLoginAt: r.last_login_at,
  createdAt: r.created_at,
  activeSessions: r.active_sessions ?? 0,
  allWorkspaces: r.all_workspaces ?? true,
  workspaceIds: (r.workspace_ids as string[] | undefined) ?? [],
  allAccounts: r.all_accounts ?? true,
  accounts: (r.account_grants as { workspaceId: string; accountId: string }[] | undefined) ?? [],
});

const USER_COLUMNS = `u.*,
  (SELECT count(*) FROM app_sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS active_sessions,
  ARRAY(SELECT aw.workspace_id FROM app_user_workspaces aw WHERE aw.user_id = u.id ORDER BY aw.workspace_id) AS workspace_ids,
  COALESCE((SELECT json_agg(json_build_object('workspaceId', ua.workspace_id, 'accountId', ua.account_user_id)
                            ORDER BY ua.workspace_id, ua.account_user_id)
            FROM app_user_accounts ua WHERE ua.user_id = u.id), '[]'::json) AS account_grants`;

/** Replaces which Slack accounts a user can see. Unknown accounts are ignored. */
async function setAccountAccess(db: pg.Pool | pg.PoolClient, userId: number, access: z.infer<typeof accountAccess>) {
  await db.query('UPDATE app_users SET all_accounts = $2, updated_at = now() WHERE id = $1', [userId, access.allAccounts]);
  await db.query('DELETE FROM app_user_accounts WHERE user_id = $1', [userId]);
  if (access.accounts.length) {
    await db.query(
      `INSERT INTO app_user_accounts (user_id, workspace_id, account_user_id)
       SELECT $1, a.workspace_id, a.user_id FROM accounts a
       JOIN unnest($2::text[], $3::text[]) AS g(ws, acct) ON g.ws = a.workspace_id AND g.acct = a.user_id
       ON CONFLICT DO NOTHING`,
      [userId, access.accounts.map((x) => x.workspaceId), access.accounts.map((x) => x.accountId)],
    );
  }
}

/** Replaces a user's community access. Unknown workspace ids are ignored. */
async function setWorkspaceAccess(db: pg.Pool | pg.PoolClient, userId: number, access: z.infer<typeof workspaceAccess>) {
  await db.query('UPDATE app_users SET all_workspaces = $2, updated_at = now() WHERE id = $1', [userId, access.allWorkspaces]);
  await db.query('DELETE FROM app_user_workspaces WHERE user_id = $1', [userId]);
  if (access.workspaceIds.length) {
    await db.query(
      `INSERT INTO app_user_workspaces (user_id, workspace_id) SELECT $1, w.id FROM workspaces w WHERE w.id = ANY($2::text[])`,
      [userId, access.workspaceIds],
    );
  }
}

/** Keeps at least one active admin: true if changing `userId` as described would leave none. */
async function wouldRemoveLastAdmin(userId: number, next: { role?: string; isActive?: boolean; deleted?: boolean }) {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE role = 'admin' AND is_active AND id <> $1) AS others,
            bool_or(id = $1 AND role = 'admin' AND is_active) AS is_admin
     FROM app_users`,
    [userId],
  );
  const losesAdmin = next.deleted || next.isActive === false || (next.role !== undefined && next.role !== 'admin');
  return Boolean(rows[0].is_admin) && losesAdmin && rows[0].others === 0;
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
    const [totals, runs, hourly, failures, size] = await Promise.all([
      pool.query(`
        SELECT (SELECT count(*) FROM messages) AS messages,
               (SELECT count(*) FROM messages WHERE thread_ts IS NOT NULL AND thread_ts <> ts) AS thread_replies,
               (SELECT count(*) FROM messages WHERE captured_at > now() - interval '24 hours') AS messages_24h,
               (SELECT max(captured_at) FROM messages) AS last_ingest_at,
               (SELECT count(*) FROM channels) AS channels,
               (SELECT count(*) FROM channels WHERE is_hidden) AS hidden_channels,
               (SELECT count(*) FROM channels WHERE capture_excluded) AS excluded_channels,
               (SELECT count(*) FROM workspaces) AS workspaces,
               (SELECT count(*) FROM slack_users) AS people,
               (SELECT count(*) FROM accounts) AS accounts,
               (SELECT count(*) FROM collectors) AS collectors,
               (SELECT count(*) FROM collectors WHERE last_seen_at > now() - ${ONLINE_WINDOW} AND status <> 'revoked') AS collectors_online,
               (SELECT count(*) FROM collectors WHERE status = 'paused') AS collectors_paused,
               (SELECT count(*) FROM app_users) AS app_users,
               (SELECT count(*) FROM deleted_messages) AS deleted_messages,
               (SELECT count(*) FROM collector_commands WHERE status IN ('pending', 'delivered')) AS commands_open`),
      pool.query(`SELECT status, count(*) AS n FROM sync_runs WHERE started_at > now() - interval '24 hours' GROUP BY 1`),
      pool.query(`
        SELECT to_char(h, 'YYYY-MM-DD"T"HH24:00:00"Z"') AS hour, COALESCE(x.n, 0) AS messages
        FROM generate_series(date_trunc('hour', now() AT TIME ZONE 'UTC') - interval '47 hours',
                             date_trunc('hour', now() AT TIME ZONE 'UTC'), interval '1 hour') h
        LEFT JOIN (SELECT date_trunc('hour', captured_at AT TIME ZONE 'UTC') AS hr, count(*) AS n
                   FROM messages WHERE captured_at > now() - interval '48 hours' GROUP BY 1) x ON x.hr = h
        ORDER BY h`),
      pool.query(`
        SELECT r.id, r.workspace_id, r.channel_id, c.name AS channel_name, r.error, r.started_at,
               k.label AS collector_label, k.browser
        FROM sync_runs r
        LEFT JOIN channels c ON c.workspace_id = r.workspace_id AND c.id = r.channel_id
        LEFT JOIN collectors k ON k.id = r.collector_id
        WHERE r.status = 'failed' ORDER BY r.started_at DESC LIMIT 8`),
      pool.query('SELECT pg_database_size(current_database()) AS bytes'),
    ]);
    const t = totals.rows[0];
    const runCounts = Object.fromEntries(runs.rows.map((r) => [r.status, r.n]));
    return {
      totals: {
        messages: t.messages,
        threadReplies: t.thread_replies,
        messages24h: t.messages_24h,
        lastIngestAt: t.last_ingest_at,
        channels: t.channels,
        hiddenChannels: t.hidden_channels,
        excludedChannels: t.excluded_channels,
        workspaces: t.workspaces,
        people: t.people,
        accounts: t.accounts,
        collectors: t.collectors,
        collectorsOnline: t.collectors_online,
        collectorsPaused: t.collectors_paused,
        appUsers: t.app_users,
        deletedMessages: t.deleted_messages,
        commandsOpen: t.commands_open,
      },
      runs24h: {
        completed: runCounts.completed ?? 0,
        failed: runCounts.failed ?? 0,
        running: runCounts.running ?? 0,
        cancelled: runCounts.cancelled ?? 0,
      },
      hourly: hourly.rows,
      recentFailures: failures.rows.map((r) => ({
        id: r.id,
        workspaceId: r.workspace_id,
        channelId: r.channel_id,
        channelName: r.channel_name,
        error: r.error,
        startedAt: r.started_at,
        collector: r.collector_label || r.browser,
      })),
      databaseBytes: Number(size.rows[0].bytes),
    };
  });

  // ---------------------------------------------------------------------------
  // File archive
  // ---------------------------------------------------------------------------
  app.get('/files', async () => {
    const [byStatus, blobs, byKind, failures] = await Promise.all([
      pool.query(`SELECT status, count(*) AS n FROM message_files GROUP BY 1`),
      pool.query(`SELECT count(*) AS n, COALESCE(sum(size_bytes), 0) AS bytes FROM file_blobs`),
      pool.query(`
        SELECT COALESCE(f.kind, 'other') AS kind, count(DISTINCT b.sha256) AS files, COALESCE(sum(DISTINCT b.size_bytes), 0) AS bytes
        FROM file_blobs b JOIN message_files f ON f.blob_sha256 = b.sha256 GROUP BY 1 ORDER BY 3 DESC`),
      pool.query(`
        SELECT f.id, f.name, f.kind, f.status, f.attempts, f.last_error, m.workspace_id, m.channel_id, c.name AS channel_name, m.ts, m.sent_at
        FROM message_files f
        JOIN messages m ON m.id = f.message_id
        JOIN channels c ON c.workspace_id = m.workspace_id AND c.id = m.channel_id
        WHERE f.status = 'failed' ORDER BY f.id DESC LIMIT 20`),
    ]);
    const counts = Object.fromEntries(byStatus.rows.map((r) => [r.status, r.n]));
    return {
      storage: fileStore.name,
      maxBytes: config.files.maxBytes,
      counts: { stored: counts.stored ?? 0, pending: counts.pending ?? 0, failed: counts.failed ?? 0, skipped: counts.skipped ?? 0 },
      blobs: blobs.rows[0].n,
      bytes: Number(blobs.rows[0].bytes),
      byKind: byKind.rows.map((r) => ({ kind: r.kind, files: r.files, bytes: Number(r.bytes) })),
      recentFailures: failures.rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        kind: r.kind,
        attempts: r.attempts,
        error: r.last_error,
        workspaceId: r.workspace_id,
        channelId: r.channel_id,
        channelName: r.channel_name,
        ts: r.ts,
        sentAt: r.sent_at,
      })),
    };
  });

  /** Puts failed (or skipped) files back in the download queue, e.g. after raising the size limit. */
  app.post('/files/retry', async (req) => {
    const body = fileRetryBody.parse(req.body);
    const { rowCount } = await pool.query(
      `UPDATE message_files SET status = 'pending', attempts = 0, next_attempt_at = NULL, leased_by = NULL, lease_until = NULL
       WHERE status = $1 AND (download_url IS NOT NULL OR thumb_url IS NOT NULL)`,
      [body.status],
    );
    await audit(req, 'files.retry', body.status, { files: rowCount });
    return { ok: true, queued: rowCount ?? 0 };
  });

  // ---------------------------------------------------------------------------
  // Dashboard users
  // ---------------------------------------------------------------------------
  app.get('/users', async () => {
    const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM app_users u ORDER BY u.role, lower(u.email)`);
    return rows.map(toUser);
  });

  app.post('/users', async (req, reply) => {
    const body = userCreate.parse(req.body);
    const access = workspaceAccess.optional().parse((req.body as { access?: unknown })?.access);
    const acctAccess = accountAccess.optional().parse((req.body as { accountAccess?: unknown })?.accountAccess);
    const hash = await hashPassword(body.password);
    const id = await withTransaction(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO app_users (email, name, role, password_hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING id`,
        [body.email, body.name || null, body.role, hash],
      );
      if (!rows[0]) return null;
      if (access) await setWorkspaceAccess(db, Number(rows[0].id), access);
      if (acctAccess) await setAccountAccess(db, Number(rows[0].id), acctAccess);
      await audit(req, 'user.create', String(rows[0].id), { email: body.email, role: body.role, ...access, ...acctAccess }, db);
      return Number(rows[0].id);
    });
    if (id === null) return reply.code(409).send({ error: 'a user with that email already exists' });
    const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM app_users u WHERE u.id = $1`, [id]);
    return toUser(rows[0]);
  });

  /** Which Slack accounts a user can see (and "view as"). Takes effect on the user's next request. */
  app.put<{ Params: { id: string } }>('/users/:id/accounts', async (req, reply) => {
    const id = Number(req.params.id);
    const access = accountAccess.parse(req.body);
    const found = await withTransaction(async (db) => {
      const { rowCount } = await db.query('SELECT 1 FROM app_users WHERE id = $1 FOR UPDATE', [id]);
      if (!rowCount) return false;
      await setAccountAccess(db, id, access);
      await audit(req, 'user.accounts', String(id), { allAccounts: access.allAccounts, accounts: access.accounts.map((x) => `${x.workspaceId}/${x.accountId}`) }, db);
      return true;
    });
    if (!found) return reply.code(404).send({ error: 'user not found' });
    const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM app_users u WHERE u.id = $1`, [id]);
    return toUser(rows[0]);
  });

  /** Which communities (workspaces) a user can see. Takes effect on the user's next request; no re-login needed. */
  app.put<{ Params: { id: string } }>('/users/:id/workspaces', async (req, reply) => {
    const id = Number(req.params.id);
    const access = workspaceAccess.parse(req.body);
    const found = await withTransaction(async (db) => {
      const { rowCount } = await db.query('SELECT 1 FROM app_users WHERE id = $1 FOR UPDATE', [id]);
      if (!rowCount) return false;
      await setWorkspaceAccess(db, id, access);
      await audit(req, 'user.workspaces', String(id), access, db);
      return true;
    });
    if (!found) return reply.code(404).send({ error: 'user not found' });
    const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM app_users u WHERE u.id = $1`, [id]);
    return toUser(rows[0]);
  });

  app.patch<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const body = userPatch.parse(req.body);
    if (await wouldRemoveLastAdmin(id, body)) return reply.code(400).send({ error: 'there must be at least one active admin' });
    const { rows } = await pool.query(
      `UPDATE app_users SET
         name          = CASE WHEN $2::boolean THEN $3 ELSE name END,
         role          = COALESCE($4::app_role, role),
         is_active     = COALESCE($5, is_active),
         password_hash = COALESCE($6, password_hash),
         updated_at    = now()
       WHERE id = $1 RETURNING *`,
      [id, body.name !== undefined, body.name ?? null, body.role ?? null, body.isActive ?? null, body.password ? await hashPassword(body.password) : null],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'user not found' });
    // Deactivation, role change and password reset all end the user's existing sessions.
    if (body.isActive === false || body.password || body.role) await pool.query('DELETE FROM app_sessions WHERE user_id = $1', [id]);
    await audit(req, 'user.update', String(id), { ...body, password: body.password ? '(reset)' : undefined });
    return toUser(rows[0]);
  });

  app.delete<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (id === req.user!.id) return reply.code(400).send({ error: "you can't delete your own account" });
    if (await wouldRemoveLastAdmin(id, { deleted: true })) return reply.code(400).send({ error: 'there must be at least one active admin' });
    const { rows } = await pool.query('DELETE FROM app_users WHERE id = $1 RETURNING email', [id]);
    if (!rows[0]) return reply.code(404).send({ error: 'user not found' });
    await audit(req, 'user.delete', String(id), { email: rows[0].email });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Collectors (extension installs) + remote commands
  // ---------------------------------------------------------------------------
  app.get('/collectors', async () => {
    const { rows } = await pool.query(`
      SELECT k.*, w.name AS workspace_name, COALESCE(a.display_name, su.display_name) AS account_name,
             COALESCE(a.avatar_url, su.avatar_url) AS account_avatar,
             k.last_seen_at > now() - ${ONLINE_WINDOW} AS online,
             (SELECT count(*) FROM sync_runs r WHERE r.collector_id = k.id) AS run_count,
             (SELECT count(*) FROM sync_runs r WHERE r.collector_id = k.id AND r.status = 'failed'
                AND r.started_at > now() - interval '24 hours') AS failed_24h,
             (SELECT COALESCE(sum(r.messages_received), 0) FROM sync_runs r WHERE r.collector_id = k.id) AS messages_received,
             (SELECT max(r.started_at) FROM sync_runs r WHERE r.collector_id = k.id) AS last_run_at,
             (SELECT count(*) FROM collector_commands cc WHERE cc.collector_id = k.id AND cc.status IN ('pending', 'delivered')) AS open_commands
      FROM collectors k
      LEFT JOIN workspaces w ON w.id = k.workspace_id
      LEFT JOIN accounts a ON a.workspace_id = k.workspace_id AND a.user_id = k.account_user_id
      LEFT JOIN slack_users su ON su.workspace_id = k.workspace_id AND su.id = k.account_user_id
      ORDER BY (k.status = 'revoked'), k.last_seen_at DESC`);
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      browser: r.browser,
      version: r.extension_version,
      status: r.status,
      notes: r.notes,
      workspaceId: r.workspace_id,
      workspaceName: r.workspace_name,
      accountId: r.account_user_id,
      accountName: r.account_name,
      accountAvatar: r.account_avatar,
      online: r.online && r.status !== 'revoked',
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      lastRunAt: r.last_run_at,
      runCount: r.run_count,
      failed24h: r.failed_24h,
      messagesReceived: Number(r.messages_received),
      openCommands: r.open_commands,
    }));
  });

  app.patch<{ Params: { id: string } }>('/collectors/:id', async (req, reply) => {
    const body = collectorPatch.parse(req.body);
    const { rows } = await pool.query(
      `UPDATE collectors SET
         label  = CASE WHEN $2::boolean THEN $3 ELSE label END,
         notes  = CASE WHEN $4::boolean THEN $5 ELSE notes END,
         status = COALESCE($6, status)
       WHERE id = $1 RETURNING id`,
      [req.params.id, body.label !== undefined, body.label || null, body.notes !== undefined, body.notes || null, body.status ?? null],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'collector not found' });
    if (body.status === 'revoked') {
      await pool.query(`UPDATE collector_commands SET status = 'cancelled' WHERE collector_id = $1 AND status = 'pending'`, [req.params.id]);
    }
    await audit(req, body.status ? `collector.${body.status === 'active' ? 'resume' : body.status === 'paused' ? 'pause' : 'revoke'}` : 'collector.update', req.params.id, body);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/collectors/:id', async (req, reply) => {
    const { rowCount } = await pool.query('DELETE FROM collectors WHERE id = $1', [req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: 'collector not found' });
    await audit(req, 'collector.delete', req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/collectors/:id/commands', async (req, reply) => {
    const cmd = commandCreate.parse(req.body);
    const { rows: c } = await pool.query('SELECT status FROM collectors WHERE id = $1', [req.params.id]);
    if (!c[0]) return reply.code(404).send({ error: 'collector not found' });
    if (c[0].status === 'revoked') return reply.code(400).send({ error: 'collector is revoked' });
    const { rows } = await pool.query(
      `INSERT INTO collector_commands (collector_id, type, payload, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.params.id, cmd.type, cmd.payload, req.user!.id],
    );
    await audit(req, `command.${cmd.type}`, req.params.id, cmd.payload);
    return { ok: true, id: Number(rows[0].id) };
  });

  app.get<{ Querystring: { collectorId?: string; limit?: string } }>('/commands', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 500);
    const { rows } = await pool.query(
      `SELECT cc.*, k.label AS collector_label, k.browser, u.email AS created_by_email
       FROM collector_commands cc
       JOIN collectors k ON k.id = cc.collector_id
       LEFT JOIN app_users u ON u.id = cc.created_by
       WHERE ($1::uuid IS NULL OR cc.collector_id = $1)
       ORDER BY cc.created_at DESC LIMIT $2`,
      [req.query.collectorId || null, limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      collectorId: r.collector_id,
      collector: r.collector_label || r.browser,
      type: r.type,
      payload: r.payload,
      status: r.status,
      result: r.result,
      createdBy: r.created_by_email,
      createdAt: r.created_at,
      deliveredAt: r.delivered_at,
      finishedAt: r.finished_at,
    }));
  });

  app.post<{ Params: { id: string } }>('/commands/:id/cancel', async (req, reply) => {
    const { rowCount } = await pool.query(
      `UPDATE collector_commands SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'pending'`,
      [req.params.id],
    );
    if (!rowCount) return reply.code(400).send({ error: 'only pending commands can be cancelled' });
    await audit(req, 'command.cancel', req.params.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Content
  // ---------------------------------------------------------------------------
  app.get('/workspaces', async () => {
    const { rows } = await pool.query(`
      SELECT w.*, (SELECT count(*) FROM messages m WHERE m.workspace_id = w.id) AS message_count,
             (SELECT count(*) FROM channels c WHERE c.workspace_id = w.id) AS channel_count,
             (SELECT min(sent_at) FROM messages m WHERE m.workspace_id = w.id) AS oldest_message_at
      FROM workspaces w ORDER BY w.name NULLS LAST`);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      domain: r.domain,
      iconUrl: r.icon_url,
      retentionDays: r.retention_days,
      messageCount: r.message_count,
      channelCount: r.channel_count,
      oldestMessageAt: r.oldest_message_at,
      createdAt: r.created_at,
    }));
  });

  app.patch<{ Params: { id: string } }>('/workspaces/:id', async (req, reply) => {
    const body = workspacePatch.parse(req.body);
    const result = await withTransaction(async (db) => {
      const { rows } = await db.query(
        `UPDATE workspaces SET
           name = COALESCE($2, name),
           retention_days = CASE WHEN $3::boolean THEN $4 ELSE retention_days END,
           updated_at = now()
         WHERE id = $1 RETURNING retention_days`,
        [req.params.id, body.name ?? null, body.retentionDays !== undefined, body.retentionDays ?? null],
      );
      if (!rows[0]) return null;
      let purged = 0;
      if (rows[0].retention_days) {
        const del = await db.query(
          `DELETE FROM messages WHERE workspace_id = $1 AND sent_at < now() - make_interval(days => $2)`,
          [req.params.id, rows[0].retention_days],
        );
        purged = del.rowCount ?? 0;
      }
      await audit(req, 'workspace.update', req.params.id, { ...body, purged }, db);
      return { purged };
    });
    if (!result) return reply.code(404).send({ error: 'workspace not found' });
    return { ok: true, ...result };
  });

  app.delete<{ Params: { id: string } }>('/workspaces/:id', async (req, reply) => {
    const { rowCount } = await pool.query('DELETE FROM workspaces WHERE id = $1', [req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: 'workspace not found' });
    await pool.query('UPDATE collectors SET workspace_id = NULL, account_user_id = NULL WHERE workspace_id = $1', [req.params.id]);
    await audit(req, 'workspace.delete', req.params.id);
    return { ok: true };
  });

  /** Captured Slack accounts (of one community, or all of them), with their visibility to viewers. */
  app.get<{ Querystring: { workspaceId?: string } }>('/accounts', async (req) => {
    const workspaceId = req.query.workspaceId || null;
    const { rows } = await pool.query(
      `SELECT a.workspace_id, a.user_id, COALESCE(a.display_name, su.display_name) AS name, COALESCE(a.avatar_url, su.avatar_url) AS avatar_url,
              a.is_hidden, a.first_seen_at, a.last_seen_at,
              (SELECT count(*) FROM channel_accounts ca WHERE ca.workspace_id = a.workspace_id AND ca.account_user_id = a.user_id) AS channel_count,
              (SELECT max(ca.last_synced_at) FROM channel_accounts ca WHERE ca.workspace_id = a.workspace_id AND ca.account_user_id = a.user_id) AS last_synced_at,
              EXISTS (SELECT 1 FROM collectors k WHERE k.workspace_id = a.workspace_id AND k.account_user_id = a.user_id
                        AND k.last_seen_at > now() - ${ONLINE_WINDOW}) AS online
       FROM accounts a
       LEFT JOIN slack_users su ON su.workspace_id = a.workspace_id AND su.id = a.user_id
       WHERE ($1::text IS NULL OR a.workspace_id = $1)
       ORDER BY a.workspace_id, lower(COALESCE(a.display_name, su.display_name, a.user_id))`,
      [workspaceId],
    );
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      id: r.user_id,
      name: r.name,
      avatarUrl: r.avatar_url,
      isHidden: r.is_hidden,
      online: r.online,
      channelCount: r.channel_count,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      lastSyncedAt: r.last_synced_at,
    }));
  });

  app.patch<{ Params: { ws: string; id: string } }>('/accounts/:ws/:id', async (req, reply) => {
    const body = accountPatch.parse(req.body);
    const { rowCount } = await pool.query('UPDATE accounts SET is_hidden = $3 WHERE workspace_id = $1 AND user_id = $2', [
      req.params.ws,
      req.params.id,
      body.isHidden,
    ]);
    if (!rowCount) return reply.code(404).send({ error: 'account not found' });
    await audit(req, body.isHidden ? 'account.hide' : 'account.show', `${req.params.ws}/${req.params.id}`);
    return { ok: true };
  });

  app.get<{ Querystring: { workspaceId?: string; q?: string; filter?: string; limit?: string; offset?: string } }>('/channels', async (req, reply) => {
    const { workspaceId, q, filter } = req.query;
    if (!workspaceId) return reply.code(400).send({ error: 'workspaceId is required' });
    // Paged when `limit` is given (infinite scroll); otherwise the full list.
    const limit = req.query.limit ? Math.min(Number(req.query.limit) || 100, 500) : null;
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.type, c.is_hidden, c.capture_excluded, c.reached_start, c.last_synced_at,
              COALESCE(s.n, 0) AS message_count, COALESCE(s.replies, 0) AS reply_count, s.first_at, s.last_at,
              (SELECT count(*) FROM channel_accounts ca WHERE ca.workspace_id = c.workspace_id AND ca.channel_id = c.id) AS account_count
       FROM channels c
       LEFT JOIN (
         SELECT channel_id, count(*) AS n, count(*) FILTER (WHERE thread_ts IS NOT NULL AND thread_ts <> ts) AS replies,
                min(sent_at) AS first_at, max(sent_at) AS last_at
         FROM messages WHERE workspace_id = $1 GROUP BY channel_id
       ) s ON s.channel_id = c.id
       WHERE c.workspace_id = $1
         AND ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%' OR c.id = $2)
         AND ($3::text IS NULL OR ($3 = 'hidden' AND c.is_hidden) OR ($3 = 'excluded' AND c.capture_excluded)
              OR ($3 = 'empty' AND s.n IS NULL) OR ($3 = 'incomplete' AND NOT c.reached_start AND s.n IS NOT NULL))
       ORDER BY message_count DESC, lower(c.name), c.id
       LIMIT $4 OFFSET $5`,
      [workspaceId, q?.trim() || null, filter || null, limit, offset],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      isHidden: r.is_hidden,
      captureExcluded: r.capture_excluded,
      reachedStart: r.reached_start,
      lastSyncedAt: r.last_synced_at,
      messageCount: r.message_count,
      replyCount: r.reply_count,
      firstMessageAt: r.first_at,
      lastMessageAt: r.last_at,
      accountCount: r.account_count,
    }));
  });

  app.patch<{ Params: { ws: string; ch: string } }>('/channels/:ws/:ch', async (req, reply) => {
    const body = channelPatch.parse(req.body);
    const { rowCount } = await pool.query(
      `UPDATE channels SET is_hidden = COALESCE($3, is_hidden), capture_excluded = COALESCE($4, capture_excluded), updated_at = now()
       WHERE workspace_id = $1 AND id = $2`,
      [req.params.ws, req.params.ch, body.isHidden ?? null, body.captureExcluded ?? null],
    );
    if (!rowCount) return reply.code(404).send({ error: 'channel not found' });
    await audit(req, 'channel.update', `${req.params.ws}/${req.params.ch}`, body);
    return { ok: true };
  });

  app.post('/channels/bulk', async (req) => {
    const body = channelBulk.parse(req.body);
    const ids = body.channelIds;
    let affected = 0;
    if (body.action === 'purge') {
      const del = await pool.query('DELETE FROM messages WHERE workspace_id = $1 AND channel_id = ANY($2::text[])', [body.workspaceId, ids]);
      await pool.query(
        `UPDATE channels SET oldest_synced_ts = NULL, newest_synced_ts = NULL, reached_start = false
         WHERE workspace_id = $1 AND id = ANY($2::text[])`,
        [body.workspaceId, ids],
      );
      affected = del.rowCount ?? 0;
    } else {
      const col = body.action === 'hide' || body.action === 'unhide' ? 'is_hidden' : 'capture_excluded';
      const val = body.action === 'hide' || body.action === 'exclude';
      const upd = await pool.query(`UPDATE channels SET ${col} = $3, updated_at = now() WHERE workspace_id = $1 AND id = ANY($2::text[])`, [
        body.workspaceId,
        ids,
        val,
      ]);
      affected = upd.rowCount ?? 0;
    }
    await audit(req, `channel.bulk_${body.action}`, body.workspaceId, { channelIds: ids, affected });
    return { ok: true, affected };
  });

  /** Deletes a conversation's messages (optionally only those before a date). They can be captured again later. */
  app.post<{ Params: { ws: string; ch: string } }>('/channels/:ws/:ch/purge', async (req) => {
    const body = purgeBody.parse(req.body ?? {});
    const del = await pool.query(
      `DELETE FROM messages WHERE workspace_id = $1 AND channel_id = $2 AND ($3::date IS NULL OR sent_at < $3::date)`,
      [req.params.ws, req.params.ch, body.before ?? null],
    );
    if (!body.before) {
      await pool.query(
        `UPDATE channels SET oldest_synced_ts = NULL, newest_synced_ts = NULL, reached_start = false WHERE workspace_id = $1 AND id = $2`,
        [req.params.ws, req.params.ch],
      );
    } else {
      await pool.query('UPDATE channels SET reached_start = false WHERE workspace_id = $1 AND id = $2', [req.params.ws, req.params.ch]);
    }
    await audit(req, 'channel.purge', `${req.params.ws}/${req.params.ch}`, { before: body.before, deleted: del.rowCount });
    return { ok: true, deleted: del.rowCount ?? 0 };
  });

  app.delete<{ Params: { ws: string; ch: string } }>('/channels/:ws/:ch', async (req, reply) => {
    const { rowCount } = await pool.query('DELETE FROM channels WHERE workspace_id = $1 AND id = $2', [req.params.ws, req.params.ch]);
    if (!rowCount) return reply.code(404).send({ error: 'channel not found' });
    await audit(req, 'channel.delete', `${req.params.ws}/${req.params.ch}`);
    return { ok: true };
  });

  /** Deletes one message and remembers it so a later sync doesn't bring it back. */
  app.delete<{ Params: { id: string } }>('/messages/:id', async (req, reply) => {
    const out = await withTransaction(async (db) => {
      const { rows } = await db.query(
        `DELETE FROM messages WHERE id = $1 RETURNING workspace_id, channel_id, ts, user_name, left(text, 200) AS preview`,
        [req.params.id],
      );
      if (!rows[0]) return null;
      const m = rows[0];
      await db.query(
        `INSERT INTO deleted_messages (workspace_id, channel_id, ts, deleted_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [m.workspace_id, m.channel_id, m.ts, req.user!.id],
      );
      // Thread replies go with their parent.
      await db.query(`DELETE FROM messages WHERE workspace_id = $1 AND channel_id = $2 AND thread_ts = $3`, [m.workspace_id, m.channel_id, m.ts]);
      await audit(req, 'message.delete', `${m.workspace_id}/${m.channel_id}/${m.ts}`, { user: m.user_name, preview: m.preview }, db);
      return m;
    });
    if (!out) return reply.code(404).send({ error: 'message not found' });
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
    let lastId = 0;
    let first = true;
    for (;;) {
      const { rows } = await pool.query(
        `SELECT m.id, m.workspace_id, m.channel_id, c.name AS channel_name, c.type AS channel_type, m.ts, m.sent_at, m.thread_ts,
                m.user_id, COALESCE(m.user_name, su.display_name, su.real_name) AS user_name, m.text, m.reply_count, m.is_edited, m.is_bot,
                (SELECT string_agg(r.emoji || ':' || r.count, ' ') FROM message_reactions r WHERE r.message_id = m.id) AS reactions,
                (SELECT string_agg(f.url, ' ') FROM message_files f WHERE f.message_id = m.id) AS files
         FROM messages m
         JOIN channels c ON c.workspace_id = m.workspace_id AND c.id = m.channel_id
         LEFT JOIN slack_users su ON su.workspace_id = m.workspace_id AND su.id = m.user_id
         WHERE m.workspace_id = $1 AND ($2::text IS NULL OR m.channel_id = $2)
           AND ($3::date IS NULL OR m.sent_at >= $3::date) AND ($4::date IS NULL OR m.sent_at < $4::date + 1)
           AND m.id > $5
         ORDER BY m.id LIMIT 5000`,
        [q.workspaceId, q.channelId || null, q.from ?? null, q.to ?? null, lastId],
      );
      if (!rows.length) break;
      lastId = Number(rows.at(-1).id);
      const chunk =
        q.format === 'csv'
          ? rows.map((r) => cols.map((c) => csvCell(c === 'sent_at' ? new Date(r[c]).toISOString() : r[c])).join(',')).join('\n') + '\n'
          : rows
              .map((r) => {
                const { id: _id, ...rest } = r;
                const s = `${first ? '' : ',\n'}${JSON.stringify(rest)}`;
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
    const { rows } = await pool.query(
      `SELECT * FROM audit_log
       WHERE ($1::text IS NULL OR action LIKE $1 || '%') AND ($2::bigint IS NULL OR id < $2)
       ORDER BY id DESC LIMIT $3`,
      [req.query.action || null, req.query.before || null, limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      userEmail: r.user_email,
      action: r.action,
      target: r.target,
      details: r.details,
      createdAt: r.created_at,
    }));
  });
}
