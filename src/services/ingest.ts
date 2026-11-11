import type { AnyBulkWriteOperation, Document } from 'mongodb';
import { col, isDuplicateKey, lit, nextId, upsertRetry } from '../db/mongo.js';
import { upsertMessageFile } from './files.js';
import type { ChannelInput, IngestMessagesBody, MessageInput, SourceInput, WorkspaceInput } from '../schemas.js';

export function tsToDate(ts: string): Date {
  return new Date(Math.round(Number(ts) * 1000));
}

/** `$field` keeps its value unless the new value is set (SQL COALESCE(new, old)). */
const keepUnlessSet = (field: string, v: unknown) => ({ $ifNull: [lit(v), `$${field}`] });
/** First value wins: keeps the stored value, sets it when missing (COALESCE(old, new)). */
const keepFirst = (field: string, v: unknown) => ({ $ifNull: [`$${field}`, lit(v)] });

export async function upsertWorkspace(ws: WorkspaceInput): Promise<void> {
  // The URL ends up in an <img src>, so anything but https is dropped.
  const icon = ws.iconUrl && /^https:\/\//i.test(ws.iconUrl) ? ws.iconUrl : null;
  await upsertRetry(() =>
    col.workspaces.updateOne(
      { id: ws.id },
      [
        {
          $set: {
            name: keepUnlessSet('name', ws.name ?? null),
            domain: keepUnlessSet('domain', ws.domain ?? null),
            icon_url: keepUnlessSet('icon_url', icon),
            retention_days: { $ifNull: ['$retention_days', null] },
            created_at: { $ifNull: ['$created_at', '$$NOW'] },
            updated_at: '$$NOW',
          },
        },
      ],
      { upsert: true },
    ),
  );
}

export async function upsertChannel(workspaceId: string, ch: ChannelInput): Promise<void> {
  // Real-time capture of a conversation that isn't open may only know the id: keep the real name.
  const nameIsId = ch.name === ch.id;
  await upsertRetry(() =>
    col.channels.updateOne(
      { workspace_id: workspaceId, id: ch.id },
      [
        {
          $set: {
            name: nameIsId ? { $ifNull: ['$name', lit(ch.name)] } : lit(ch.name),
            // never downgrade a known type to 'unknown'
            type: ch.type === 'unknown' ? { $ifNull: ['$type', 'unknown'] } : lit(ch.type),
            topic: keepUnlessSet('topic', ch.topic ?? null),
            dm_user_id: keepUnlessSet('dm_user_id', ch.dmUserId ?? null),
            is_archived: { $ifNull: ['$is_archived', false] },
            is_hidden: { $ifNull: ['$is_hidden', false] },
            capture_excluded: { $ifNull: ['$capture_excluded', false] },
            reached_start: { $ifNull: ['$reached_start', false] },
            created_at: { $ifNull: ['$created_at', '$$NOW'] },
            updated_at: '$$NOW',
          },
        },
      ],
      { upsert: true },
    ),
  );
}

/**
 * Records the extension install and the Slack account it captured as.
 * Returns the account user id, or null for payloads from extensions older than multi-account support.
 * When the extension couldn't detect the signed-in user, the install itself stands in as the account.
 */
export async function recordSource(workspaceId: string, source: SourceInput | null | undefined): Promise<string | null> {
  if (!source) return null;
  const { collector, account } = source;
  const userId = account?.userId ?? `collector:${collector.id}`;
  // A detected account without a name falls back to its slack_users name at read time, not the browser label.
  const name = account ? (account.name ?? null) : (collector.label ?? null);
  await upsertRetry(() =>
    col.accounts.updateOne(
      { workspace_id: workspaceId, user_id: userId },
      [
        {
          $set: {
            display_name: keepUnlessSet('display_name', name),
            avatar_url: keepUnlessSet('avatar_url', account?.avatarUrl ?? null),
            is_hidden: { $ifNull: ['$is_hidden', false] },
            first_seen_at: { $ifNull: ['$first_seen_at', '$$NOW'] },
            last_seen_at: '$$NOW',
          },
        },
      ],
      { upsert: true },
    ),
  );
  await recordCollector(collector, workspaceId, userId);
  return userId;
}

