-- Slack Analyze — multi-account capture
-- The extension can be installed in several browsers / browser profiles, each signed in to Slack
-- as a different person. Messages stay de-duplicated on (workspace, channel, ts); these tables
-- record WHO captured WHAT, so the UI can show and filter by account.

-- ---------------------------------------------------------------------------
-- Accounts: the Slack user signed in to the browser that ran the capture
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
    workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id       text NOT NULL,                 -- U…/W… from Slack, or "collector:<uuid>" when it couldn't be detected
    display_name  text,
    avatar_url    text,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Collectors: one row per extension installation (browser or browser profile)
-- ---------------------------------------------------------------------------
CREATE TABLE collectors (
    id                uuid PRIMARY KEY,          -- generated once per install by the extension
    label             text,                      -- user-chosen, e.g. "Edge — Jane's laptop"
    browser           text,                      -- parsed from the user agent
    extension_version text,
    workspace_id      text,                      -- last workspace / account it captured as
    account_user_id   text,
    first_seen_at     timestamptz NOT NULL DEFAULT now(),
    last_seen_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collectors_account_idx ON collectors (workspace_id, account_user_id);

-- ---------------------------------------------------------------------------
-- Which account can see / has captured which conversation
-- ---------------------------------------------------------------------------
CREATE TABLE channel_accounts (
    workspace_id       text NOT NULL,
    channel_id         text NOT NULL,
    account_user_id    text NOT NULL,
    channel_name       text,                     -- name as this account sees it (DMs are named after the other person)
    in_sidebar         boolean NOT NULL DEFAULT false,
    messages_captured  integer NOT NULL DEFAULT 0, -- message rows delivered by this account (inserts + updates)
    first_captured_at  timestamptz,
    last_synced_at     timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, channel_id, account_user_id),
    FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, account_user_id) REFERENCES accounts(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX channel_accounts_account_idx ON channel_accounts (workspace_id, account_user_id);

-- First account that delivered each message
ALTER TABLE messages ADD COLUMN captured_by text;

ALTER TABLE sync_runs ADD COLUMN account_user_id text;
ALTER TABLE sync_runs ADD COLUMN collector_id uuid;
CREATE INDEX sync_runs_account_idx ON sync_runs (workspace_id, account_user_id);
