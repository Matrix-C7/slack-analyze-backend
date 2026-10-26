import type pg from 'pg';
import { pool, withTransaction } from '../db/pool.js';
import { upsertMessageFile } from './files.js';
import type { ChannelInput, IngestMessagesBody, MessageInput, SourceInput, WorkspaceInput } from '../schemas.js';

export function tsToDate(ts: string): Date {
  return new Date(Math.round(Number(ts) * 1000));
}

export async function upsertWorkspace(db: pg.PoolClient | pg.Pool, ws: WorkspaceInput): Promise<void> {
  await db.query(
    `INSERT INTO workspaces (id, name, domain, icon_url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, workspaces.name),
       domain = COALESCE(EXCLUDED.domain, workspaces.domain),
       icon_url = COALESCE(EXCLUDED.icon_url, workspaces.icon_url),
       updated_at = now()`,
    // The URL ends up in an <img src>, so anything but https is dropped.
    [ws.id, ws.name ?? null, ws.domain ?? null, ws.iconUrl && /^https:\/\//i.test(ws.iconUrl) ? ws.iconUrl : null],
  );
}

export async function upsertChannel(db: pg.PoolClient | pg.Pool, workspaceId: string, ch: ChannelInput): Promise<void> {
  await db.query(
    `INSERT INTO channels (workspace_id, id, name, type, topic, dm_user_id) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, id) DO UPDATE SET
       -- real-time capture of a conversation that isn't open may only know the id; keep the real name
       name = CASE WHEN EXCLUDED.name = EXCLUDED.id THEN channels.name ELSE EXCLUDED.name END,
       -- never downgrade a known type to 'unknown'
       type = CASE WHEN EXCLUDED.type = 'unknown' THEN channels.type ELSE EXCLUDED.type END,
       topic = COALESCE(EXCLUDED.topic, channels.topic),
       dm_user_id = COALESCE(EXCLUDED.dm_user_id, channels.dm_user_id),
       updated_at = now()`,
    [workspaceId, ch.id, ch.name, ch.type, ch.topic ?? null, ch.dmUserId ?? null],
  );
}

/**
 * Records the extension install and the Slack account it captured as.
 * Returns the account user id, or null for payloads from extensions older than multi-account support.
 * When the extension couldn't detect the signed-in user, the install itself stands in as the account.
 */
export async function recordSource(
  db: pg.PoolClient | pg.Pool,
  workspaceId: string,
  source: SourceInput | null | undefined,
): Promise<string | null> {
  if (!source) return null;
  const { collector, account } = source;
  const userId = account?.userId ?? `collector:${collector.id}`;
  // A detected account without a name falls back to its slack_users name at read time, not the browser label.
  const name = account ? (account.name ?? null) : (collector.label ?? null);
  await db.query(
    `INSERT INTO accounts (workspace_id, user_id, display_name, avatar_url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, accounts.display_name),
       avatar_url   = COALESCE(EXCLUDED.avatar_url, accounts.avatar_url),
       last_seen_at = now()`,
    [workspaceId, userId, name, account?.avatarUrl ?? null],
  );
  await recordCollector(db, collector, workspaceId, userId);
  return userId;
}

/** Upserts an extension install. Workspace/account stay as last reported when not given (e.g. no Slack tab open). */
export async function recordCollector(
  db: pg.PoolClient | pg.Pool,
  collector: SourceInput['collector'],
  workspaceId: string | null,
  userId: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO collectors (id, label, browser, extension_version, workspace_id, account_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       label             = COALESCE(EXCLUDED.label, collectors.label),
       browser           = COALESCE(EXCLUDED.browser, collectors.browser),
       extension_version = COALESCE(EXCLUDED.extension_version, collectors.extension_version),
       workspace_id      = COALESCE(EXCLUDED.workspace_id, collectors.workspace_id),
       account_user_id   = COALESCE(EXCLUDED.account_user_id, collectors.account_user_id),
       last_seen_at      = now()`,
    [collector.id, collector.label || null, collector.browser ?? null, collector.version ?? null, workspaceId, userId],
  );
}

/** 'active' | 'paused' | 'revoked', or null for an install the backend hasn't seen yet. */
export async function collectorStatus(collectorId: string): Promise<string | null> {
  const { rows } = await pool.query('SELECT status FROM collectors WHERE id = $1', [collectorId]);
  return rows[0]?.status ?? null;
}

async function upsertChannelAccount(
  db: pg.PoolClient,
  workspaceId: string,
  ch: ChannelInput,
  accountUserId: string,
  opts: { inSidebar?: boolean; captured?: number },
): Promise<void> {
  const captured = opts.captured ?? 0;
  await db.query(
    `INSERT INTO channel_accounts
       (workspace_id, channel_id, account_user_id, channel_name, in_sidebar, messages_captured, first_captured_at, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6::int, CASE WHEN $6::int > 0 THEN now() END, CASE WHEN $6::int > 0 THEN now() END)
     ON CONFLICT (workspace_id, channel_id, account_user_id) DO UPDATE SET
       channel_name      = COALESCE(EXCLUDED.channel_name, channel_accounts.channel_name),
       in_sidebar        = channel_accounts.in_sidebar OR EXCLUDED.in_sidebar,
       messages_captured = channel_accounts.messages_captured + EXCLUDED.messages_captured,
       first_captured_at = COALESCE(channel_accounts.first_captured_at, EXCLUDED.first_captured_at),
       last_synced_at    = COALESCE(EXCLUDED.last_synced_at, channel_accounts.last_synced_at),
       updated_at        = now()`,
    // A bare id as the name (real-time capture of a conversation not in view) is not a name.
    [workspaceId, ch.id, accountUserId, ch.name === ch.id ? null : ch.name, opts.inSidebar ?? false, captured],
  );
}

export async function ingestChannels(
  ws: WorkspaceInput,
  channels: ChannelInput[],
  source?: SourceInput | null,
): Promise<number> {
  return withTransaction(async (db) => {
    await upsertWorkspace(db, ws);
    const accountUserId = await recordSource(db, ws.id, source);
    for (const ch of channels) {
      await upsertChannel(db, ws.id, ch);
      if (accountUserId) await upsertChannelAccount(db, ws.id, ch, accountUserId, { inSidebar: true });
    }
    return channels.length;
  });
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

/**
 * Live socket messages usually carry a user id and no display name.
 * Use the name already learned from an earlier capture of that person.
 */
async function fillSenderNames(db: pg.PoolClient, workspaceId: string, messages: MessageInput[]): Promise<MessageInput[]> {
  const ids = [...new Set(messages.flatMap((m) => (m.userId && !m.userName ? [m.userId] : [])))];
  if (!ids.length) return messages;
  const { rows } = await db.query<{ id: string; name: string; avatar_url: string | null }>(
    `SELECT id, COALESCE(display_name, real_name) AS name, avatar_url FROM slack_users
     WHERE workspace_id = $1 AND id = ANY($2::text[]) AND COALESCE(display_name, real_name) IS NOT NULL`,
    [workspaceId, ids],
  );
  if (!rows.length) return messages;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return messages.map((m) => {
    if (m.userName || !m.userId) return m;
    const u = byId.get(m.userId);
    if (!u) return m;
    return { ...m, userName: u.name, avatarUrl: m.avatarUrl || u.avatar_url || null };
  });
}

/** Real-time messages carry mentions as "@U0123"; swap in the names we know so stored text reads like Slack. */
async function nameMentions(db: pg.PoolClient, workspaceId: string, messages: MessageInput[]): Promise<MessageInput[]> {
  const ids = [...new Set(messages.flatMap((m) => m.mentions ?? []))];
  if (!ids.length) return messages;
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT id, COALESCE(display_name, real_name) AS name FROM slack_users
     WHERE workspace_id = $1 AND id = ANY($2::text[]) AND COALESCE(display_name, real_name) IS NOT NULL`,
    [workspaceId, ids],
  );
  if (!rows.length) return messages;
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return messages.map((m) => ({
    ...m,
    text: (m.text ?? '').replace(/@([UW][A-Z0-9]+)\b/g, (whole, id: string) => (names.has(id) ? `@${names.get(id)}` : whole)),
  }));
}

export async function ingestMessages(body: IngestMessagesBody): Promise<IngestResult> {
  const { workspace, channel } = body;

  return withTransaction(async (db) => {
    await upsertWorkspace(db, workspace);
    await upsertChannel(db, workspace.id, channel);
    const accountUserId = await recordSource(db, workspace.id, body.source);

    // Admin controls: excluded conversations, deleted messages and the retention window are never (re-)stored.
    const { rows: ctl } = await db.query(
      `SELECT c.capture_excluded, w.retention_days
       FROM channels c JOIN workspaces w ON w.id = c.workspace_id
       WHERE c.workspace_id = $1 AND c.id = $2`,
      [workspace.id, channel.id],
    );
    if (ctl[0]?.capture_excluded) return { inserted: 0, updated: 0, newestTs: null, oldestTs: null, newMessages: [], filesPending: 0 };
    const { rows: tomb } = await db.query<{ ts: string }>(
      'SELECT ts FROM deleted_messages WHERE workspace_id = $1 AND channel_id = $2 AND ts = ANY($3::text[])',
      [workspace.id, channel.id, body.messages.map((m) => m.ts)],
    );
    const deleted = new Set(tomb.map((r) => r.ts));
    const keepAfter = ctl[0]?.retention_days ? Date.now() / 1000 - ctl[0].retention_days * 86400 : 0;
    let messages = body.messages.filter((m) => !deleted.has(m.ts) && Number(m.ts) >= keepAfter);
    messages = await fillSenderNames(db, workspace.id, messages);
    if (body.origin === 'rtm') messages = await nameMentions(db, workspace.id, messages);

    const sorted = [...messages].sort((a, b) => Number(a.ts) - Number(b.ts));
    const oldestTs = sorted[0]?.ts ?? null;
    const newestTs = sorted.at(-1)?.ts ?? null;

    let inserted = 0;
    let updated = 0;
    let filesPending = 0;
    const newMessages: NewMessage[] = [];
    const users = new Map<string, { name: string | null; avatar: string | null; isBot: boolean; first: Date; last: Date }>();

    for (const m of sorted) {
      const sentAt = tsToDate(m.ts);
      const uid = userKey(m);
      const { rows } = await db.query<{ id: number; inserted: boolean }>(
        `INSERT INTO messages
           (workspace_id, channel_id, ts, sent_at, user_id, user_name, text, html, thread_ts,
            reply_count, is_edited, is_bot, subtype, has_files, raw, captured_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (workspace_id, channel_id, ts) DO UPDATE SET
           user_id     = COALESCE(EXCLUDED.user_id, messages.user_id),
           user_name   = COALESCE(EXCLUDED.user_name, messages.user_name),
           text        = CASE WHEN EXCLUDED.text <> '' THEN EXCLUDED.text ELSE messages.text END,
           html        = COALESCE(EXCLUDED.html, messages.html),
           thread_ts   = COALESCE(EXCLUDED.thread_ts, messages.thread_ts),
           reply_count = GREATEST(EXCLUDED.reply_count, messages.reply_count),
           is_edited   = EXCLUDED.is_edited OR messages.is_edited,
           is_bot      = EXCLUDED.is_bot OR messages.is_bot,
           subtype     = COALESCE(EXCLUDED.subtype, messages.subtype),
           has_files   = EXCLUDED.has_files OR messages.has_files,
           raw         = COALESCE(EXCLUDED.raw, messages.raw),
           captured_by = COALESCE(messages.captured_by, EXCLUDED.captured_by),
           updated_at  = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [
          workspace.id,
          channel.id,
          m.ts,
          sentAt,
          uid,
          m.userName ?? null,
          m.text ?? '',
          m.html ?? null,
          m.threadTs ?? null,
          m.replyCount ?? 0,
          m.isEdited ?? false,
          m.isBot ?? false,
          m.subtype ?? null,
          (m.files?.length ?? 0) > 0,
          m.avatarUrl ? { avatarUrl: m.avatarUrl } : null,
          accountUserId,
        ],
      );
      const { id, inserted: isNew } = rows[0];
      if (isNew) {
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

      // Reactions are a snapshot: replace whatever we had.
      if (m.reactions) {
        await db.query('DELETE FROM message_reactions WHERE message_id = $1', [id]);
        for (const r of m.reactions) {
          await db.query(
            `INSERT INTO message_reactions (message_id, emoji, count) VALUES ($1, $2, $3)
             ON CONFLICT (message_id, emoji) DO UPDATE SET count = EXCLUDED.count`,
            [id, r.emoji, r.count],
          );
        }
      }
      for (const f of m.files ?? []) {
        if (await upsertMessageFile(db, workspace.id, id, f)) filesPending++;
      }
      for (const u of m.mentions ?? []) {
        await db.query('INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, u]);
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
      await db.query(
        `INSERT INTO slack_users (workspace_id, id, display_name, avatar_url, is_bot, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           display_name  = COALESCE(EXCLUDED.display_name, slack_users.display_name),
           avatar_url    = COALESCE(EXCLUDED.avatar_url, slack_users.avatar_url),
           is_bot        = EXCLUDED.is_bot OR slack_users.is_bot,
           first_seen_at = LEAST(EXCLUDED.first_seen_at, slack_users.first_seen_at),
           last_seen_at  = GREATEST(EXCLUDED.last_seen_at, slack_users.last_seen_at),
           updated_at    = now()`,
        [workspace.id, id, u.name, u.avatar, u.isBot, u.first, u.last],
      );
      // Older live rows for this person may have been stored before we knew the name.
      if (u.name && !id.startsWith('name:')) {
        await db.query(
          `UPDATE messages SET user_name = $3, updated_at = now()
           WHERE workspace_id = $1 AND user_id = $2 AND user_name IS NULL`,
          [workspace.id, id, u.name],
        );
      }
    }

    // Sync bookkeeping. Slack ts strings are fixed-width, so text comparison orders them correctly.
    await db.query(
      `UPDATE channels SET
         oldest_synced_ts = CASE WHEN $3::text IS NULL THEN oldest_synced_ts
                                 WHEN oldest_synced_ts IS NULL OR $3 < oldest_synced_ts THEN $3 ELSE oldest_synced_ts END,
         newest_synced_ts = CASE WHEN $4::text IS NULL THEN newest_synced_ts
                                 WHEN newest_synced_ts IS NULL OR $4 > newest_synced_ts THEN $4 ELSE newest_synced_ts END,
         reached_start    = reached_start OR $5,
         last_synced_at   = now()
       WHERE workspace_id = $1 AND id = $2`,
      [workspace.id, channel.id, oldestTs, newestTs, body.reachedStart ?? false],
    );
    if (accountUserId) await upsertChannelAccount(db, workspace.id, channel, accountUserId, { captured: sorted.length });

    if (body.runId) {
      await db.query(
        `UPDATE sync_runs SET
           messages_received = messages_received + $2,
           oldest_seen_at = CASE WHEN $3::timestamptz IS NULL THEN oldest_seen_at
                                 ELSE LEAST(COALESCE(oldest_seen_at, $3), $3) END
         WHERE id = $1`,
        [body.runId, sorted.length, oldestTs ? tsToDate(oldestTs) : null],
      );
    }

    return { inserted, updated, newestTs, oldestTs, newMessages, filesPending };
  });
}

export async function startSyncRun(input: {
  id: string;
  workspace: WorkspaceInput;
  channel?: ChannelInput | null;
  trigger: 'manual' | 'auto' | 'live';
  rangeFrom?: string | null;
  source?: SourceInput | null;
}): Promise<void> {
  await withTransaction(async (db) => {
    await upsertWorkspace(db, input.workspace);
    if (input.channel) await upsertChannel(db, input.workspace.id, input.channel);
    const accountUserId = await recordSource(db, input.workspace.id, input.source);
    if (accountUserId && input.channel) await upsertChannelAccount(db, input.workspace.id, input.channel, accountUserId, {});
    await db.query(
      `INSERT INTO sync_runs (id, workspace_id, channel_id, trigger, range_from, account_user_id, collector_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        input.id,
        input.workspace.id,
        input.channel?.id ?? null,
        input.trigger,
        input.rangeFrom ?? null,
        accountUserId,
        input.source?.collector.id ?? null,
      ],
    );
  });
}

export async function finishSyncRun(
  id: string,
  input: { status: string; error?: string | null; oldestSeenAt?: string | null },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE sync_runs SET status = $2, error = $3,
       oldest_seen_at = COALESCE($4, oldest_seen_at), finished_at = now()
     WHERE id = $1`,
    [id, input.status, input.error ?? null, input.oldestSeenAt ?? null],
  );
  return (rowCount ?? 0) > 0;
}
