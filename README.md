# Slack Analyze — Backend

The API and database for Slack Analyze.

Capture Slack channel and DM history from the Slack web app, store it in PostgreSQL, and browse, search and analyze it in a Slack-style web UI.

```
┌──────────────────────┐   batches (HTTP, real time)   ┌──────────────┐     ┌──────────────┐
│ Chrome extension     │ ─────────────────────────────▶│ Backend API  │────▶│ PostgreSQL   │
│ (app.slack.com tab)  │   X-API-Key                   │ Fastify :4000│◀────│ :5432        │
│ auto-scroll + live   │                               └──────┬───────┘     └──────────────┘
└──────────────────────┘                                      │ REST + SSE (/api/stream)
                                                              ▼
                                                      ┌──────────────┐
                                                      │ Next.js UI   │
                                                      │ :3000        │
                                                      └──────────────┘
```

| Repo | What it is |
|---|---|
| [slack-analyze-extension](https://github.com/core7matrix/slack-analyze-extension) | Chrome MV3 extension: scrapes the open Slack tab, auto-scrolls up through history, sends batches to the backend, timed auto-sync, live capture, offline retry queue |
| [slack-analyze-backend](https://github.com/core7matrix/slack-analyze-backend) | Node 22 + TypeScript + Fastify. Ingest API (extension → DB), read/search/analytics API, Server-Sent Events for live updates. Applies DB migrations on startup |
| [slack-analyze-frontend](https://github.com/core7matrix/slack-analyze-frontend) | Next.js 15 (App Router) + Tailwind: Slack-like message browser, search, analytics, sync status, admin dashboard |

Clone them side by side (`slack-analyze-backend`, `slack-analyze-frontend`, `slack-analyze-extension` in one folder); the frontend's icon export writes into the extension checkout next to it.


## Quick start (Windows, no Docker)

Needs Node 22 and PostgreSQL 17 or 18 installed (`C:\Program Files\PostgreSQL\<version>\bin`). The database script uses the newest installed version.

```powershell
npm install
powershell -ExecutionPolicy Bypass -File scripts/dev-db.ps1   # project-local cluster in .pgdata on :5433 (created on first run)
$env:INGEST_API_KEY = 'change-me-too'
npm run dev                                                   # http://localhost:4000, health: /health
```

Or in VS Code / Cursor: **Tasks: Run Task → dev: backend** (starts the database first). `DATABASE_URL` defaults to `postgres://slack:change-me@localhost:5433/slack_analyze`; every setting is listed in [.env.example](.env.example). Migrations in [migrations/](migrations/) are applied on startup.

Any PostgreSQL 16+ works: point `DATABASE_URL` at it instead of running `dev-db.ps1`.

## Deploy (Render + Neon + R2)

[render.yaml](render.yaml) describes the free Render web service. Create the Neon database first, then the Render service from this repo, fill in the `sync: false` secrets (`DATABASE_URL`, `INGEST_API_KEY`, `S3_*` for Cloudflare R2), then deploy [slack-analyze-frontend](https://github.com/core7matrix/slack-analyze-frontend) on Vercel with `NEXT_PUBLIC_API_URL` set to the Render URL.

## Files and images

Slack file links only open for someone signed in to that Slack workspace, and stop working when a file is deleted. The extension therefore **archives attached files** (Settings → *Files & images*, on by default):

1. When a message with files is stored, the backend records each file once, keyed by Slack's file id (`F…`) — the page and the real-time feed report the same file under different URLs.
2. Every 30 s (and right after such a message arrives) each browser asks `POST /api/ingest/files/claim` for files in the conversations its Slack account can see. Files are **leased for 10 minutes** to that browser, so several browsers capturing the same workspace never download one file twice.
3. The browser downloads the file from `files.slack.com` with its own Slack sign-in (falling back to fetching from inside the Slack tab) and uploads the bytes to `PUT /api/ingest/files/:id/content`. Files over the size limit (default 50 MB, per browser) keep only Slack's preview image when there is one.
4. The backend stores each **distinct content once** (SHA-256), so the same image shared in ten messages takes the space of one. A Slack sign-in page returned instead of the file is rejected.
5. Failed downloads retry with back-off (2, 4, 8 … minutes, up to 6 attempts); "not found" fails at once. Admin → Overview → *File archive* shows storage use, the queue and failures, with **Retry failed / Retry skipped**.
6. The dashboard shows archived images inline (click to enlarge, ← / → between images), plays videos, and offers downloads. Files are served by `GET /api/files/:id/content` only to signed-in users who can see the message.

Files nobody references any more (message deleted, conversation purged, retention) are removed from storage within an hour.

### Where files are stored

| `FILE_STORAGE` | Use for | Settings |
|---|---|---|
| `local` (default) | One server, local development | `FILE_STORAGE_DIR` (default `./data/files` in this repo) |
| `s3` | Any S3-compatible bucket — **Cloudflare R2** (10 GB free, no egress fees), **Backblaze B2** (10 GB free), **MinIO** (self-hosted), AWS S3, Google Cloud Storage (interoperability keys) | `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION` (`auto` for R2), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE=true` for MinIO, `S3_PREFIX` |

`FILE_MAX_MB` (default 100) is the server's hard cap per file. Uploads stream to disk while hashing, so large files are never held in memory.

## Database

Schema: [migrations/001_init.sql](migrations/001_init.sql), multi-account additions in [002_multi_account.sql](migrations/002_multi_account.sql) (`messages.captured_by` = first account that delivered the row).

| Table | Purpose |
|---|---|
| `workspaces` | Slack teams (`T…` id, name) |
| `channels` | Every conversation: `type` = `public` / `private` / `dm` / `group_dm`, topic, sync bookkeeping (`oldest_synced_ts`, `newest_synced_ts`, `reached_start`, `last_synced_at`) |
| `slack_users` | People seen in messages, avatar, first/last seen |
| `messages` | One row per message, unique on `(workspace_id, channel_id, ts)`; text, sender, thread fields, edited/bot flags, `raw` JSON, generated `search_vector` |
| `message_reactions` | Emoji + count per message (replaced on every capture) |
| `message_files` | Attachments: Slack file id, link, download/preview URLs, archive `status` (`pending` / `stored` / `failed` / `skipped`), download lease and retry state, stored blob |
| `file_blobs` | Archived file contents, one row per SHA-256: size, type, storage driver and key |
| `message_mentions` | `@user` mentions |
| `sync_runs` | One row per channel per sync run: trigger, status, range, messages received, errors, account + collector |
| `accounts` | Slack users signed in to a capturing browser (`workspace_id`, `user_id`) |
| `collectors` | Extension installs: id, label, browser, version, last account, `last_seen_at` |
| `channel_accounts` | Which account sees / captured which conversation, its name for it, messages delivered |
| `app_users`, `app_sessions` | Dashboard logins (scrypt password hashes, hashed session tokens) |
| `audit_log` | Admin actions |
| `deleted_messages` | Tombstones so deleted messages aren't re-captured |
| `collector_commands` | Commands queued for extension installs and their results |
| `channel_daily_stats` (view) | Messages and active people per channel per day |

Re-capturing is safe: ingest is an upsert, so overlapping ranges only update existing rows.

Search uses PostgreSQL full-text (`websearch_to_tsquery`: words, `"exact phrase"`, `-exclude`, `or`) plus trigram substring matching for partial words, URLs and code.

To change the schema, add a new file such as `migrations/009_add_x.sql` and restart the backend — never edit an applied migration.

## API

Ingest (extension; requires `X-API-Key` when `INGEST_API_KEY` is set):

| Method | Path | Body |
|---|---|---|
| GET | `/api/ingest/ping` | — |
| POST | `/api/ingest/heartbeat` | `{ workspace, source }` |
| POST | `/api/ingest/channels` | `{ workspace, channels[], source? }` |
| POST | `/api/ingest/messages` | `{ workspace, channel, runId?, reachedStart?, messages[], source? }` |
| POST | `/api/ingest/runs` | `{ id, workspace, channel?, trigger, rangeFrom?, source? }` |
| POST | `/api/ingest/files/claim` | `{ workspaceId, kinds?, maxBytes?, limit?, source }` → files to download (leased 10 min) |
| PUT | `/api/ingest/files/:id/content?variant=original\|preview` | raw bytes, `Content-Type: application/octet-stream`, `X-File-Type`, `X-Collector-Id` |
| POST | `/api/ingest/files/:id/failure` | `{ error, retryable?, skip?, source? }` |

`source` = `{ collector: { id, label?, browser?, version? }, account?: { userId, name?, avatarUrl? } }`.
| PATCH | `/api/ingest/runs/:id` | `{ status, error?, oldestSeenAt? }` |

Read (frontend):

| Path | Notes |
|---|---|
| `GET /api/workspaces` | with counts |
| `GET /api/accounts?workspaceId=` | accounts with their browsers, online status, counts |
| `GET /api/collectors` | every extension install |
| `GET /api/channels?workspaceId=&accountId=` | with message counts, date span, `accounts[]` |
| `GET /api/channels/:ws/:ch` | detail + stats |
| `GET /api/channels/:ws/:ch/messages?before=&after=&around=&limit=` | paged, oldest → newest |
| `GET /api/search?q=&workspaceId=&accountId=&channelIds=&userIds=&channelTypes=&from=&to=&hasFiles=&hasReactions=&sort=&page=` | results + channel/person/month facets |
| `GET /api/analytics/overview?workspaceId=&accountId=&from=&to=&tz=&channelIds=` | KPIs, daily series, top channels/people, weekday×hour heatmap, reactions |
| `GET /api/users?workspaceId=&q=` | people with message counts |
| `GET /api/sync-runs?workspaceId=&accountId=` | recent runs with account + browser |
| `GET /api/files/:id/content?download=1` | archived file (ETag, byte ranges; active content always as download) |
| `GET /api/stream` | Server-Sent Events: `messages`, `sync_run`, `notification` (new live-captured messages, for toasts / desktop notifications) |

The read and admin APIs require a dashboard login (session cookie). Ingest uses the `X-API-Key` instead.
