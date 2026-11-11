import type { FastifyInstance } from 'fastify';
import type { Document } from 'mongodb';
import { z } from 'zod';
import { accountScopeFilter, and, requireUser, viewableAccountId, visibleFilter } from '../auth.js';
import { col } from '../db/mongo.js';
import { lookupMap } from '../services/messages.js';

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

/** How far `tz` is ahead of UTC at instant `t`, in ms. */
function tzOffset(t: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}

/** The instant a calendar day starts in `tz` (handles DST). */
export function zonedMidnight(date: string, tz: string): Date {
  const guess = Date.parse(`${date}T00:00:00Z`);
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz);
  return new Date(t);
}

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
    const tz = q.tz;

    const accountId = await viewableAccountId(req, q.accountId);
    const scope = and(
      q.workspaceId ? { workspace_id: q.workspaceId } : {},
      q.channelIds.length ? { channel_id: { $in: q.channelIds } } : {},
      accountId ? await accountScopeFilter(accountId) : {},
      await visibleFilter(req),
    );
    const range = (a: string, b: string) => ({
      sent_at: { $gte: zonedMidnight(a, tz), $lt: zonedMidnight(toIsoDate(new Date(Date.parse(b) + DAY_MS)), tz) },
    });
    const match = { $match: and(scope, range(from, to)) };
    const distinctUsers = (by: Document) => [
      { $group: { _id: { ...by, u: '$user_id' }, n: { $sum: 1 } } },
      { $group: { _id: Object.fromEntries(Object.keys(by).map((k) => [k, `$_id.${k}`])), messages: { $sum: '$n' }, users: { $sum: { $cond: [{ $eq: ['$_id.u', null] }, 0, 1] } } } },
    ];

    const [[f], [prev]] = await Promise.all([
      col.messages
        .aggregate([
          match,
          {
            $facet: {
              kpis: [
                {
                  $group: {
                    _id: null,
                    messages: { $sum: 1 },
                    withFiles: { $sum: { $cond: [{ $eq: ['$has_files', true] }, 1, 0] } },
                    threads: { $sum: { $cond: [{ $gt: ['$reply_count', 0] }, 1, 0] } },
                    replies: { $sum: { $ifNull: ['$reply_count', 0] } },
                    reactions: { $sum: { $sum: { $ifNull: ['$reactions.count', []] } } },
                  },
                },
              ],
              channels: [{ $group: { _id: { ws: '$workspace_id', ch: '$channel_id' } } }, { $count: 'n' }],
              users: [{ $match: { user_id: { $ne: null } } }, { $group: { _id: '$user_id' } }, { $count: 'n' }],
              daily: distinctUsers({ day: { $dateToString: { date: '$sent_at', format: '%Y-%m-%d', timezone: tz } } }),
              topChannels: [...distinctUsers({ ws: '$workspace_id', ch: '$channel_id' }), { $sort: { messages: -1 } }, { $limit: 15 }],
              topUsers: [
                { $match: { user_id: { $ne: null } } },
                // One row per person per conversation, so the second group counts their distinct conversations.
                { $group: { _id: { u: '$user_id', ws: '$workspace_id', c: '$channel_id' }, ws: { $first: '$workspace_id' }, name: { $max: '$user_name' }, n: { $sum: 1 } } },
                { $group: { _id: '$_id.u', ws: { $first: '$ws' }, name: { $max: '$name' }, messages: { $sum: '$n' }, channels: { $sum: 1 } } },
                { $sort: { messages: -1 } },
                { $limit: 15 },
              ],
              heatmap: [
                { $group: { _id: { dow: { $isoDayOfWeek: { date: '$sent_at', timezone: tz } }, hour: { $hour: { date: '$sent_at', timezone: tz } } }, messages: { $sum: 1 } } },
              ],
              reactions: [
                { $unwind: '$reactions' },
                { $group: { _id: '$reactions.emoji', count: { $sum: '$reactions.count' } } },
                { $sort: { count: -1 } },
                { $limit: 12 },
              ],
              byChannel: [{ $group: { _id: { ws: '$workspace_id', ch: '$channel_id' }, n: { $sum: 1 } } }],
            },
          },
        ])
        .toArray(),
      col.messages
        .aggregate([
          { $match: and(scope, range(prevFrom, prevTo)) },
          {
            $facet: {
              messages: [{ $count: 'n' }],
              users: [{ $match: { user_id: { $ne: null } } }, { $group: { _id: '$user_id' } }, { $count: 'n' }],
            },
          },
        ])
        .toArray(),
    ]);

    // Channel names and types (top channels, messages by conversation type) and people's names.
    const chPairs = (f.byChannel as Document[]).map((c) => ({ ws: c._id.ws, id: c._id.ch }));
    const [channels, people] = await Promise.all([
      lookupMap('channels', chPairs),
      lookupMap('slackUsers', (f.topUsers as Document[]).map((u) => ({ ws: u.ws, id: u._id }))),
    ]);
    const chan = (ws: string, ch: string) => channels.get(`${ws}\u0000${ch}`);
    const byType = new Map<string, number>();
    for (const c of f.byChannel as Document[]) {
      const type = chan(c._id.ws, c._id.ch)?.type ?? 'unknown';
      byType.set(type, (byType.get(type) ?? 0) + c.n);
    }
    const dailyBy = new Map((f.daily as Document[]).map((d) => [d._id.day, d]));
    const daily = Array.from({ length: days }, (_, i) => {
      const day = toIsoDate(new Date(Date.parse(from) + i * DAY_MS));
      return { day, messages: dailyBy.get(day)?.messages ?? 0, users: dailyBy.get(day)?.users ?? 0 };
    });

    const k = f.kpis[0] ?? { messages: 0, withFiles: 0, threads: 0, replies: 0, reactions: 0 };
    return {
      range: { from, to, days, tz, previous: { from: prevFrom, to: prevTo } },
      kpis: {
        messages: k.messages,
        activeChannels: f.channels[0]?.n ?? 0,
        activeUsers: f.users[0]?.n ?? 0,
        messagesWithFiles: k.withFiles,
        threads: k.threads,
        replies: k.replies,
        reactions: k.reactions,
        avgPerDay: days > 0 ? k.messages / days : 0,
        previousMessages: prev.messages[0]?.n ?? 0,
        previousActiveUsers: prev.users[0]?.n ?? 0,
      },
      daily,
      topChannels: (f.topChannels as Document[]).map((c) => ({
        workspaceId: c._id.ws,
        id: c._id.ch,
        name: chan(c._id.ws, c._id.ch)?.name ?? c._id.ch,
        type: chan(c._id.ws, c._id.ch)?.type ?? 'unknown',
        messages: c.messages,
        users: c.users,
      })),
      topUsers: (f.topUsers as Document[]).map((u) => {
        const su = people.get(`${u.ws}\u0000${u._id}`);
        return { id: u._id, name: u.name ?? su?.display_name ?? su?.real_name ?? null, messages: u.messages, channels: u.channels };
      }),
      heatmap: (f.heatmap as Document[]).map((h) => ({ dow: h._id.dow, hour: h._id.hour, messages: h.messages })),
      topReactions: (f.reactions as Document[]).map((r) => ({ emoji: r._id, count: r.count })),
      byType: [...byType].map(([type, messages]) => ({ type, messages })).sort((a, b) => b.messages - a.messages),
    };
  });
}