/** Upserts an extension install. Workspace/account stay as last reported when not given (e.g. no Slack tab open). */
export async function recordCollector(collector: SourceInput['collector'], workspaceId: string | null, userId: string | null): Promise<void> {
  await upsertRetry(() =>
    col.collectors.updateOne(
      { id: collector.id },
      [
        {
          $set: {
            label: keepUnlessSet('label', collector.label || null),
            browser: keepUnlessSet('browser', collector.browser ?? null),
            extension_version: keepUnlessSet('extension_version', collector.version ?? null),
            workspace_id: keepUnlessSet('workspace_id', workspaceId),
            account_user_id: keepUnlessSet('account_user_id', userId),
            status: { $ifNull: ['$status', 'active'] },
            notes: { $ifNull: ['$notes', null] },
            first_seen_at: { $ifNull: ['$first_seen_at', '$$NOW'] },
            last_seen_at: '$$NOW',
          },
        },
      ],
      { upsert: true },
    ),
  );
}

/** 'active' | 'paused' | 'revoked', or null for an install the backend hasn't seen yet. */
export async function collectorStatus(collectorId: string): Promise<string | null> {
  const c = await col.collectors.findOne({ id: collectorId }, { projection: { status: 1 } });
  return c?.status ?? null;
}

async function upsertChannelAccount(
  workspaceId: string,
  ch: ChannelInput,
  accountUserId: string,
  opts: { inSidebar?: boolean; captured?: number },
): Promise<void> {
  const captured = opts.captured ?? 0;
  // A bare id as the name (real-time capture of a conversation not in view) is not a name.
  const name = ch.name === ch.id ? null : ch.name;
  await upsertRetry(() =>
    col.channelAccounts.updateOne(
      { workspace_id: workspaceId, channel_id: ch.id, account_user_id: accountUserId },
      [
        {
          $set: {
            channel_name: keepUnlessSet('channel_name', name),
            in_sidebar: { $or: [{ $ifNull: ['$in_sidebar', false] }, lit(opts.inSidebar ?? false)] },
            messages_captured: { $add: [{ $ifNull: ['$messages_captured', 0] }, captured] },
            first_captured_at: captured > 0 ? { $ifNull: ['$first_captured_at', '$$NOW'] } : { $ifNull: ['$first_captured_at', null] },
            last_synced_at: captured > 0 ? '$$NOW' : { $ifNull: ['$last_synced_at', null] },
            created_at: { $ifNull: ['$created_at', '$$NOW'] },
            updated_at: '$$NOW',
          },
        },
      ],
      { upsert: true },
    ),
  );
}

export async function ingestChannels(ws: WorkspaceInput, channels: ChannelInput[], source?: SourceInput | null): Promise<number> {
  await upsertWorkspace(ws);
  const accountUserId = await recordSource(ws.id, source);
  for (const ch of channels) {
    await upsertChannel(ws.id, ch);
    if (accountUserId) await upsertChannelAccount(ws.id, ch, accountUserId, { inSidebar: true });
  }
  return channels.length;
}

function userKey(m: MessageInput): string | null {
  if (m.userId) return m.userId;
  if (m.userName) return `name:${m.userName}`;
  return null;
}

/** A message stored for the first time by an ingest call (feeds live notifications). */
export interface NewMessage {
  ts: string;
  threadTs: string | null;
  userId: string | null;
  userName: string | null;
  avatarUrl: string | null;
  isBot: boolean;
  subtype: string | null;
  text: string;
  fileCount: number;
}

export interface IngestResult {
  inserted: number;
  updated: number;
  newestTs: string | null;
  oldestTs: string | null;
  newMessages: NewMessage[];
  /** Files in this batch that still need downloading by a browser. */
  filesPending: number;
}

/** Known names (and photos) of Slack users, for ids that arrive without one. */
async function knownUsers(workspaceId: string, ids: string[]) {
  if (!ids.length) return new Map<string, { name: string; avatar_url: string | null }>();
  const docs = await col.slackUsers.find({ workspace_id: workspaceId, id: { $in: ids } }).toArray();
  const out = new Map<string, { name: string; avatar_url: string | null }>();
  for (const d of docs) {
    const name = d.display_name ?? d.real_name;
    if (name) out.set(d.id, { name, avatar_url: d.avatar_url ?? null });
  }
  return out;
}

