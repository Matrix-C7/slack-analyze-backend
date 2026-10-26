/** Shared SELECT list for message rows returned to the frontend (alias `m` = messages, `c` = channels). */
export const MESSAGE_COLUMNS = `
  m.id, m.workspace_id, m.channel_id, c.name AS channel_name, c.type AS channel_type,
  m.ts, m.sent_at, m.user_id,
  -- live capture often stores the user id only; the name captured earlier still applies
  COALESCE(m.user_name, u.display_name, u.real_name) AS user_name,
  m.text, m.thread_ts, m.reply_count,
  m.is_edited, m.is_bot, m.subtype, m.has_files,
  COALESCE(m.raw->>'avatarUrl', u.avatar_url) AS avatar_url,
  COALESCE((SELECT json_agg(json_build_object('emoji', r.emoji, 'count', r.count) ORDER BY r.count DESC, r.emoji)
            FROM message_reactions r WHERE r.message_id = m.id), '[]'::json) AS reactions,
  COALESCE((SELECT json_agg(json_build_object(
              'id', f.id, 'name', f.name, 'url', f.url, 'kind', f.kind, 'status', f.status, 'variant', f.variant,
              'mimeType', COALESCE(b.mime_type, f.mime_type), 'size', COALESCE(b.size_bytes, f.size_bytes)) ORDER BY f.id)
            FROM message_files f LEFT JOIN file_blobs b ON b.sha256 = f.blob_sha256
            WHERE f.message_id = m.id), '[]'::json) AS files`;

export const MESSAGE_FROM = `
  FROM messages m
  JOIN channels c ON c.workspace_id = m.workspace_id AND c.id = m.channel_id
  LEFT JOIN slack_users u ON u.workspace_id = m.workspace_id AND u.id = m.user_id`;

/** Restricts `m` (messages) to conversations the given account can see. `param` is a SQL placeholder like "$6". */
export const accountScopeSql = (param: string) => `EXISTS (
  SELECT 1 FROM channel_accounts ca
  WHERE ca.workspace_id = m.workspace_id AND ca.channel_id = m.channel_id AND ca.account_user_id = ${param}::text)`;

/** Converts a snake_case row into the camelCase shape the frontend expects. */
export function toMessage(row: Record<string, unknown>) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    channelType: row.channel_type,
    ts: row.ts,
    sentAt: row.sent_at,
    userId: row.user_id,
    userName: row.user_name,
    avatarUrl: row.avatar_url,
    text: row.text,
    threadTs: row.thread_ts,
    replyCount: row.reply_count,
    isEdited: row.is_edited,
    isBot: row.is_bot,
    subtype: row.subtype,
    hasFiles: row.has_files,
    reactions: row.reactions,
    files: row.files,
    ...(row.rank !== undefined ? { rank: row.rank } : {}),
  };
}
