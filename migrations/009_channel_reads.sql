-- How far each dashboard user has read in a conversation.
-- Messages with a Slack ts newer than last_read_ts are unread. No row means nothing has been read.

CREATE TABLE channel_reads (
    app_user_id  bigint NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    workspace_id text NOT NULL,
    channel_id   text NOT NULL,
    last_read_ts text,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app_user_id, workspace_id, channel_id),
    FOREIGN KEY (workspace_id, channel_id) REFERENCES channels(workspace_id, id) ON DELETE CASCADE
);
