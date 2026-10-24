import { isAdmin, requireUser, viewableAccountId, visibleSql } from '../auth.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { MESSAGE_COLUMNS, MESSAGE_FROM, accountScopeSql, toMessage } from '../services/messageSql.js';

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []));

const searchQuery = z.object({
  q: z.string().max(500).optional().default(''),
  workspaceId: z.string().optional(),
  accountId: z.string().optional(),
  channelIds: csv,
  userIds: csv,
  channelTypes: csv,
  from: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  hasFiles: z.enum(['true', 'false']).optional(),
  hasReactions: z.enum(['true', 'false']).optional(),
  sort: z.enum(['relevance', 'newest', 'oldest']).default('relevance'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Full-text + substring search over messages, with filters and facet counts. */
export async function searchRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireUser);

  app.get('/search', async (req) => {
    const q = searchQuery.parse(req.query);
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };

    const where: string[] = [];
    let rankExpr = '0::real';
    const text = q.q.trim();
    if (text) {
      const tsq = `websearch_to_tsquery('simple', ${p(text)})`;
      // Full-text match covers whole words; ILIKE catches partial words, URLs, code fragments.
      where.push(`(m.search_vector @@ ${tsq} OR m.text ILIKE '%' || ${p(escapeLike(text))} || '%')`);
      rankExpr = `ts_rank(m.search_vector, ${tsq})`;
    }
    if (q.workspaceId) where.push(`m.workspace_id = ${p(q.workspaceId)}`);
    if (!isAdmin(req)) where.push(visibleSql(req, 'm.workspace_id', 'm.channel_id'));
    const accountId = await viewableAccountId(req, q.accountId);
    if (accountId) where.push(accountScopeSql(p(accountId)));
    if (q.channelIds.length) where.push(`m.channel_id = ANY(${p(q.channelIds)}::text[])`);
    if (q.userIds.length) where.push(`m.user_id = ANY(${p(q.userIds)}::text[])`);
    if (q.channelTypes.length) where.push(`c.type = ANY(${p(q.channelTypes)}::conversation_type[])`);
    if (q.from) where.push(`m.sent_at >= ${p(q.from)}::timestamptz`);
    // A bare date for `to` means "through the end of that day".
    if (q.to) where.push(q.to.length === 10 ? `m.sent_at < ${p(q.to)}::date + 1` : `m.sent_at <= ${p(q.to)}::timestamptz`);
    if (q.hasFiles) where.push(`m.has_files = ${p(q.hasFiles === 'true')}`);
    if (q.hasReactions === 'true') where.push('EXISTS (SELECT 1 FROM message_reactions r WHERE r.message_id = m.id)');
    if (q.hasReactions === 'false') where.push('NOT EXISTS (SELECT 1 FROM message_reactions r WHERE r.message_id = m.id)');

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order =
      q.sort === 'newest'
        ? 'm.sent_at DESC'
        : q.sort === 'oldest'
          ? 'm.sent_at ASC'
          : text
            ? 'rank DESC, m.sent_at DESC'
            : 'm.sent_at DESC';

    const filterParams = [...params];
    const limitSql = `LIMIT ${p(q.pageSize)} OFFSET ${p((q.page - 1) * q.pageSize)}`;

    const [results, total, byChannel, byUser, byMonth] = await Promise.all([
      pool.query(`SELECT ${MESSAGE_COLUMNS}, ${rankExpr} AS rank ${MESSAGE_FROM} ${whereSql} ORDER BY ${order} ${limitSql}`, params),
      pool.query(`SELECT count(*) AS n ${MESSAGE_FROM} ${whereSql}`, filterParams),
      pool.query(
        `SELECT m.workspace_id, m.channel_id AS id, c.name, c.type, count(*) AS n ${MESSAGE_FROM} ${whereSql}
         GROUP BY 1, 2, 3, 4 ORDER BY n DESC LIMIT 20`,
        filterParams,
      ),
      pool.query(
        `SELECT m.user_id AS id, max(m.user_name) AS name, count(*) AS n ${MESSAGE_FROM} ${whereSql}
         GROUP BY 1 ORDER BY n DESC LIMIT 20`,
        filterParams,
      ),
      pool.query(
        `SELECT to_char(date_trunc('month', m.sent_at), 'YYYY-MM') AS month, count(*) AS n ${MESSAGE_FROM} ${whereSql}
         GROUP BY 1 ORDER BY 1`,
        filterParams,
      ),
    ]);

    return {
      total: total.rows[0].n,
      page: q.page,
      pageSize: q.pageSize,
      results: results.rows.map(toMessage),
      facets: {
        channels: byChannel.rows.map((r) => ({ workspaceId: r.workspace_id, id: r.id, name: r.name, type: r.type, count: r.n })),
        users: byUser.rows.map((r) => ({ id: r.id, name: r.name, count: r.n })),
        months: byMonth.rows.map((r) => ({ month: r.month, count: r.n })),
      },
    };
  });
}
