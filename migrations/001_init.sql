-- Slack Analyze — initial schema
-- Applied by the backend migration runner (see src/db/migrate.ts).
-- Slack identifiers (T…, C…, D…, G…, U…) are stored as text; message identity is (workspace, channel, ts).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Workspaces (Slack teams)
-- ---------------------------------------------------------------------------
CREATE TABLE workspaces (
    id          text PRIMARY KEY,                -- Slack team id, e.g. T01ABCDEF
    name        text,
    domain      text,                            -- e.g. unybrands (from unybrands.slack.com)
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- People seen in messages
-- ---------------------------------------------------------------------------
CREATE TABLE slack_users (
    workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    id            text NOT NULL,                 -- U…/W…/B… id, or "name:<display name>" when the DOM had no id
    display_name  text,
    real_name     text,
    avatar_url    text,
    is_bot        boolean NOT NULL DEFAULT false,
    first_seen_at timestamptz,                   -- earliest message we hold from this user
    last_seen_at  timestamptz,                   -- latest message we hold from this user
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id)
);
CREATE INDEX slack_users_name_trgm ON slack_users USING gin (display_name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Conversations: public/private channels, DMs, group DMs
-- ---------------------------------------------------------------------------
CREATE TYPE conversation_type AS ENUM ('public', 'private', 'dm', 'group_dm', 'unknown');

CREATE TABLE channels (
    workspace_id      text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    id                text NOT NULL,             -- C…/G…/D…
    name              text NOT NULL,
    type              conversation_type NOT NULL DEFAULT 'unknown',
    topic             text,
    dm_user_id        text,                      -- for 1:1 DMs: the other participant
    is_archived       boolean NOT NULL DEFAULT false,
    -- sync bookkeeping, maintained by the ingest API
    oldest_synced_ts  text,                      -- oldest message ts we hold
    newest_synced_ts  text,                      -- newest message ts we hold
    reached_start     boolean NOT NULL DEFAULT false, -- the scraper hit the beginning of the channel
    last_synced_at    timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id)
);
CREATE INDEX channels_type_idx ON channels (workspace_id, type);

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
    id            bigserial PRIMARY KEY,
    workspace_id  text NOT NULL,
    channel_id    text NOT NULL,
    ts            text NOT NULL,                 -- Slack message ts, "1697040000.123456"
    sent_at       timestamptz NOT NULL,          -- ts converted to a timestamp
    user_id       text,
    user_name     text,                          -- display name as rendered at capture time
    text          text NOT NULL DEFAULT '',      -- plain text
    html          text,                          -- sanitized-ish rich text as rendered by Slack (optional)
    thread_ts     text,                          -- parent ts when this is a thread reply
    reply_count   integer NOT NULL DEFAULT 0,
    is_edited     boolean NOT NULL DEFAULT false,
    is_bot        boolean NOT NULL DEFAULT false,
    subtype       text,                          -- e.g. channel_join, bot_message, huddle
    has_files     boolean NOT NULL DEFAULT false,
    raw           jsonb,                         -- extra fields from the extension, kept for re-processing
    search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(user_name, '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(text, '')), 'A')
    ) STORED,
    captured_at   timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, channel_id, ts),
    FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX messages_channel_time_idx ON messages (workspace_id, channel_id, sent_at DESC);
CREATE INDEX messages_time_idx         ON messages (sent_at DESC);
CREATE INDEX messages_user_idx         ON messages (workspace_id, user_id, sent_at DESC);
CREATE INDEX messages_thread_idx       ON messages (workspace_id, channel_id, thread_ts) WHERE thread_ts IS NOT NULL;
CREATE INDEX messages_search_idx       ON messages USING gin (search_vector);
CREATE INDEX messages_text_trgm_idx    ON messages USING gin (text gin_trgm_ops);  -- substring / fuzzy search

-- ---------------------------------------------------------------------------
-- Message details
-- ---------------------------------------------------------------------------
CREATE TABLE message_reactions (
    message_id  bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    emoji       text NOT NULL,                   -- shortcode without colons, e.g. "thumbsup"
    count       integer NOT NULL DEFAULT 1,
    PRIMARY KEY (message_id, emoji)
);
CREATE INDEX message_reactions_emoji_idx ON message_reactions (emoji);

CREATE TABLE message_files (
    id          bigserial PRIMARY KEY,
    message_id  bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    name        text,
    url         text,
    kind        text,                            -- image | video | pdf | doc | link | other
    UNIQUE (message_id, url)
);

CREATE TABLE message_mentions (
    message_id  bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id     text NOT NULL,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_mentions_user_idx ON message_mentions (user_id);

-- ---------------------------------------------------------------------------
-- Sync runs reported by the extension (one row per channel per run)
-- ---------------------------------------------------------------------------
CREATE TYPE sync_trigger AS ENUM ('manual', 'auto', 'live');
CREATE TYPE sync_status  AS ENUM ('running', 'completed', 'failed', 'cancelled');

CREATE TABLE sync_runs (
    id                 uuid PRIMARY KEY,         -- generated by the extension
    workspace_id       text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id         text,
    trigger            sync_trigger NOT NULL,
    status             sync_status NOT NULL DEFAULT 'running',
    range_from         timestamptz,              -- requested cutoff (null = all history)
    oldest_seen_at     timestamptz,
    messages_received  integer NOT NULL DEFAULT 0,
    error              text,
    started_at         timestamptz NOT NULL DEFAULT now(),
    finished_at        timestamptz
);
CREATE INDEX sync_runs_started_idx ON sync_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- Daily rollup used by analytics (cheap to rebuild from messages)
-- ---------------------------------------------------------------------------
CREATE VIEW channel_daily_stats AS
SELECT workspace_id,
       channel_id,
       date_trunc('day', sent_at)::date AS day,
       count(*)                         AS message_count,
       count(DISTINCT user_id)          AS active_users
FROM messages
GROUP BY 1, 2, 3;
