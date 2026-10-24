import { z } from 'zod';

const slackTs = z.string().regex(/^\d{9,11}\.\d{1,6}$/, 'expected Slack ts like 1697040000.123456');

export const conversationType = z.enum(['public', 'private', 'dm', 'group_dm', 'unknown']);

export const workspaceInput = z.object({
  id: z.string().min(1).max(32),
  name: z.string().max(200).nullish(),
  domain: z.string().max(200).nullish(),
  iconUrl: z.string().max(2000).nullish(), // workspace logo; only https URLs are stored
});

export const channelInput = z.object({
  id: z.string().min(1).max(32),
  name: z.string().min(1).max(300),
  type: conversationType.default('unknown'),
  topic: z.string().max(2000).nullish(),
  dmUserId: z.string().max(32).nullish(),
});

export const fileInput = z.object({
  name: z.string().max(1000).nullish(),
  url: z.string().max(4000), // link shown to people (Slack permalink, or the file URL)
  kind: z.string().max(50).nullish(),
  // Download hints. The backend only hands out files.slack.com URLs to download.
  slackFileId: z.string().regex(/^F[A-Z0-9]{6,}$/).nullish(),
  downloadUrl: z.string().max(4000).nullish(), // url_private of the original
  thumbUrl: z.string().max(4000).nullish(), // Slack's preview image
  mimeType: z.string().max(200).nullish(),
  size: z.number().int().min(0).nullish(),
});

export const messageInput = z.object({
  ts: slackTs,
  userId: z.string().max(200).nullish(),
  userName: z.string().max(300).nullish(),
  avatarUrl: z.string().max(2000).nullish(),
  isBot: z.boolean().optional(),
  text: z.string().max(200_000).default(''),
  html: z.string().max(500_000).nullish(),
  threadTs: slackTs.nullish(),
  replyCount: z.number().int().min(0).optional(),
  isEdited: z.boolean().optional(),
  subtype: z.string().max(100).nullish(),
  reactions: z.array(z.object({ emoji: z.string().min(1).max(200), count: z.number().int().min(1) })).max(200).optional(),
  files: z.array(fileInput).max(100).optional(),
  mentions: z.array(z.string().max(200)).max(200).optional(),
});

/** Who captured the payload: the extension install (collector) and the Slack user signed in to that browser. */
export const sourceInput = z.object({
  collector: z.object({
    id: z.string().uuid(),
    label: z.string().max(200).nullish(),
    browser: z.string().max(100).nullish(),
    version: z.string().max(50).nullish(),
  }),
  account: z
    .object({
      userId: z.string().min(1).max(200),
      name: z.string().max(300).nullish(),
      avatarUrl: z.string().max(2000).nullish(),
    })
    .nullish(),
});

export const ingestChannelsBody = z.object({
  workspace: workspaceInput,
  channels: z.array(channelInput).max(5000),
  source: sourceInput.nullish(),
});

export const ingestMessagesBody = z.object({
  workspace: workspaceInput,
  channel: channelInput,
  runId: z.string().uuid().nullish(),
  reachedStart: z.boolean().optional(),
  // 'rtm' = read from Slack's real-time socket (any conversation, mentions as @U… ids); 'dom' = read from the page
  origin: z.enum(['dom', 'rtm']).optional(),
  messages: z.array(messageInput).max(1000),
  source: sourceInput.nullish(),
});

export const heartbeatBody = z.object({
  workspace: workspaceInput.nullish(), // null when no Slack tab is open
  source: sourceInput,
});

export const fileKind = z.enum(['image', 'video', 'pdf', 'doc', 'other']);

export const fileClaimBody = z.object({
  workspaceId: z.string().min(1).max(32),
  kinds: z.array(fileKind).min(1).default(['image', 'video', 'pdf', 'doc', 'other']),
  maxBytes: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(25).default(5),
  source: sourceInput,
});

export const fileFailureBody = z.object({
  error: z.string().min(1).max(1000),
  // false: retrying won't help (deleted in Slack, no access); skip: deliberately not archived (too large)
  retryable: z.boolean().default(true),
  skip: z.boolean().default(false),
  source: sourceInput.nullish(),
});

export const commandResultBody = z.object({
  status: z.enum(['done', 'failed']),
  result: z.string().max(4000).nullish(),
});

export const syncRunStartBody = z.object({
  id: z.string().uuid(),
  workspace: workspaceInput,
  channel: channelInput.nullish(),
  trigger: z.enum(['manual', 'auto', 'live']),
  rangeFrom: z.string().datetime().nullish(),
  source: sourceInput.nullish(),
});

export const syncRunFinishBody = z.object({
  status: z.enum(['completed', 'failed', 'cancelled']),
  error: z.string().max(4000).nullish(),
  oldestSeenAt: z.string().datetime().nullish(),
});

export type WorkspaceInput = z.infer<typeof workspaceInput>;
export type ChannelInput = z.infer<typeof channelInput>;
export type MessageInput = z.infer<typeof messageInput>;
export type FileInput = z.infer<typeof fileInput>;
export type SourceInput = z.infer<typeof sourceInput>;
export type IngestMessagesBody = z.infer<typeof ingestMessagesBody>;
