-- Slack Analyze — per-user Slack account access.
-- Admins always see every account. A viewer either sees all accounts (all_accounts, the default, which also covers
-- accounts captured later) or only the ones listed in app_user_accounts. accounts.is_hidden still hides an account
-- from every viewer on top of this.

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS all_accounts boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS app_user_accounts (
    user_id          bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    workspace_id     text   NOT NULL,
    account_user_id  text   NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, workspace_id, account_user_id),
    FOREIGN KEY (workspace_id, account_user_id) REFERENCES accounts(workspace_id, user_id) ON DELETE CASCADE
);
