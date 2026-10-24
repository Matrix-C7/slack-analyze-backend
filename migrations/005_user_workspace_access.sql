-- Slack Analyze — per-user community (workspace) access.
-- Admins always see every workspace. A viewer either sees all workspaces (all_workspaces, the default, which also
-- covers workspaces captured later) or only the ones listed in app_user_workspaces.

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS all_workspaces boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS app_user_workspaces (
    user_id       bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    workspace_id  text   NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS app_user_workspaces_ws_idx ON app_user_workspaces (workspace_id);
