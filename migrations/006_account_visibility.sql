-- Slack Analyze — admins can hide a captured Slack account from viewers (the "view as" picker, credits, browser
-- and sync lists). Messages stay visible through other accounts and "All accounts".

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;
