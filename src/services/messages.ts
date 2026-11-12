import type { Document } from 'mongodb';
import { col } from '../db/mongo.js';

const key = (ws: string, id: string) => `${ws}\u0000${id}`;

/** Channels and Slack users for a set of (workspace, id) pairs, keyed by `key()`. */
export async function lookupMap(coll: 'channels' | 'slackUsers', pairs: { ws: string; id: string }[]): Promise<Map<string, Document>> {
  const byWs = new Map<string, Set<string>>();
  for (const p of pairs) if (p.id) byWs.set(p.ws, (byWs.get(p.ws) ?? new Set()).add(p.id));
  if (!byWs.size) return new Map();
  const docs = await col[coll].find({ $or: [...byWs].map(([ws, ids]) => ({ workspace_id: ws, id: { $in: [...ids] } })) }).toArray();
  return new Map(docs.map((d) => [key(d.workspace_id, d.id), d]));
}

export const userName = (u: Document | undefined) => u?.display_name ?? u?.real_name ?? null;

/**
 * Turns message documents into the shape the frontend expects: channel name/type, sender name and photo
 * (live capture often stores the user id only; the name captured earlier still applies), reactions and files.
 */
export async function hydrateMessages(docs: Document[]): Promise<Record<string, unknown>[]> {
  if (!docs.length) return [];
  const [channels, users, files] = await Promise.all([
    lookupMap('channels', docs.map((m) => ({ ws: m.workspace_id, id: m.channel_id }))),
    lookupMap('slackUsers', docs.filter((m) => m.user_id).map((m) => ({ ws: m.workspace_id, id: m.user_id }))),
    col.messageFiles.find({ message_id: { $in: docs.filter((m) => m.has_files).map((m) => m.id) } }).sort({ id: 1 }).toArray(),
  ]);
  const blobs = new Map(
    (await col.fileBlobs.find({ sha256: { $in: [...new Set(files.map((f) => f.blob_sha256).filter(Boolean))] } }).toArray()).map((b) => [b.sha256, b]),
  );
  // One entry per Slack file of a message; a stored copy wins over one still pending.
  const filesBy = new Map<number, Document[]>();
  for (const f of files) {
    const list = filesBy.get(f.message_id) ?? [];
    const key = f.slack_file_id ?? f.url;
    const i = list.findIndex((x) => (x.slack_file_id ?? x.url) === key);
    if (i < 0) list.push(f);
    else if (list[i].status !== 'stored' && f.status === 'stored') list[i] = f;
    filesBy.set(f.message_id, list);
  }

  return docs.map((m) => {
    const c = channels.get(key(m.workspace_id, m.channel_id));
    const u = m.user_id ? users.get(key(m.workspace_id, m.user_id)) : undefined;
    const reactions = [...(m.reactions ?? [])].sort((a, b) => b.count - a.count || (a.emoji < b.emoji ? -1 : 1));
    return {
      id: m.id,
      workspaceId: m.workspace_id,
      channelId: m.channel_id,
      channelName: c?.name ?? m.channel_id,
      channelType: c?.type ?? 'unknown',
      ts: m.ts,
      sentAt: m.sent_at,
      userId: m.user_id ?? null,
      userName: m.user_name ?? userName(u),
      avatarUrl: m.avatar_url ?? u?.avatar_url ?? null,
      text: m.text ?? '',
      threadTs: m.thread_ts ?? null,
      replyCount: m.reply_count ?? 0,
      isEdited: Boolean(m.is_edited),
      isBot: Boolean(m.is_bot),
      subtype: m.subtype ?? null,
      hasFiles: Boolean(m.has_files),
      reactions: reactions.map((r) => ({ emoji: r.emoji, count: r.count })),
      files: (filesBy.get(m.id) ?? []).map((f) => {
        const b = f.blob_sha256 ? blobs.get(f.blob_sha256) : undefined;
        return {
          id: f.id,
          name: f.name ?? null,
          url: f.url,
          kind: f.kind ?? null,
          status: f.status,
          variant: f.variant ?? null,
          mimeType: b?.mime_type ?? f.mime_type ?? null,
          size: b?.size_bytes ?? f.size_bytes ?? null,
        };
      }),
      ...(m.rank !== undefined ? { rank: m.rank } : {}),
    };
  });
}

/** Thread replies live in the thread panel; only top-level messages (and replies also sent to the channel) are channel history. */
export const topLevelFilter = {
  $or: [{ thread_ts: null }, { $expr: { $eq: ['$thread_ts', '$ts'] } }, { subtype: 'thread_broadcast' }],
};
