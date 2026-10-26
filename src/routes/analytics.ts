import { requireUser, viewableAccountId, visibleSql } from '../auth.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { accountScopeSql } from '../services/messageSql.js';

const isoDate = z.string().date();

const analyticsQuery = z.object({
  workspaceId: z.string().optional(),
  accountId: z.string().optional(),
  channelIds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : [])),
  from: isoDate.optional(),
  to: isoDate.optional(),
  tz: z
    .string()
    .default('UTC')
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'unknown time zone'),
});

const DAY_MS = 86_400_000;
const toIsoDate = (d: Date) => d.toISOString().slice(0, 10);

/** Aggregates for the analytics dashboard. Dates are interpreted in the caller's time zone. */
export async function analyticsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireUser);

  app.get('/analytics/overview', async (req) => {
    const q = analyticsQuery.parse(req.query);
    const to = q.to ?? toIsoDate(new Date());
    const from = q.from ?? toIsoDate(new Date(Date.parse(to) - 29 * DAY_MS));
    const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
    const prevTo = toIsoDate(new Date(Date.parse(from) - DAY_MS));
    const prevFrom = toIsoDate(new Date(Date.parse(prevTo) - (days - 1) * DAY_MS));

    // $1 tz, $2 from, $3 to, $4 workspace, $5 channel ids, $6 account
    const scope = `
      ($4::text IS NULL OR m.workspace_id = $4)
      AND (cardinality($5::text[]) = 0 OR m.channel_id = ANY($5::text[]))
      AND ($6::text IS NULL OR ${accountScopeSql('$6')})`;
    const range = `m.sent_at >= ($2::date)::timestamp AT TIME ZONE $1
                   AND m.sent_at < ($3::date + 1)::timestamp AT TIME ZONE $1`;
    const where = `WHERE ${scope} AND ${range} AND ${visibleSql(req, 'm.workspace_id', 'm.channel_id')}`;
    const accountId = await viewableAccountId(req, q.accountId);
    const params = [q.tz, from, to, q.workspaceId ?? null, q.channelIds, accountId];

    const [kpis, prev, daily, channels, users, heatmap, reactions, types] = await Promise.all([
      pool.query(
        `SELECT count(*) AS messages,
                count(DISTINCT m.workspace_id || '/' || m.channel_id) AS active_channels,
                count(DISTINCT m.user_id) AS active_users,
                count(*) FILTER (WHERE m.has_files) AS messages_with_files,
                count(*) FILTER (WHERE m.reply_count > 0) AS threads,
                COALESCE(sum(m.reply_count), 0) AS replies,
                (SELECT COALESCE(sum(r.count), 0) FROM message_reactions r JOIN messages m ON m.id = r.message_id ${where}) AS reactions
         FROM messages m ${where}`,
        params,
      ),
      pool.query(
        `SELECT count(*) AS messages, count(DISTINCT m.user_id) AS active_users FROM messages m ${where}`,
        [q.tz, prevFrom, prevTo, q.workspaceId ?? null, q.channelIds, accountId],
      ),
      pool.query(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(x.messages, 0) AS messages, COALESCE(x.users, 0) AS users
         FROM generate_series($2::date, $3::date, interval '1 day') d
         LEFT JOIN (
           SELECT (m.sent_at AT TIME ZONE $1)::date AS day, count(*) AS messages, count(DISTINCT m.user_id) AS users
           FROM messages m ${where} GROUP BY 1
         ) x ON x.day = d::date
         ORDER BY d`,
        params,
      ),
      pool.query(
        `SELECT m.workspace_id, m.channel_id AS id, c.name, c.type, count(*) AS messages, count(DISTINCT m.user_id) AS users
         FROM messages m JOIN channels c ON c.workspace_id = m.workspace_id AND c.id = m.channel_id
         ${where} GROUP BY 1, 2, 3, 4 ORDER BY messages DESC LIMIT 15`,
        params,
      ),
      pool.query(
        `SELECT m.user_id AS id, max(COALESCE(m.user_name, u.display_name, u.real_name)) AS name,
                count(*) AS messages, count(DISTINCT m.channel_id) AS channels
         FROM messages m
         LEFT JOIN slack_users u ON u.workspace_id = m.workspace_id AND u.id = m.user_id
         ${where} AND m.user_id IS NOT NULL GROUP BY 1 ORDER BY messages DESC LIMIT 15`,
        params,
      ),
      pool.query(
        `SELECT extract(isodow FROM m.sent_at AT TIME ZONE $1)::int AS dow,
                extract(hour FROM m.sent_at AT TIME ZONE $1)::int AS hour,
                count(*) AS messages
         FROM messages m ${where} GROUP BY 1, 2`,
        params,
      ),
      pool.query(
        `SELECT r.emoji, sum(r.count) AS count
         FROM message_reactions r JOIN messages m ON m.id = r.message_id
         ${where} GROUP BY 1 ORDER BY count DESC LIMIT 12`,
        params,
      ),
      pool.query(
        `SELECT c.type, count(*) AS messages
         FROM messages m JOIN channels c ON c.workspace_id = m.workspace_id AND c.id = m.channel_id
         ${where} GROUP BY 1 ORDER BY messages DESC`,
        params,
      ),
    ]);

    const k = kpis.rows[0];
    return {
      range: { from, to, days, tz: q.tz, previous: { from: prevFrom, to: prevTo } },
      kpis: {
        messages: k.messages,
        activeChannels: k.active_channels,
        activeUsers: k.active_users,
        messagesWithFiles: k.messages_with_files,
        threads: k.threads,
        replies: Number(k.replies),
        reactions: Number(k.reactions),
        avgPerDay: days > 0 ? k.messages / days : 0,
        previousMessages: prev.rows[0].messages,
        previousActiveUsers: prev.rows[0].active_users,
      },
      daily: daily.rows,
      topChannels: channels.rows.map((r) => ({
        workspaceId: r.workspace_id,
        id: r.id,
        name: r.name,
        type: r.type,
        messages: r.messages,
        users: r.users,
      })),
      topUsers: users.rows,
      heatmap: heatmap.rows,
      topReactions: reactions.rows.map((r) => ({ emoji: r.emoji, count: Number(r.count) })),
      byType: types.rows,
    };
  });
}
