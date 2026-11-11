import type { FastifyInstance } from 'fastify';
import type { Document } from 'mongodb';
import { z } from 'zod';
import { accountScopeFilter, and, requireUser, viewableAccountId, visibleFilter } from '../auth.js';
import { col } from '../db/mongo.js';
import { hydrateMessages, lookupMap } from '../services/messages.js';

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

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Term {
  pattern: string;
  negate: boolean;
}

/**
 * Web-search style query: words (all must appear, in any order), "exact phrase", -exclude, and `or` between
 * alternatives. Each word also matches inside longer words, URLs and code, like the old substring search did.
 */
export function parseQuery(q: string): Term[][] {
  const groups: Term[][] = [[]];
  for (const m of q.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
    const quoted = m[2] !== undefined;
    const text = (quoted ? m[2] : m[4]).trim();
    const negate = (quoted ? m[1] : m[3]) === '-';
    if (!text) continue;
    if (!quoted && !negate && text.toLowerCase() === 'or') {
      if (groups.at(-1)!.length) groups.push([]);
      continue;
    }
    groups.at(-1)!.push({ pattern: escapeRegex(text), negate });
  }
  return groups.filter((g) => g.some((t) => !t.negate));
}

const fieldMatch = (p: string) => [{ text: { $regex: p, $options: 'i' } }, { user_name: { $regex: p, $options: 'i' } }];

function textFilter(groups: Term[][]): Document {
  const group = (terms: Term[]) => ({
    $and: terms.map((t) => (t.negate ? { $nor: fieldMatch(t.pattern) } : { $or: fieldMatch(t.pattern) })),
  });
  return groups.length === 1 ? group(groups[0]) : { $or: groups.map(group) };
}

/** Relevance: words in the text count twice as much as in the sender's name; the whole query as a phrase adds a bonus. */
function scoreExpr(groups: Term[][], whole: string): Document {
  const hit = (field: string, p: string) => ({ $cond: [{ $regexMatch: { input: { $ifNull: [`$${field}`, ''] }, regex: p, options: 'i' } }, 1, 0] });
  const parts: Document[] = [{ $multiply: [hit('text', escapeRegex(whole)), 3] }];
  for (const t of groups.flat().filter((x) => !x.negate)) parts.push({ $multiply: [hit('text', t.pattern), 2] }, hit('user_name', t.pattern));
  return { $add: parts };
}

/** End of a bare date for `to` means "through the end of that day". */
const toBound = (to: string) => (to.length === 10 ? { $lt: new Date(Date.parse(`${to}T00:00:00Z`) + 86400_000) } : { $lte: new Date(to) });

/** Full-text style search over messages, with filters and facet counts. */
export async function searchRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireUser);

  app.get('/search', async (req) => {
    const q = searchQuery.parse(req.query);
    const text = q.q.trim();
    const groups = text ? parseQuery(text) : [];

    const filters: Document[] = [await visibleFilter(req)];
    if (text) filters.push(groups.length ? textFilter(groups) : { _id: { $exists: false } });
    if (q.workspaceId) filters.push({ workspace_id: q.workspaceId });
    const accountId = await viewableAccountId(req, q.accountId);
    if (accountId) filters.push(await accountScopeFilter(accountId));
    if (q.channelIds.length) filters.push({ channel_id: { $in: q.channelIds } });
    if (q.userIds.length) filters.push({ user_id: { $in: q.userIds } });
    if (q.channelTypes.length) {
      const chans = await col.channels
        .find({ type: { $in: q.channelTypes }, ...(q.workspaceId ? { workspace_id: q.workspaceId } : {}) }, { projection: { workspace_id: 1, id: 1 } })
        .toArray();
      const byWs = new Map<string, string[]>();
      for (const c of chans) byWs.set(c.workspace_id, [...(byWs.get(c.workspace_id) ?? []), c.id]);
      filters.push(byWs.size ? { $or: [...byWs].map(([ws, ids]) => ({ workspace_id: ws, channel_id: { $in: ids } })) } : { _id: { $exists: false } });
    }
    if (q.from || q.to) filters.push({ sent_at: { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? toBound(q.to) : {}) } });
    if (q.hasFiles) filters.push(q.hasFiles === 'true' ? { has_files: true } : { has_files: { $ne: true } });
    if (q.hasReactions === 'true') filters.push({ 'reactions.0': { $exists: true } });
    if (q.hasReactions === 'false') filters.push({ 'reactions.0': { $exists: false } });

    const byRelevance = q.sort === 'relevance' && groups.length > 0;
    const sort = q.sort === 'oldest' ? { sent_at: 1 } : byRelevance ? { rank: -1, sent_at: -1 } : { sent_at: -1 };

    const [out] = await col.messages
      .aggregate([
        { $match: and(...filters) },
        {
          $facet: {
            // Only the sort keys go through the sort, so a broad match doesn't hold whole messages in memory.
            page: [
              { $project: { id: 1, sent_at: 1, ...(byRelevance ? { rank: scoreExpr(groups, text) } : {}) } },
              { $sort: { ...sort, id: -1 } },
              { $skip: (q.page - 1) * q.pageSize },
              { $limit: q.pageSize },
            ],
            total: [{ $count: 'n' }],
            channels: [
              { $group: { _id: { ws: '$workspace_id', ch: '$channel_id' }, n: { $sum: 1 } } },
              { $sort: { n: -1 } },
              { $limit: 20 },
            ],
            users: [
              { $group: { _id: { ws: '$workspace_id', u: '$user_id' }, name: { $max: '$user_name' }, n: { $sum: 1 } } },
              { $group: { _id: '$_id.u', ws: { $first: '$_id.ws' }, name: { $max: '$name' }, n: { $sum: '$n' } } },
              { $sort: { n: -1 } },
              { $limit: 20 },
            ],
            months: [{ $group: { _id: { $dateToString: { date: '$sent_at', format: '%Y-%m' } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }],
          },
        },
      ])
      .toArray();

    const ids = out.page.map((p: Document) => p.id);
    const rank = new Map(out.page.map((p: Document) => [p.id, p.rank ?? 0]));
    const docs = await col.messages.find({ id: { $in: ids } }).toArray();
    docs.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    for (const d of docs) d.rank = rank.get(d.id);

    const [channels, users] = await Promise.all([
      lookupMap('channels', out.channels.map((c: Document) => ({ ws: c._id.ws, id: c._id.ch }))),
      lookupMap('slackUsers', out.users.filter((u: Document) => u._id).map((u: Document) => ({ ws: u.ws, id: u._id }))),
    ]);

    return {
      total: out.total[0]?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
      results: await hydrateMessages(docs),
      facets: {
        channels: out.channels.map((c: Document) => {
          const ch = channels.get(`${c._id.ws}\u0000${c._id.ch}`);
          return { workspaceId: c._id.ws, id: c._id.ch, name: ch?.name ?? c._id.ch, type: ch?.type ?? 'unknown', count: c.n };
        }),
        users: out.users.map((u: Document) => {
          const su = u._id ? users.get(`${u.ws}\u0000${u._id}`) : undefined;
          return { id: u._id ?? null, name: u.name ?? su?.display_name ?? su?.real_name ?? null, count: u.n };
        }),
        months: out.months.map((m: Document) => ({ month: m._id, count: m.n })),
      },
    };
  });
}
