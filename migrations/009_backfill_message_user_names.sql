-- Live capture stored the Slack user id and left user_name empty when the socket
-- event had no profile. The name is already on slack_users from earlier captures.
UPDATE messages m
SET user_name = COALESCE(u.display_name, u.real_name),
    updated_at = now()
FROM slack_users u
WHERE u.workspace_id = m.workspace_id
  AND u.id = m.user_id
  AND m.user_name IS NULL
  AND COALESCE(u.display_name, u.real_name) IS NOT NULL;
