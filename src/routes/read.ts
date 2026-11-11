import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Document } from 'mongodb';
import { z } from 'zod';
import { accountVisible, and, canSeeWorkspace, requireUser, viewableAccountId, visibleChannelFilter, visibleFilter, workspaceFilter } from '../auth.js';
import { col } from '../db/mongo.js';
import { hydrateMessages, lookupMap, topLevelFilter } from '../services/messages.js';

const tsParam = z.string().regex(/^\d{9,11}\.\d{1,6}$/);

const messagesQuery = z.object({
  before: tsParam.optional(),
  after: tsParam.optional(),
  around: tsParam.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** A collector counts as online if it reported within this window (the extension heartbeats every minute). */
export const ONLINE_MS = 3 * 60_000;
export const isOnline = (lastSeen: Date | null | undefined) => Boolean(lastSeen && lastSeen.getTime() > Date.now() - ONLINE_MS);

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Display name for a conversation. Slack names a DM after the *other* person, so two accounts see the
 * same DM under different names: use the selected account's view, else join every account's view
 * ("Alice, Bob" for the DM between Alice and Bob).
 */
function channelName(c: Document, links: Document[], accountId: string | null): string {
  const own = accountId ? links.find((l) => l.account_user_id === accountId)?.channel_name : null;
  if (own) return own;
  if (c.type === 'dm') {
    const names = [...new Set(links.map((l) => l.channel_name).filter(Boolean))].sort(byText);
    if (names.length) return names.join(', ');
  }
  return c.name;
}

interface PersonLookup {
  byName: Map<string, Document[]>;
}

/** Slack users of one workspace indexed by lower-cased display and real name. */
async function peopleIndex(workspaceId: string): Promise<PersonLookup> {
  const users = await col.slackUsers
    .find({ workspace_id: workspaceId }, { projection: { _id: 0, id: 1, display_name: 1, real_name: 1, avatar_url: 1 } })
    .toArray();
  const byName = new Map<string, Document[]>();
  for (const u of users) {
    for (const n of new Set([lower(u.display_name), lower(u.real_name)])) if (n) byName.set(n, [...(byName.get(n) ?? []), u]);
  }
  return { byName };
}

/**
 * People a DM or group DM is named after, with their Slack photo when we have one.
 * The sidebar name is already "Kamil" or "Kamil, renato"; match each part to slack_users.
 */
function channelPeers(c: Document, name: string, people: PersonLookup) {
  if (c.type !== 'dm' && c.type !== 'group_dm') return [];
  const seen = new Set<string>();
  const out: { name: string; avatarUrl: string | null }[] = [];
  for (const raw of name.split(',')) {
    const part = raw.trim();
    if (!part || seen.has(part.toLowerCase())) continue;
    seen.add(part.toLowerCase());
    const match = [...(people.byName.get(part.toLowerCase()) ?? [])].sort(
      (a, b) => Number(!a.avatar_url) - Number(!b.avatar_url) || byText(a.id, b.id),
    )[0];
    out.push({ name: match?.display_name ?? match?.real_name ?? part, avatarUrl: match?.avatar_url ?? null });
  }
  return out.sort((a, b) => byText(a.name, b.name));
}

/** Accounts (with names) for channel_accounts links, leaving out accounts this user may not see. */
async function accountCredits(req: FastifyRequest, links: Document[]) {
  const pairs = links.map((l) => ({ ws: l.workspace_id, id: l.account_user_id }));
  const [accounts, users] = await Promise.all([
    pairs.length ? col.accounts.find({ $or: pairs.map((p) => ({ workspace_id: p.ws, user_id: p.id })) }).toArray() : [],
    lookupMap('slackUsers', pairs),
  ]);
  const acc = new Map(accounts.map((a) => [`${a.workspace_id}\u0000${a.user_id}`, a]));
  return (l: Document) => {
    const a = acc.get(`${l.workspace_id}\u0000${l.account_user_id}`);
    if (!a || !accountVisible(req, a as never)) return null;
    const su = users.get(`${a.workspace_id}\u0000${a.user_id}`);
    return { id: a.user_id as string, name: (a.display_name ?? su?.display_name ?? a.user_id) as string };
  };
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) m.set(key(it), [...(m.get(key(it)) ?? []), it]);
  return m;
}

/** Read endpoints for the frontend. */
export async function readRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireUser);

  app.get('/workspaces', async (req) => {
    const [workspaces, msgStats, chStats] = await Promise.all([
      col.workspaces.find(workspaceFilter(req, 'id')).toArray(),
      col.messages.aggregate([{ $group: { _id: '$workspace_id', n: { $sum: 1 }, last: { $max: '$sent_at' } } }]).toArray(),
      col.channels.aggregate([{ $group: { _id: '$workspace_id', n: { $sum: 1 } } }]).toArray(),
    ]);
    const msg = new Map(msgStats.map((s) => [s._id, s]));
    const ch = new Map(chStats.map((s) => [s._id, s.n]));
    // Named workspaces first, by name; then by id.
    workspaces.sort((a, b) => Number(a.name == null) - Number(b.name == null) || byText(a.name ?? '', b.name ?? '') || byText(a.id, b.id));
    return workspaces.map((w) => ({
      id: w.id,
      name: w.name ?? null,
      domain: w.domain ?? null,
      iconUrl: w.icon_url ?? null,
      channelCount: ch.get(w.id) ?? 0,
      messageCount: msg.get(w.id)?.n ?? 0,
      lastMessageAt: msg.get(w.id)?.last ?? null,
    }));
  });

  /** Slack accounts that have captured data, with the browsers (collectors) they captured from. */
  app.get<{ Querystring: { workspaceId?: string } }>('/accounts', async (req) => {
    const wsFilter = and(req.query.workspaceId ? { workspace_id: req.query.workspaceId } : {}, workspaceFilter(req));
    const accounts = (await col.accounts.find(wsFilter).toArray()).filter((a) => accountVisible(req, a as never));
    if (!accounts.length) return [];
    const wsIds = [...new Set(accounts.map((a) => a.workspace_id as string))];
    const [workspaces, users, links, firstCaptured, collectors] = await Promise.all([
      col.workspaces.find({ id: { $in: wsIds } }).toArray(),
      lookupMap('slackUsers', accounts.map((a) => ({ ws: a.workspace_id, id: a.user_id }))),
      col.channelAccounts
        .aggregate([
          { $match: { workspace_id: { $in: wsIds } } },
          {
            $group: {
              _id: { ws: '$workspace_id', a: '$account_user_id' },
              channels: { $sum: 1 },
              captured: { $sum: { $cond: [{ $gt: ['$messages_captured', 0] }, 1, 0] } },
              lastSynced: { $max: '$last_synced_at' },
            },
          },
        ])
        .toArray(),
      col.messages
        .aggregate([
          { $match: { workspace_id: { $in: wsIds }, captured_by: { $in: accounts.map((a) => a.user_id) } } },
          { $group: { _id: { ws: '$workspace_id', a: '$captured_by' }, n: { $sum: 1 } } },
        ])
        .toArray(),
      col.collectors.find({ workspace_id: { $in: wsIds } }).sort({ last_seen_at: -1 }).toArray(),
    ]);
    const k = (ws: string, a: string) => `${ws}\u0000${a}`;
    const wsName = new Map(workspaces.map((w) => [w.id, w.name ?? null]));
    const linkStats = new Map(links.map((l) => [k(l._id.ws, l._id.a), l]));
    const firstBy = new Map(firstCaptured.map((f) => [k(f._id.ws, f._id.a), f.n]));
    const collectorsBy = groupBy(collectors, (c) => k(c.workspace_id, c.account_user_id));

    const rows = accounts.map((a) => {
      const su = users.get(k(a.workspace_id, a.user_id));
      const ls = linkStats.get(k(a.workspace_id, a.user_id));
      const ks = (collectorsBy.get(k(a.workspace_id, a.user_id)) ?? []).map((c) => ({
        id: c.id,
        label: c.label ?? null,
        browser: c.browser ?? null,
        version: c.extension_version ?? null,
        lastSeenAt: c.last_seen_at,
        online: isOnline(c.last_seen_at),
      }));
      return {
        workspaceId: a.workspace_id,
        workspaceName: wsName.get(a.workspace_id) ?? null,
        id: a.user_id,
        name: a.display_name ?? su?.display_name ?? null,
        avatarUrl: a.avatar_url ?? su?.avatar_url ?? null,
        isHidden: Boolean(a.is_hidden),
        firstSeenAt: a.first_seen_at,
        lastSeenAt: a.last_seen_at,
        lastSyncedAt: ls?.lastSynced ?? null,
        channelCount: ls?.channels ?? 0,
        capturedChannelCount: ls?.captured ?? 0,
        messagesFirstCaptured: firstBy.get(k(a.workspace_id, a.user_id)) ?? 0,
        collectors: ks,
        online: ks.some((c) => c.online),
      };
    });
    return rows.sort((x, y) => byText(lower(x.name ?? x.id), lower(y.name ?? y.id)));
  });

  app.get<{ Querystring: { workspaceId?: string; accountId?: string } }>('/channels', async (req, reply) => {
    const { workspaceId } = req.query;
    if (!workspaceId) return reply.code(400).send({ error: 'workspaceId is required' });
    const accountId = await viewableAccountId(req, req.query.accountId);
    let channels = await col.channels.find(and({ workspace_id: workspaceId }, visibleChannelFilter(req))).toArray();
    const links = await col.channelAccounts.find({ workspace_id: workspaceId }).toArray();
    const linksBy = groupBy(links, (l) => l.channel_id);
    // With accountId: only conversations that account has in its sidebar or has captured.
    if (accountId) channels = channels.filter((c) => (linksBy.get(c.id) ?? []).some((l) => l.account_user_id === accountId));

    const reads = await col.channelReads.find({ app_user_id: req.user!.id, workspace_id: workspaceId, last_read_ts: { $ne: null } }).toArray();
    const cursor = {
      $ifNull: [{ $let: { vars: { hit: { $first: { $filter: { input: { $literal: reads.map((r) => ({ c: r.channel_id, ts: r.last_read_ts })) }, cond: { $eq: ['$$this.c', '$channel_id'] } } } } }, in: '$$hit.ts' } }, ''],
    };
    const [stats, people, credit] = await Promise.all([
      col.messages
        .aggregate([
          { $match: { workspace_id: workspaceId } },
          {
            $group: {
              _id: '$channel_id',
              n: { $sum: 1 },
              first: { $min: '$sent_at' },
              last: { $max: '$sent_at' },
              // No read cursor means the whole history is unread.
              unread: { $sum: { $cond: [{ $gt: ['$ts', cursor] }, 1, 0] } },
            },
          },
        ])
        .toArray(),
      peopleIndex(workspaceId),
      accountCredits(req, links),
    ]);
    const statsBy = new Map(stats.map((s) => [s._id, s]));

    const rows = channels.map((c) => {
      const cl = linksBy.get(c.id) ?? [];
      const name = channelName(c, cl, accountId);
      const s = statsBy.get(c.id);
      return {
        id: c.id,
        name,
        type: c.type,
        topic: c.topic ?? null,
        isArchived: Boolean(c.is_archived),
        isHidden: Boolean(c.is_hidden),
        reachedStart: Boolean(c.reached_start),
        lastSyncedAt: c.last_synced_at ?? null,
        messageCount: s?.n ?? 0,
        unreadCount: s?.unread ?? 0,
        peers: channelPeers(c, name, people),
        firstMessageAt: s?.first ?? null,
        lastMessageAt: s?.last ?? null,
        accounts: cl.map(credit).filter((x) => x !== null).sort((a, b) => byText(a.name, b.name)),
        _sort: lower(c.name),
      };
    });
    return rows.sort((a, b) => byText(a._sort, b._sort)).map(({ _sort, ...r }) => r);
  });

  app.get<{ Params: { workspaceId: string; channelId: string }; Querystring: { accountId?: string } }>(
    '/channels/:workspaceId/:channelId',
    async (req, reply) => {
      const { workspaceId, channelId } = req.params;
      const c = await col.channels.findOne(and({ workspace_id: workspaceId, id: channelId }, visibleChannelFilter(req)));
      if (!c) return reply.code(404).send({ error: 'channel not found' });
      const accountId = await viewableAccountId(req, req.query.accountId);
      const f = { workspace_id: workspaceId, channel_id: channelId };
      const [links, stats, members, people] = await Promise.all([
        col.channelAccounts.find(f).toArray(),
        col.messages.aggregate([{ $match: f }, { $group: { _id: null, n: { $sum: 1 }, first: { $min: '$sent_at' } } }]).toArray(),
        col.messages.distinct('user_id', f),
        peopleIndex(workspaceId),
      ]);
      const credit = await accountCredits(req, links);
      const name = channelName(c, links, accountId);
      return {
        id: c.id,
        name,
        type: c.type,
        topic: c.topic ?? null,
        reachedStart: Boolean(c.reached_start),
        lastSyncedAt: c.last_synced_at ?? null,
        messageCount: stats[0]?.n ?? 0,
        memberCount: members.filter((u) => u != null).length,
        firstMessageAt: stats[0]?.first ?? null,
        peers: channelPeers(c, name, people),
        accounts: links.map(credit).filter((x) => x !== null).sort((a, b) => byText(a.name, b.name)),
      };
    },
  );

  /** Remember that this dashboard user has seen messages through `ts` (or the newest message we hold). */
  app.post<{ Params: { workspaceId: string; channelId: string } }>('/channels/:workspaceId/:channelId/read', async (req, reply) => {
    const { workspaceId, channelId } = req.params;
    const { ts } = z.object({ ts: tsParam.optional() }).parse(req.body ?? {});
    const visible = await col.channels.findOne(and({ workspace_id: workspaceId, id: channelId }, visibleChannelFilter(req)), { projection: { _id: 1 } });
    if (!visible) return reply.code(404).send({ error: 'channel not found' });

    const cursor =
      ts ??
      (await col.messages.find({ workspace_id: workspaceId, channel_id: channelId }, { projection: { ts: 1 } }).sort({ ts: -1 }).limit(1).next())?.ts;
    if (!cursor) return { ok: true };

    // The cursor only moves forward.
    await col.channelReads.updateOne(
      { app_user_id: req.user!.id, workspace_id: workspaceId, channel_id: channelId },
      [{ $set: { last_read_ts: { $max: ['$last_read_ts', { $literal: cursor }] }, updated_at: '$$NOW' } }],
      { upsert: true },
    );
    return { ok: true };
  });

  /**
   * Paged message history for one channel, always returned oldest → newest.
   * - no cursor: the latest `limit` messages
   * - before=ts: older page; after=ts: newer page; around=ts: a window centred on that message
   */
  app.get<{ Params: { workspaceId: string; channelId: string } }>('/channels/:workspaceId/:channelId/messages', async (req) => {
    const { workspaceId, channelId } = req.params;
    const q = messagesQuery.parse(req.query);
    const base = and({ workspace_id: workspaceId, channel_id: channelId }, await visibleFilter(req), topLevelFilter);

    const older = async (cursor: string | null, n: number, inclusive = false) => {
      const f = cursor ? and(base, { ts: { [inclusive ? '$lte' : '$lt']: cursor } }) : base;
      const rows = await col.messages.find(f).sort({ ts: -1 }).limit(n + 1).toArray();
      return { rows: rows.slice(0, n).reverse(), more: rows.length > n };
    };
    const newer = async (cursor: string, n: number) => {
      const rows = await col.messages.find(and(base, { ts: { $gt: cursor } })).sort({ ts: 1 }).limit(n + 1).toArray();
      return { rows: rows.slice(0, n), more: rows.length > n };
    };

    if (q.around) {
      const half = Math.ceil(q.limit / 2);
      const [a, b] = await Promise.all([older(q.around, half, true), newer(q.around, half)]);
      return { messages: await hydrateMessages([...a.rows, ...b.rows]), hasOlder: a.more, hasNewer: b.more };
    }
    if (q.after) {
      const b = await newer(q.after, q.limit);
      return { messages: await hydrateMessages(b.rows), hasOlder: true, hasNewer: b.more };
    }
    const a = await older(q.before ?? null, q.limit);
    return { messages: await hydrateMessages(a.rows), hasOlder: a.more, hasNewer: Boolean(q.before) };
  });

  /** Replies we hold for a thread. */
  app.get<{ Params: { workspaceId: string; channelId: string; ts: string } }>('/channels/:workspaceId/:channelId/threads/:ts', async (req) => {
    const { workspaceId, channelId, ts } = req.params;
    const rows = await col.messages
      .find(and({ workspace_id: workspaceId, channel_id: channelId, thread_ts: ts, ts: { $ne: ts } }, await visibleFilter(req)))
      .sort({ ts: 1 })
      .toArray();
    return hydrateMessages(rows);
  });

  app.get<{ Querystring: { workspaceId?: string; q?: string; limit?: string } }>('/users', async (req, reply) => {
    const { workspaceId, q } = req.query;
    if (!workspaceId) return reply.code(400).send({ error: 'workspaceId is required' });
    if (!canSeeWorkspace(req, workspaceId)) return [];
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    const filter: Document = { workspace_id: workspaceId };
    if (q) filter.display_name = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const [users, counts] = await Promise.all([
      col.slackUsers.find(filter).toArray(),
      col.messages.aggregate([{ $match: { workspace_id: workspaceId } }, { $group: { _id: '$user_id', n: { $sum: 1 } } }]).toArray(),
    ]);
    const n = new Map(counts.map((c) => [c._id, c.n]));
    return users
      .map((u) => ({
        id: u.id,
        displayName: u.display_name ?? null,
        avatarUrl: u.avatar_url ?? null,
        isBot: Boolean(u.is_bot),
        firstSeenAt: u.first_seen_at ?? null,
        lastSeenAt: u.last_seen_at ?? null,
        messageCount: n.get(u.id) ?? 0,
      }))
      .sort((a, b) => b.messageCount - a.messageCount || byText(a.displayName ?? '', b.displayName ?? ''))
      .slice(0, limit);
  });

  /** Every extension install that has reported in, newest activity first. */
  app.get('/collectors', async (req) => {
    const collectors = await col.collectors.find(workspaceFilter(req)).sort({ last_seen_at: -1 }).toArray();
    const pairs = collectors.filter((k) => k.workspace_id && k.account_user_id).map((k) => ({ ws: k.workspace_id, id: k.account_user_id }));
    const [workspaces, accounts, users, runs] = await Promise.all([
      col.workspaces.find({ id: { $in: [...new Set(collectors.map((k) => k.workspace_id))] } }).toArray(),
      pairs.length ? col.accounts.find({ $or: pairs.map((p) => ({ workspace_id: p.ws, user_id: p.id })) }).toArray() : [],
      lookupMap('slackUsers', pairs),
      col.syncRuns.aggregate([{ $group: { _id: '$collector_id', n: { $sum: 1 }, received: { $sum: '$messages_received' } } }]).toArray(),
    ]);
    const wsName = new Map(workspaces.map((w) => [w.id, w.name ?? null]));
    const acc = new Map(accounts.map((a) => [`${a.workspace_id}\u0000${a.user_id}`, a]));
    const runBy = new Map(runs.map((r) => [r._id, r]));
    return collectors
      .map((k) => ({ k, a: acc.get(`${k.workspace_id}\u0000${k.account_user_id}`) }))
      .filter(({ a }) => accountVisible(req, a as never))
      .map(({ k, a }) => ({
        id: k.id,
        label: k.label ?? null,
        browser: k.browser ?? null,
        version: k.extension_version ?? null,
        workspaceId: k.workspace_id ?? null,
        workspaceName: wsName.get(k.workspace_id) ?? null,
        accountId: k.account_user_id ?? null,
        accountName: a?.display_name ?? users.get(`${k.workspace_id}\u0000${k.account_user_id}`)?.display_name ?? null,
        online: isOnline(k.last_seen_at),
        firstSeenAt: k.first_seen_at,
        lastSeenAt: k.last_seen_at,
        runCount: runBy.get(k.id)?.n ?? 0,
        messagesReceived: runBy.get(k.id)?.received ?? 0,
      }));
  });

  app.get<{ Querystring: { limit?: string; workspaceId?: string; accountId?: string } }>('/sync-runs', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const accountId = await viewableAccountId(req, req.query.accountId);
    const filter = and(req.query.workspaceId ? { workspace_id: req.query.workspaceId } : {}, accountId ? { account_user_id: accountId } : {}, workspaceFilter(req));
    // Over-fetch a little: runs of accounts this viewer may not see are dropped below.
    const runs = await col.syncRuns.find(filter).sort({ started_at: -1 }).limit(limit * 2).toArray();
    const pairs = runs.filter((r) => r.account_user_id).map((r) => ({ ws: r.workspace_id, id: r.account_user_id }));
    const [workspaces, channels, accounts, users, collectors] = await Promise.all([
      col.workspaces.find({ id: { $in: [...new Set(runs.map((r) => r.workspace_id))] } }).toArray(),
      lookupMap('channels', runs.filter((r) => r.channel_id).map((r) => ({ ws: r.workspace_id, id: r.channel_id }))),
      pairs.length ? col.accounts.find({ $or: pairs.map((p) => ({ workspace_id: p.ws, user_id: p.id })) }).toArray() : [],
      lookupMap('slackUsers', pairs),
      col.collectors.find({ id: { $in: [...new Set(runs.map((r) => r.collector_id).filter(Boolean))] } }).toArray(),
    ]);
    const wsName = new Map(workspaces.map((w) => [w.id, w.name ?? null]));
    const acc = new Map(accounts.map((a) => [`${a.workspace_id}\u0000${a.user_id}`, a]));
    const kBy = new Map(collectors.map((k) => [k.id, k]));
    return runs
      .map((r) => ({ r, a: acc.get(`${r.workspace_id}\u0000${r.account_user_id}`) }))
      .filter(({ r, a }) => wsName.has(r.workspace_id) && accountVisible(req, a as never))
      .slice(0, limit)
      .map(({ r, a }) => {
        const k = r.collector_id ? kBy.get(r.collector_id) : undefined;
        return {
          id: r.id,
          workspaceId: r.workspace_id,
          workspaceName: wsName.get(r.workspace_id) ?? null,
          channelId: r.channel_id ?? null,
          channelName: r.channel_id ? (channels.get(`${r.workspace_id}\u0000${r.channel_id}`)?.name ?? null) : null,
          accountId: r.account_user_id ?? null,
          accountName: a?.display_name ?? users.get(`${r.workspace_id}\u0000${r.account_user_id}`)?.display_name ?? null,
          collectorId: r.collector_id ?? null,
          collectorLabel: k?.label ?? null,
          browser: k?.browser ?? null,
          trigger: r.trigger,
          status: r.status,
          rangeFrom: r.range_from ?? null,
          oldestSeenAt: r.oldest_seen_at ?? null,
          messagesReceived: r.messages_received ?? 0,
          error: r.error ?? null,
          startedAt: r.started_at,
          finishedAt: r.finished_at ?? null,
        };
      });
  });
}
