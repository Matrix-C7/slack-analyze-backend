-- Slack Analyze — workspace logo (Slack team icon), captured by the extension from Slack's client config.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS icon_url text;