/**
 * Live socket messages usually carry a user id and no display name.
 * Use the name already learned from an earlier capture of that person.
 */
async function fillSenderNames(workspaceId: string, messages: MessageInput[]): Promise<MessageInput[]> {
  const byId = await knownUsers(workspaceId, [...new Set(messages.flatMap((m) => (m.userId && !m.userName ? [m.userId] : [])))]);
  if (!byId.size) return messages;
  return messages.map((m) => {
    if (m.userName || !m.userId) return m;
    const u = byId.get(m.userId);
    return u ? { ...m, userName: u.name, avatarUrl: m.avatarUrl || u.avatar_url || null } : m;
  });
}

/** Real-time messages carry mentions as "@U0123"; swap in the names we know so stored text reads like Slack. */
async function nameMentions(workspaceId: string, messages: MessageInput[]): Promise<MessageInput[]> {
  const names = await knownUsers(workspaceId, [...new Set(messages.flatMap((m) => m.mentions ?? []))]);
  if (!names.size) return messages;
  return messages.map((m) => ({
    ...m,
    text: (m.text ?? '').replace(/@([UW][A-Z0-9]+)\b/g, (whole, id: string) => (names.has(id) ? `@${names.get(id)!.name}` : whole)),
  }));
}

/** One upsert per message, merging with what is stored the way the old SQL upsert did. */
function messageUpsert(workspaceId: string, channelId: string, m: MessageInput, uid: string | null, accountUserId: string | null, newId: number | null): AnyBulkWriteOperation<Document> {
  const text = m.text ?? '';
  const set: Document = {
    id: { $ifNull: ['$id', lit(newId)] },
    sent_at: lit(tsToDate(m.ts)),
    user_id: keepUnlessSet('user_id', uid),
    user_name: keepUnlessSet('user_name', m.userName ?? null),
    text: text !== '' ? lit(text) : { $ifNull: ['$text', ''] },
    html: keepUnlessSet('html', m.html ?? null),
    thread_ts: keepUnlessSet('thread_ts', m.threadTs ?? null),
    reply_count: { $max: [lit(m.replyCount ?? 0), { $ifNull: ['$reply_count', 0] }] },
    is_edited: { $or: [lit(m.isEdited ?? false), { $ifNull: ['$is_edited', false] }] },
    is_bot: { $or: [lit(m.isBot ?? false), { $ifNull: ['$is_bot', false] }] },
    subtype: keepUnlessSet('subtype', m.subtype ?? null),
    has_files: { $or: [lit((m.files?.length ?? 0) > 0), { $ifNull: ['$has_files', false] }] },
    avatar_url: keepUnlessSet('avatar_url', m.avatarUrl ?? null),
    captured_by: keepFirst('captured_by', accountUserId),
    // Reactions are a snapshot: replace whatever we had.
    reactions: m.reactions ? lit(m.reactions.map((r) => ({ emoji: r.emoji, count: r.count }))) : { $ifNull: ['$reactions', []] },
    mentions: { $setUnion: [{ $ifNull: ['$mentions', []] }, lit(m.mentions ?? [])] },
    captured_at: { $ifNull: ['$captured_at', '$$NOW'] },
    updated_at: '$$NOW',
  };
  return { updateOne: { filter: { workspace_id: workspaceId, channel_id: channelId, ts: m.ts }, update: [{ $set: set }], upsert: true } };
}

