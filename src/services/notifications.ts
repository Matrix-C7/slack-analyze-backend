import { pool } from '../db/pool.js';
import type { NotificationEvent } from '../events.js';
import type { IngestMessagesBody } from '../schemas.js';
import type { NewMessage } from './ingest.js';

/** Only messages sent this recently notify; older ones are history reaching the archive late (e.g. a retry queue). */
const MAX_AGE_SEC = 30 * 60;
/** Ordinary messages notify; joins, topic changes, pins and the like don't. */
const NOTIFY_SUBTYPES = new Set(['thread_broadcast', 'bot_message', 'file_share', 'me_message']);
const PREVIEW_CHARS = 400;

/**
 * Builds the live notification for messages a live (non-history) ingest stored for the first time,
 * or null when nothing in it should notify. Names come from what the archive already knows.
 */
export async function buildNotification(body: IngestMessagesBody, fresh: NewMessage[]): Promise<NotificationEvent | null> {
  if (body.runId) return null; // history sync
  const now = Date.now() / 1000;
  const messages = fresh.filter((m) => now - Number(m.ts) <= MAX_AGE_SEC && (!m.subtype || NOTIFY_SUBTYPES.has(m.subtype)));
  if (!messages.length) return null;

  const { workspace, channel } = body;
  const accountId = body.source?.account?.userId ?? null;
  const { rows: ctx } = await pool.query(
    `SELECT w.name AS workspace_name, w.icon_url, c.type, c.is_hidden,
            COALESCE((SELECT ca.channel_name FROM channel_accounts ca
                       WHERE ca.workspace_id = c.workspace_id AND ca.channel_id = c.id AND ca.account_user_id = $3::text),
                     c.name) AS channel_name
     FROM channels c JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.workspace_id = $1 AND c.id = $2`,
    [workspace.id, channel.id, accountId],
  );
  if (!ctx[0]) return null;

  const userIds = [...new Set(messages.map((m) => m.userId).filter((id): id is string => Boolean(id)))];
  const { rows: users } = await pool.query<{ id: string; name: string | null; avatar_url: string | null }>(
    `SELECT id, COALESCE(display_name, real_name) AS name, avatar_url FROM slack_users
     WHERE workspace_id = $1 AND id = ANY($2::text[])`,
    [workspace.id, userIds],
  );
  const byId = new Map(users.map((u) => [u.id, u]));

  return {
    workspaceId: workspace.id,
    workspaceName: ctx[0].workspace_name,
    workspaceIconUrl: ctx[0].icon_url,
    channelId: channel.id,
    channelName: ctx[0].channel_name,
    channelType: ctx[0].type,
    channelHidden: ctx[0].is_hidden,
    messages: messages.map((m) => {
      const u = m.userId ? byId.get(m.userId) : undefined;
      return {
        ts: m.ts,
        threadTs: m.threadTs,
        userId: m.userId,
        userName: m.userName ?? u?.name ?? null,
        avatarUrl: m.avatarUrl ?? u?.avatar_url ?? null,
        isBot: m.isBot,
        text: m.text.length > PREVIEW_CHARS ? `${m.text.slice(0, PREVIEW_CHARS)}…` : m.text,
        fileCount: m.fileCount,
      };
    }),
  };
}
