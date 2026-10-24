-- Slack Analyze — admin dashboard: dashboard users + sessions, audit log, content controls,
-- collector (extension install) management and remote commands.

-- ---------------------------------------------------------------------------
-- Dashboard users (people who log in to the web UI — not Slack users)
-- ---------------------------------------------------------------------------
CREATE TYPE app_role AS ENUM ('admin', 'viewer');

CREATE TABLE app_users (
    id             bigserial PRIMARY KEY,
    email          text NOT NULL,
    name           text,
    password_hash  text NOT NULL,              -- scrypt$<salt hex>$<hash hex>
    role           app_role NOT NULL DEFAULT 'viewer',
    is_active      boolean NOT NULL DEFAULT true,
    last_login_at  timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX app_users_email_idx ON app_users (lower(email));

CREATE TABLE app_sessions (
    token_hash   text PRIMARY KEY,             -- sha256 of the cookie value; the raw token is never stored
    user_id      bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    user_agent   text,
    ip           text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);
CREATE INDEX app_sessions_user_idx ON app_sessions (user_id);

CREATE TABLE audit_log (
    id          bigserial PRIMARY KEY,
    user_id     bigint REFERENCES app_users(id) ON DELETE SET NULL,
    user_email  text,                          -- kept when the user is deleted
    action      text NOT NULL,                 -- e.g. user.create, channel.purge, collector.pause
    target      text,                          -- e.g. "T01/C02", user id, collector id
    details     jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);

-- ---------------------------------------------------------------------------
-- Content controls
-- ---------------------------------------------------------------------------
-- is_hidden: only admins see the conversation. capture_excluded: ingest ignores it and extensions skip it.
ALTER TABLE channels ADD COLUMN is_hidden boolean NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN capture_excluded boolean NOT NULL DEFAULT false;

-- Messages deleted by an admin. Ingest skips these so a later sync doesn't bring them back.
CREATE TABLE deleted_messages (
    workspace_id text NOT NULL,
    channel_id   text NOT NULL,
    ts           text NOT NULL,
    deleted_by   bigint REFERENCES app_users(id) ON DELETE SET NULL,
    deleted_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, channel_id, ts)
);

-- Messages older than this many days are purged and not re-ingested (null = keep everything).
ALTER TABLE workspaces ADD COLUMN retention_days integer CHECK (retention_days IS NULL OR retention_days > 0);

CREATE INDEX messages_captured_idx ON messages (captured_at DESC);

-- ---------------------------------------------------------------------------
-- Collector management + remote commands
-- ---------------------------------------------------------------------------
-- active: normal. paused: the extension stops capturing until resumed. revoked: ingest is refused.
ALTER TABLE collectors ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked'));
ALTER TABLE collectors ADD COLUMN notes text;
ALTER TABLE collectors ALTER COLUMN workspace_id DROP NOT NULL;

CREATE TABLE collector_commands (
    id            bigserial PRIMARY KEY,
    collector_id  uuid NOT NULL REFERENCES collectors(id) ON DELETE CASCADE,
    type          text NOT NULL CHECK (type IN ('sync_channels', 'sync_open', 'refresh_channels', 'stop', 'set_settings')),
    payload       jsonb NOT NULL DEFAULT '{}',
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'done', 'failed', 'cancelled')),
    result        text,
    created_by    bigint REFERENCES app_users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    delivered_at  timestamptz,
    finished_at   timestamptz
);
CREATE INDEX collector_commands_pending_idx ON collector_commands (collector_id) WHERE status = 'pending';