export async function ingestMessages(body: IngestMessagesBody): Promise<IngestResult> {
  const { workspace, channel } = body;
  const empty: IngestResult = { inserted: 0, updated: 0, newestTs: null, oldestTs: null, newMessages: [], filesPending: 0 };

  await upsertWorkspace(workspace);
  await upsertChannel(workspace.id, channel);
  const accountUserId = await recordSource(workspace.id, body.source);

  // Admin controls: excluded conversations, deleted messages and the retention window are never (re-)stored.
  const [ch, ws, tomb] = await Promise.all([
    col.channels.findOne({ workspace_id: workspace.id, id: channel.id }, { projection: { capture_excluded: 1 } }),
    col.workspaces.findOne({ id: workspace.id }, { projection: { retention_days: 1 } }),
    col.deletedMessages
      .find({ workspace_id: workspace.id, channel_id: channel.id, ts: { $in: body.messages.map((m) => m.ts) } }, { projection: { ts: 1 } })
      .toArray(),
  ]);
  if (ch?.capture_excluded) return empty;
  const deleted = new Set(tomb.map((r) => r.ts as string));
  const keepAfter = ws?.retention_days ? Date.now() / 1000 - ws.retention_days * 86400 : 0;
  let messages = body.messages.filter((m) => !deleted.has(m.ts) && Number(m.ts) >= keepAfter);
  messages = await fillSenderNames(workspace.id, messages);
  if (body.origin === 'rtm') messages = await nameMentions(workspace.id, messages);

  // A batch may repeat a message; the last copy wins, as with the row-by-row upsert before.
  const byTs = new Map(messages.map((m) => [m.ts, m]));
  const sorted = [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
  const oldestTs = sorted[0]?.ts ?? null;
  const newestTs = sorted.at(-1)?.ts ?? null;
  if (!sorted.length) return { ...empty };

  let inserted = 0;
  let updated = 0;
  let filesPending = 0;
  const newMessages: NewMessage[] = [];

  // Numeric ids are only needed for messages we don't hold yet.
  const filter = { workspace_id: workspace.id, channel_id: channel.id, ts: { $in: sorted.map((m) => m.ts) } };
  const existing = new Set((await col.messages.find(filter, { projection: { ts: 1 } }).toArray()).map((d) => d.ts as string));
  const fresh = sorted.filter((m) => !existing.has(m.ts));
  let firstId = fresh.length ? await nextId('messages', fresh.length) : 0;
  const ids = new Map(fresh.map((m) => [m.ts, firstId++]));

  const ops = sorted.map((m) => messageUpsert(workspace.id, channel.id, m, userKey(m), accountUserId, ids.get(m.ts) ?? null));
  let res;
  try {
    res = await col.messages.bulkWrite(ops, { ordered: false });
  } catch (err) {
    // Another browser stored some of these at the same moment: the second pass only updates.
    if (!isDuplicateKey(err)) throw err;
    res = await col.messages.bulkWrite(ops, { ordered: false });
  }
  const upsertedIdx = new Set(Object.keys(res.upsertedIds).map(Number));

  const stored = new Map(
    (await col.messages.find(filter, { projection: { ts: 1, id: 1, sent_at: 1 } }).toArray()).map((d) => [d.ts as string, d]),
  );
  const users = new Map<string, { name: string | null; avatar: string | null; isBot: boolean; first: Date; last: Date }>();

  for (const [i, m] of sorted.entries()) {
    const uid = userKey(m);
    const sentAt = tsToDate(m.ts);
    if (upsertedIdx.has(i)) {
      inserted++;
      newMessages.push({
        ts: m.ts,
        threadTs: m.threadTs ?? null,
        userId: uid,
        userName: m.userName ?? null,
        avatarUrl: m.avatarUrl ?? null,
        isBot: m.isBot ?? false,
        subtype: m.subtype ?? null,
        text: m.text ?? '',
        fileCount: m.files?.length ?? 0,
      });
    } else updated++;

    const doc = stored.get(m.ts);
    if (doc) {
      for (const f of m.files ?? []) {
        if (await upsertMessageFile({ workspaceId: workspace.id, channelId: channel.id, messageId: doc.id, sentAt: doc.sent_at }, f)) filesPending++;
      }
    }

    if (uid) {
      const prev = users.get(uid);
      users.set(uid, {
        name: m.userName ?? prev?.name ?? null,
        avatar: m.avatarUrl ?? prev?.avatar ?? null,
        isBot: (m.isBot ?? false) || (prev?.isBot ?? false),
        first: prev && prev.first < sentAt ? prev.first : sentAt,
        last: prev && prev.last > sentAt ? prev.last : sentAt,
      });
    }
  }

  for (const [id, u] of users) {
    await upsertRetry(() =>
      col.slackUsers.updateOne(
        { workspace_id: workspace.id, id },
        [
          {
            $set: {
              display_name: keepUnlessSet('display_name', u.name),
              real_name: { $ifNull: ['$real_name', null] },
              avatar_url: keepUnlessSet('avatar_url', u.avatar),
              is_bot: { $or: [lit(u.isBot), { $ifNull: ['$is_bot', false] }] },
              first_seen_at: { $min: [lit(u.first), '$first_seen_at'] },
              last_seen_at: { $max: [lit(u.last), '$last_seen_at'] },
              created_at: { $ifNull: ['$created_at', '$$NOW'] },
              updated_at: '$$NOW',
            },
          },
        ],
        { upsert: true },
      ),
    );
    // Older live rows for this person may have been stored before we knew the name.
    if (u.name && !id.startsWith('name:')) {
      await col.messages.updateMany({ workspace_id: workspace.id, user_id: id, user_name: null }, { $set: { user_name: u.name, updated_at: new Date() } });
    }
  }

  // Sync bookkeeping. Slack ts strings are fixed-width, so string comparison orders them correctly ($min/$max skip nulls).
  await col.channels.updateOne({ workspace_id: workspace.id, id: channel.id }, [
    {
      $set: {
        oldest_synced_ts: { $min: ['$oldest_synced_ts', lit(oldestTs)] },
        newest_synced_ts: { $max: ['$newest_synced_ts', lit(newestTs)] },
        reached_start: { $or: [{ $ifNull: ['$reached_start', false] }, lit(body.reachedStart ?? false)] },
        last_synced_at: '$$NOW',
      },
    },
  ]);
  if (accountUserId) await upsertChannelAccount(workspace.id, channel, accountUserId, { captured: sorted.length });

  if (body.runId) {
    await col.syncRuns.updateOne({ id: body.runId }, [
      {
        $set: {
          messages_received: { $add: [{ $ifNull: ['$messages_received', 0] }, sorted.length] },
          oldest_seen_at: { $min: ['$oldest_seen_at', lit(tsToDate(oldestTs!))] },
        },
      },
    ]);
  }

  return { inserted, updated, newestTs, oldestTs, newMessages, filesPending };
}

export async function startSyncRun(input: {
  id: string;
  workspace: WorkspaceInput;
  channel?: ChannelInput | null;
  trigger: 'manual' | 'auto' | 'live';
  rangeFrom?: string | null;
  source?: SourceInput | null;
}): Promise<void> {
  await upsertWorkspace(input.workspace);
  if (input.channel) await upsertChannel(input.workspace.id, input.channel);
  const accountUserId = await recordSource(input.workspace.id, input.source);
  if (accountUserId && input.channel) await upsertChannelAccount(input.workspace.id, input.channel, accountUserId, {});
  await col.syncRuns.updateOne(
    { id: input.id },
    {
      $setOnInsert: {
        id: input.id,
        workspace_id: input.workspace.id,
        channel_id: input.channel?.id ?? null,
        trigger: input.trigger,
        status: 'running',
        range_from: input.rangeFrom ? new Date(input.rangeFrom) : null,
        oldest_seen_at: null,
        messages_received: 0,
        error: null,
        account_user_id: accountUserId,
        collector_id: input.source?.collector.id ?? null,
        started_at: new Date(),
        finished_at: null,
      },
    },
    { upsert: true },
  ).catch((err) => {
    if (!isDuplicateKey(err)) throw err; // ON CONFLICT DO NOTHING
  });
}

export async function finishSyncRun(id: string, input: { status: string; error?: string | null; oldestSeenAt?: string | null }): Promise<boolean> {
  const set: Document = { status: input.status, error: input.error ?? null, finished_at: new Date() };
  if (input.oldestSeenAt) set.oldest_seen_at = new Date(input.oldestSeenAt);
  const res = await col.syncRuns.updateOne({ id }, { $set: set });
  return res.matchedCount > 0;
}
