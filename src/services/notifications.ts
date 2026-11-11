import { col } from '../db/mongo.js';
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
  const userIds = [...new Set(messages.map((m) => m.userId).filter((id): id is string => Boolean(id)))];
  const [c, w, link, users] = await Promise.all([
    col.channels.findOne({ workspace_id: workspace.id, id: channel.id }),
    col.workspaces.findOne({ id: workspace.id }),
    accountId ? col.channelAccounts.findOne({ workspace_id: workspace.id, channel_id: channel.id, account_user_id: accountId }) : null,
    col.slackUsers.find({ workspace_id: workspace.id, id: { $in: userIds } }).toArray(),
  ]);
  if (!c || !w) return null;
  const byId = new Map(users.map((u) => [u.id as string, u]));

  return {
    workspaceId: workspace.id,
    workspaceName: w.name ?? null,
    workspaceIconUrl: w.icon_url ?? null,
    channelId: channel.id,
    channelName: link?.channel_name ?? c.name,
    channelType: c.type,
    channelHidden: Boolean(c.is_hidden),
    accountId,
    messages: messages.map((m) => {
      const u = m.userId ? byId.get(m.userId) : undefined;
      return {
        ts: m.ts,
        threadTs: m.threadTs,
        userId: m.userId,
        userName: m.userName ?? u?.display_name ?? u?.real_name ?? null,
        avatarUrl: m.avatarUrl ?? u?.avatar_url ?? null,
        isBot: m.isBot,
        text: m.text.length > PREVIEW_CHARS ? `${m.text.slice(0, PREVIEW_CHARS)}…` : m.text,
        fileCount: m.fileCount,
      };
    }),
  };
}
