import { type Collection, type Document, MongoClient, MongoServerError } from 'mongodb';
import { config } from '../config.js';

/**
 * MongoDB (Atlas free M0 cluster). Field names stay snake_case as in the old PostgreSQL schema, so the
 * route code reads like before. Numeric ids that the frontend and extension use (messages, files, users,
 * commands, audit entries) come from the `counters` collection.
 */
export const client = new MongoClient(config.mongodbUri, {
  maxPoolSize: 10,
  // Atlas M0 sleeps nothing, but Render's free service does; fail fast instead of hanging a request.
  serverSelectionTimeoutMS: 15_000,
});
export const db = client.db(config.mongodbDb);

type Doc = Document;
const c = <T extends Doc = Doc>(name: string) => db.collection<T>(name);

export const col = {
  counters: c<{ _id: string; seq: number }>('counters'),
  settings: c<{ _id: string; value: unknown }>('settings'),
  workspaces: c('workspaces'),
  slackUsers: c('slack_users'),
  channels: c('channels'),
  messages: c('messages'),
  messageFiles: c('message_files'),
  fileBlobs: c('file_blobs'),
  syncRuns: c('sync_runs'),
  accounts: c('accounts'),
  collectors: c('collectors'),
  channelAccounts: c('channel_accounts'),
  appUsers: c('app_users'),
  appSessions: c('app_sessions'),
  auditLog: c('audit_log'),
  deletedMessages: c('deleted_messages'),
  collectorCommands: c('collector_commands'),
  channelReads: c('channel_reads'),
};

/** Reserves `n` consecutive ids for a sequence and returns the first one. */
export async function nextId(name: string, n = 1): Promise<number> {
  const doc = await col.counters.findOneAndUpdate({ _id: name }, { $inc: { seq: n } }, { upsert: true, returnDocument: 'after' });
  return doc!.seq - n + 1;
}

/** Wraps a value so an aggregation-pipeline update stores it as is ("$5 off" is text, not a field path). */
export const lit = (v: unknown) => ({ $literal: v ?? null });

export const isDuplicateKey = (err: unknown) => err instanceof MongoServerError && err.code === 11000;

/** Retries once when two concurrent upserts race on the same unique key. */
export async function upsertRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    return fn();
  }
}

/** Creates the indexes the API relies on. Idempotent; runs on every start (replaces the SQL migrations). */
export async function ensureIndexes(): Promise<void> {
  await dedupeMessageFiles();
  const ix = (coll: Collection<Doc>, specs: { key: Doc; unique?: boolean; name?: string; partialFilterExpression?: Doc; expireAfterSeconds?: number }[]) =>
    coll.createIndexes(specs.map((s) => ({ ...s, key: s.key })));
  await Promise.all([
    ix(col.workspaces, [{ key: { id: 1 }, unique: true }]),
    ix(col.slackUsers, [{ key: { workspace_id: 1, id: 1 }, unique: true }]),
    ix(col.channels, [{ key: { workspace_id: 1, id: 1 }, unique: true }, { key: { is_hidden: 1 } }]),
    ix(col.messages, [
      { key: { workspace_id: 1, channel_id: 1, ts: 1 }, unique: true },
      { key: { id: 1 }, unique: true },
      { key: { workspace_id: 1, sent_at: -1 } },
      { key: { sent_at: -1 } },
      { key: { workspace_id: 1, user_id: 1 } },
      { key: { workspace_id: 1, channel_id: 1, thread_ts: 1 }, partialFilterExpression: { thread_ts: { $type: 'string' } } },
      { key: { captured_at: -1 } },
    ]),
    ix(col.messageFiles, [
      { key: { id: 1 }, unique: true },
      { key: { message_id: 1 } },
      // One row per file of a message, however many browsers capture it at once.
      { key: { message_id: 1, file_key: 1 }, unique: true, name: 'message_file_unique', partialFilterExpression: { file_key: { $type: 'string' } } },
      { key: { workspace_id: 1, status: 1, sent_at: -1 } },
      { key: { workspace_id: 1, slack_file_id: 1 } },
      { key: { blob_sha256: 1 } },
    ]),
    ix(col.syncRuns, [{ key: { id: 1 }, unique: true }, { key: { started_at: -1 } }, { key: { collector_id: 1 } }]),
    ix(col.accounts, [{ key: { workspace_id: 1, user_id: 1 }, unique: true }]),
    ix(col.collectors, [{ key: { id: 1 }, unique: true }, { key: { workspace_id: 1, account_user_id: 1 } }]),
    ix(col.channelAccounts, [
      { key: { workspace_id: 1, channel_id: 1, account_user_id: 1 }, unique: true },
      { key: { workspace_id: 1, account_user_id: 1 } },
    ]),
    ix(col.appUsers, [{ key: { id: 1 }, unique: true }, { key: { email: 1 }, unique: true }]),
    // Expired sessions are removed by MongoDB itself.
    ix(col.appSessions, [{ key: { token_hash: 1 }, unique: true }, { key: { user_id: 1 } }, { key: { expires_at: 1 }, expireAfterSeconds: 0 }]),
    ix(col.auditLog, [{ key: { id: -1 } }, { key: { action: 1, id: -1 } }]),
    ix(col.deletedMessages, [{ key: { workspace_id: 1, channel_id: 1, ts: 1 }, unique: true }]),
    ix(col.collectorCommands, [{ key: { id: 1 }, unique: true }, { key: { collector_id: 1, status: 1 } }]),
    ix(col.channelReads, [{ key: { app_user_id: 1, workspace_id: 1, channel_id: 1 }, unique: true }]),
  ]);
}

/**
 * Before the unique (message_id, file_key) index existed, browsers capturing the same message at the same
 * moment each inserted the message's files, so one attachment showed up several times. Gives every row its
 * key and keeps one row per file (a stored one first, then the oldest).
 */
async function dedupeMessageFiles(): Promise<void> {
  await col.messageFiles.updateMany({ file_key: { $exists: false } }, [{ $set: { file_key: { $ifNull: ['$slack_file_id', '$url'] } } }]);
  const groups = await col.messageFiles
    .aggregate([
      { $addFields: { _stored: { $cond: [{ $eq: ['$status', 'stored'] }, 0, 1] } } },
      { $sort: { _stored: 1, id: 1 } },
      { $group: { _id: { m: '$message_id', k: '$file_key' }, ids: { $push: '$id' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  const extra = groups.flatMap((g) => (g.ids as number[]).slice(1));
  if (extra.length) await col.messageFiles.deleteMany({ id: { $in: extra } });
}

/**
 * Deletes messages and everything hanging off them (archived-file rows; reactions and mentions live inside the
 * message document). `filter` may only use fields both collections carry: workspace_id, channel_id, sent_at, message ids.
 */
export async function deleteMessages(filter: Doc): Promise<number> {
  const { id, ...rest } = filter;
  const fileFilter = id !== undefined ? { ...rest, message_id: id } : rest;
  const [res] = await Promise.all([col.messages.deleteMany(filter), col.messageFiles.deleteMany(fileFilter)]);
  return res.deletedCount;
}

/** Deletes a conversation's messages, files, account links and read cursors (the old ON DELETE CASCADE). */
export async function deleteChannelData(workspaceId: string, channelIds: string[]): Promise<void> {
  const f = { workspace_id: workspaceId, channel_id: { $in: channelIds } };
  await Promise.all([
    col.messages.deleteMany(f),
    col.messageFiles.deleteMany(f),
    col.channelAccounts.deleteMany(f),
    col.channelReads.deleteMany(f),
  ]);
}
