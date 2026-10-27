import { accountVisibleSql, requireUser, viewableAccountId, visibleSql, workspaceSql } from '../auth.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { MESSAGE_COLUMNS, MESSAGE_FROM, toMessage } from '../services/messageSql.js';

const tsParam = z.string().regex(/^\d{9,11}\.\d{1,6}$/);

const messagesQuery = z.object({
  before: tsParam.optional(),
  after: tsParam.optional(),
  around: tsParam.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** A collector counts as online if it reported within this window (the extension heartbeats every minute). */
const ONLINE_WINDOW = `interval '3 minutes'`;

/**
 * Display name for a conversation. Slack names a DM after the *other* person, so two accounts see the
 * same DM under different names: use the selected account's view, else join every account's view
 * ("Alice, Bob" for the DM between Alice and Bob). `c` = channels, `acct` = placeholder for account id or null.
 */
const channelNameSql = (acct: string) => `
  COALESCE(
    (SELECT ca.channel_name FROM channel_accounts ca
      WHERE ca.workspace_id = c.workspace_id AND ca.channel_id = c.id AND ca.account_user_id = ${acct}::text),
    CASE WHEN c.type = 'dm' THEN
      (SELECT string_agg(DISTINCT ca.channel_name, ', ') FROM channel_accounts ca
        WHERE ca.workspace_id = c.workspace_id AND ca.channel_id = c.id AND ca.channel_name IS NOT NULL)
    END,
    c.name)`;

/**
 * People a DM or group DM is named after, with their Slack photo when we have one.
 * The sidebar name is already "Kamil" or "Kamil, renato"; match each part to slack_users.
 */
const channelPeersSql = (acct: string) => `
  CASE WHEN c.type IN ('dm', 'group_dm') THEN COALESCE((
    SELECT json_agg(json_build_object('name', p.name, 'avatarUrl', p.avatar_url) ORDER BY p.name)
    FROM (
      SELECT DISTINCT ON (lower(btrim(part)))
             COALESCE(su.display_name, su.real_name, btrim(part)) AS name,
             su.avatar_url
      FROM unnest(string_to_array(${channelNameSql(acct)}, ',')) AS part
      LEFT JOIN slack_users su
        ON su.workspace_id = c.workspace_id
       AND (lower(su.display_name) = lower(btrim(part)) OR lower(COALESCE(su.real_name, '')) = lower(btrim(part)))
      WHERE btrim(part) <> ''
      ORDER BY lower(btrim(part)), (su.avatar_url IS NULL), su.id
    ) p
  ), '[]'::json) ELSE '[]'::json END`;

/** Messages this dashboard user has not opened yet. No read cursor means the whole history is unread. */
const unreadCountSql = (userParam: string) => `
  (SELECT count(*) FROM messages m
   WHERE m.workspace_id = c.workspace_id AND m.channel_id = c.id
     AND NOT EXISTS (
       SELECT 1 FROM channel_reads cr
       WHERE cr.app_user_id = ${userParam}::bigint
         AND cr.workspace_id = c.workspace_id AND cr.channel_id = c.id
         AND cr.last_read_ts IS NOT NULL
         AND m.ts::numeric <= cr.last_read_ts::numeric))`;

/** Accounts that can see a conversation, as [{ id, name }]. Accounts hidden by an admin are left out for viewers. */
const channelAccountsSql = (req: FastifyRequest) => `
  COALESCE((SELECT json_agg(json_build_object('id', a.user_id, 'name', COALESCE(a.display_name, su.display_name, a.user_id))
                            ORDER BY COALESCE(a.display_name, su.display_name, a.user_id))
            FROM channel_accounts ca
            JOIN accounts a ON a.workspace_id = ca.workspace_id AND a.user_id = ca.account_user_id
            LEFT JOIN slack_users su ON su.workspace_id = a.workspace_id AND su.id = a.user_id
            WHERE ca.workspace_id = c.workspace_id AND ca.channel_id = c.id AND ${accountVisibleSql(req)}), '[]'::json)`;

/** Read endpoints for the frontend. */
export async function readRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireUser);

  app.get('/workspaces', async (req) => {
    const { rows } = await pool.query(`
      SELECT w.id, w.name, w.domain, w.icon_url,
             (SELECT count(*) FROM channels c WHERE c.workspace_id = w.id) AS channel_count,
             (SELECT count(*) FROM messages m WHERE m.workspace_id = w.id) AS message_count,
             (SELECT max(sent_at) FROM messages m WHERE m.workspace_id = w.id) AS last_message_at
      FROM workspaces w WHERE ${workspaceSql(req, 'w.id')} ORDER BY w.name NULLS LAST, w.id`);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      domain: r.domain,
      iconUrl: r.icon_url,
      channelCount: r.channel_count,
      messageCount: r.message_count,
      lastMessageAt: r.last_message_at,
    }));
  });

  /** Slack accounts that have captured data, with the browsers (collectors) they captured from. */
  app.get<{ Querystring: { workspaceId?: string } }>('/accounts', async (req) => {
    const { rows } = await pool.query(
      `SELECT a.workspace_id, w.name AS workspace_name, a.user_id,
              COALESCE(a.display_name, su.display_name) AS name,
              COALESCE(a.avatar_url, su.avatar_url) AS avatar_url,
              a.first_seen_at, a.last_seen_at, a.is_hidden,
              (SELECT count(*) FROM channel_accounts ca
                WHERE ca.workspace_id = a.workspace_id AND ca.account_user_id = a.user_id) AS channel_count,
              (SELECT count(*) FROM channel_accounts ca
                WHERE ca.workspace_id = a.workspace_id AND ca.account_user_id = a.user_id AND ca.messages_captured > 0) AS captured_channel_count,
              (SELECT count(*) FROM messages m
                WHERE m.workspace_id = a.workspace_id AND m.captured_by = a.user_id) AS messages_first_captured,
              (SELECT max(ca.last_synced_at) FROM channel_accounts ca
                WHERE ca.workspace_id = a.workspace_id AND ca.account_user_id = a.user_id) AS last_synced_at,
              COALESCE((SELECT json_agg(json_build_object(
                          'id', k.id, 'label', k.label, 'browser', k.browser, 'version', k.extension_version,
                          'lastSeenAt', k.last_seen_at, 'online', k.last_seen_at > now() - ${ONLINE_WINDOW})
                        ORDER BY k.last_seen_at DESC)
                        FROM collectors k WHERE k.workspace_id = a.workspace_id AND k.account_user_id = a.user_id), '[]'::json) AS collectors
       FROM accounts a
       JOIN workspaces w ON w.id = a.workspace_id
       LEFT JOIN slack_users su ON su.workspace_id = a.workspace_id AND su.id = a.user_id
       WHERE ($1::text IS NULL OR a.workspace_id = $1) AND ${workspaceSql(req, 'a.workspace_id')} AND ${accountVisibleSql(req)}
       ORDER BY lower(COALESCE(a.display_name, su.display_name, a.user_id))`,
      [req.query.workspaceId || null],
    );
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      workspaceName: r.workspace_name,
      id: r.user_id,
      name: r.name,
      avatarUrl: r.avatar_url,
      isHidden: r.is_hidden,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      lastSyncedAt: r.last_synced_at,
      channelCount: r.channel_count,
      capturedChannelCount: r.captured_channel_count,
      messagesFirstCaptured: r.messages_first_captured,
      collectors: r.collectors,
      online: (r.collectors as { online: boolean }[]).some((k) => k.online),
    }));
  });

  app.get<{ Querystring: { workspaceId?: string; accountId?: string } }>('/channels', async (req, reply) => {
    const { workspaceId } = req.query;
    if (!workspaceId) return reply.code(400).send({ error: 'workspaceId is required' });
    const accountId = await viewableAccountId(req, req.query.accountId);
    // With accountId: only conversations that account has in its sidebar or has captured.
    const { rows } = await pool.query(
      `SELECT c.id, ${channelNameSql('$2')} AS name, c.type, c.topic, c.is_archived, c.is_hidden, c.reached_start, c.last_synced_at,
              COALESCE(s.message_count, 0) AS message_count, s.first_message_at, s.last_message_at,
              ${unreadCountSql('$3')} AS unread_count,
              ${channelPeersSql('$2')} AS peers,
              ${channelAccountsSql(req)} AS accounts
       FROM channels c
       LEFT JOIN (
         SELECT channel_id, count(*) AS message_count, min(sent_at) AS first_message_at, max(sent_at) AS last_message_at
         FROM messages WHERE workspace_id = $1 GROUP BY channel_id
       ) s ON s.channel_id = c.id
       WHERE c.workspace_id = $1 AND ${visibleSql(req, 'c.workspace_id', 'c.id')}
         AND ($2::text IS NULL OR EXISTS (
               SELECT 1 FROM channel_accounts ca
               WHERE ca.workspace_id = c.workspace_id AND ca.channel_id = c.id AND ca.account_user_id = $2))
       ORDER BY lower(c.name)`,
      [workspaceId, accountId, req.user!.id],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      topic: r.topic,
      isArchived: r.is_archived,
      isHidden: r.is_hidden,
      reachedStart: r.reached_start,
      lastSyncedAt: r.last_synced_at,
      messageCount: r.message_count,
      unreadCount: Number(r.unread_count),
      peers: r.peers ?? [],
      firstMessageAt: r.first_message_at,
      lastMessageAt: r.last_message_at,
      accounts: r.accounts,
    }));
  });

  app.get<{ Params: { workspaceId: string; channelId: string }; Querystring: { accountId?: string } }>(
    '/channels/:workspaceId/:channelId',
    async (req, reply) => {
      const { workspaceId, channelId } = req.params;
      const { rows } = await pool.query(
        `SELECT c.id, ${channelNameSql('$3')} AS name, c.type, ${channelAccountsSql(req)} AS accounts,
                ${channelPeersSql('$3')} AS peers, c.topic, c.reached_start, c.last_synced_at,
                (SELECT count(*) FROM messages m WHERE m.workspace_id = c.workspace_id AND m.channel_id = c.id) AS message_count,
                (SELECT count(DISTINCT user_id) FROM messages m WHERE m.workspace_id = c.workspace_id AND m.channel_id = c.id) AS member_count,
                (SELECT min(sent_at) FROM messages m WHERE m.workspace_id = c.workspace_id AND m.channel_id = c.id) AS first_message_at
         FROM channels c WHERE c.workspace_id = $1 AND c.id = $2 AND ${visibleSql(req, 'c.workspace_id', 'c.id')}`,
        [workspaceId, channelId, await viewableAccountId(req, req.query.accountId)],
      );
      if (!rows[0]) return reply.code(404).send({ error: 'channel not found' });
      const r = rows[0];
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        topic: r.topic,
        reachedStart: r.reached_start,
        lastSyncedAt: r.last_synced_at,
        messageCount: r.message_count,
        memberCount: r.member_count,
        firstMessageAt: r.first_message_at,
        peers: r.peers ?? [],
        accounts: r.accounts,
      };
    },
  );

  /** Remember that this dashboard user has seen messages through `ts` (or the newest message we hold). */
  app.post<{ Params: { workspaceId: string; channelId: string } }>(
    '/channels/:workspaceId/:channelId/read',
    async (req, reply) => {
      const { workspaceId, channelId } = req.params;
      const { ts } = z.object({ ts: tsParam.optional() }).parse(req.body ?? {});
      const visible = await pool.query(
        `SELECT 1 FROM channels c WHERE c.workspace_id = $1 AND c.id = $2 AND ${visibleSql(req, 'c.workspace_id', 'c.id')}`,
        [workspaceId, channelId],
      );
      if (!visible.rows[0]) return reply.code(404).send({ error: 'channel not found' });

      const cursor = ts ?? (
        await pool.query<{ ts: string | null }>(
          'SELECT max(ts) AS ts FROM messages WHERE workspace_id = $1 AND channel_id = $2',
          [workspaceId, channelId],
        )
      ).rows[0]?.ts;
      if (!cursor) return { ok: true };

      await pool.query(
        `INSERT INTO channel_reads (app_user_id, workspace_id, channel_id, last_read_ts)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (app_user_id, workspace_id, channel_id) DO UPDATE
           SET last_read_ts = CASE
                 WHEN channel_reads.last_read_ts IS NULL OR EXCLUDED.last_read_ts::numeric > channel_reads.last_read_ts::numeric
                 THEN EXCLUDED.last_read_ts ELSE channel_reads.last_read_ts END,
               updated_at = now()`,
        [req.user!.id, workspaceId, channelId, cursor],
      );
      return { ok: true };
    },
  );

  /**
   * Paged message history for one channel, always returned oldest → newest.
   * - no cursor: the latest `limit` messages
   * - before=ts: older page; after=ts: newer page; around=ts: a window centred on that message
   */
  app.get<{ Params: { workspaceId: string; channelId: string } }>(
    '/channels/:workspaceId/:channelId/messages',
    async (req) => {
      const { workspaceId, channelId } = req.params;
      const q = messagesQuery.parse(req.query);
      // Thread replies live in the thread panel; only top-level messages (and replies also sent to the channel) go here.
      const base = `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM} WHERE m.workspace_id = $1 AND m.channel_id = $2
        AND ${visibleSql(req, 'm.workspace_id', 'm.channel_id')}
        AND (m.thread_ts IS NULL OR m.thread_ts = m.ts OR m.subtype = 'thread_broadcast')`;

      const older = async (cursor: string | null, n: number, inclusive = false) => {
        const cond = cursor ? ` AND m.ts ${inclusive ? '<=' : '<'} $3` : '';
        const params = cursor ? [workspaceId, channelId, cursor, n + 1] : [workspaceId, channelId, n + 1];
        const { rows } = await pool.query(`${base}${cond} ORDER BY m.ts DESC LIMIT $${params.length}`, params);
        return { rows: rows.slice(0, n).reverse(), more: rows.length > n };
      };
      const newer = async (cursor: string, n: number) => {
        const { rows } = await pool.query(`${base} AND m.ts > $3 ORDER BY m.ts ASC LIMIT $4`, [
          workspaceId,
          channelId,
          cursor,
          n + 1,
        ]);
        return { rows: rows.slice(0, n), more: rows.length > n };
      };

      if (q.around) {
        const half = Math.ceil(q.limit / 2);
        const [a, b] = await Promise.all([older(q.around, half, true), newer(q.around, half)]);
        return { messages: [...a.rows, ...b.rows].map(toMessage), hasOlder: a.more, hasNewer: b.more };
      }
      if (q.after) {
        const b = await newer(q.after, q.limit);
        return { messages: b.rows.map(toMessage), hasOlder: true, hasNewer: b.more };
      }
      const a = await older(q.before ?? null, q.limit);
      return { messages: a.rows.map(toMessage), hasOlder: a.more, hasNewer: Boolean(q.before) };
    },
  );

  /** Replies we hold for a thread (populated once thread capture lands; see requirements.md #12). */
  app.get<{ Params: { workspaceId: string; channelId: string; ts: string } }>(
    '/channels/:workspaceId/:channelId/threads/:ts',
    async (req) => {
      const { workspaceId, channelId, ts } = req.params;
      const { rows } = await pool.query(
        `SELECT ${MESSAGE_COLUMNS} ${MESSAGE_FROM}
         WHERE m.workspace_id = $1 AND m.channel_id = $2 AND m.thread_ts = $3 AND m.ts <> $3
           AND ${visibleSql(req, 'm.workspace_id', 'm.channel_id')}
         ORDER BY m.ts`,
        [workspaceId, channelId, ts],
      );
      return rows.map(toMessage);
    },
  );

  app.get<{ Querystring: { workspaceId?: string; q?: string; limit?: string } }>('/users', async (req, reply) => {
    const { workspaceId, q } = req.query;
    if (!workspaceId) return reply.code(400).send({ error: 'workspaceId is required' });
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    const { rows } = await pool.query(
      `SELECT u.id, u.display_name, u.avatar_url, u.is_bot, u.first_seen_at, u.last_seen_at,
              count(m.id) AS message_count
       FROM slack_users u
       LEFT JOIN messages m ON m.workspace_id = u.workspace_id AND m.user_id = u.id
       WHERE u.workspace_id = $1 AND ${workspaceSql(req, 'u.workspace_id')} AND ($2::text IS NULL OR u.display_name ILIKE '%' || $2 || '%')
       GROUP BY u.workspace_id, u.id
       ORDER BY message_count DESC, u.display_name
       LIMIT $3`,
      [workspaceId, q || null, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      isBot: r.is_bot,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      messageCount: r.message_count,
    }));
  });

  /** Every extension install that has reported in, newest activity first. */
  app.get('/collectors', async (req) => {
    const { rows } = await pool.query(
      `SELECT k.*, w.name AS workspace_name, COALESCE(a.display_name, su.display_name) AS account_name,
              k.last_seen_at > now() - ${ONLINE_WINDOW} AS online,
              (SELECT count(*) FROM sync_runs r WHERE r.collector_id = k.id) AS run_count,
              (SELECT COALESCE(sum(r.messages_received), 0) FROM sync_runs r WHERE r.collector_id = k.id) AS messages_received
       FROM collectors k
       LEFT JOIN workspaces w ON w.id = k.workspace_id
       LEFT JOIN accounts a ON a.workspace_id = k.workspace_id AND a.user_id = k.account_user_id
       LEFT JOIN slack_users su ON su.workspace_id = k.workspace_id AND su.id = k.account_user_id
       WHERE ${workspaceSql(req, 'k.workspace_id')} AND ${accountVisibleSql(req)}
       ORDER BY k.last_seen_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      browser: r.browser,
      version: r.extension_version,
      workspaceId: r.workspace_id,
      workspaceName: r.workspace_name,
      accountId: r.account_user_id,
      accountName: r.account_name,
      online: r.online,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      runCount: r.run_count,
      messagesReceived: Number(r.messages_received),
    }));
  });

  app.get<{ Querystring: { limit?: string; workspaceId?: string; accountId?: string } }>('/sync-runs', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const { rows } = await pool.query(
      `SELECT r.*, c.name AS channel_name, w.name AS workspace_name,
              COALESCE(a.display_name, su.display_name) AS account_name, k.label AS collector_label, k.browser
       FROM sync_runs r
       JOIN workspaces w ON w.id = r.workspace_id
       LEFT JOIN channels c ON c.workspace_id = r.workspace_id AND c.id = r.channel_id
       LEFT JOIN accounts a ON a.workspace_id = r.workspace_id AND a.user_id = r.account_user_id
       LEFT JOIN slack_users su ON su.workspace_id = r.workspace_id AND su.id = r.account_user_id
       LEFT JOIN collectors k ON k.id = r.collector_id
       WHERE ($2::text IS NULL OR r.workspace_id = $2) AND ($3::text IS NULL OR r.account_user_id = $3)
         AND ${workspaceSql(req, 'r.workspace_id')} AND ${accountVisibleSql(req)}
       ORDER BY r.started_at DESC LIMIT $1`,
      [limit, req.query.workspaceId || null, await viewableAccountId(req, req.query.accountId)],
    );
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      workspaceName: r.workspace_name,
      channelId: r.channel_id,
      channelName: r.channel_name,
      accountId: r.account_user_id,
      accountName: r.account_name,
      collectorId: r.collector_id,
      collectorLabel: r.collector_label,
      browser: r.browser,
      trigger: r.trigger,
      status: r.status,
      rangeFrom: r.range_from,
      oldestSeenAt: r.oldest_seen_at,
      messagesReceived: r.messages_received,
      error: r.error,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
  });
}
