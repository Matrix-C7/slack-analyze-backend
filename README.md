# Slack Analyze — Backend

The API and database for Slack Analyze.

Capture Slack channel and DM history from the Slack web app, store it in MongoDB (files and images in Google Drive), and browse, search and analyze it in a Slack-style web UI.

```
┌──────────────────────┐   batches (HTTP, real time)   ┌──────────────┐     ┌──────────────┐
│ Chrome extension     │ ─────────────────────────────▶│ Backend API  │────▶│ MongoDB Atlas│
│ (app.slack.com tab)  │   X-API-Key                   │ Fastify :4000│◀────│ (free M0)    │
│ auto-scroll + live   │                               └──┬───┬───────┘     └──────────────┘
└──────────────────────┘                                  │   └───────────▶ Google Drive (files)
                                                          │ REST + SSE (/api/stream)
                                                          ▼
                                                  ┌──────────────┐
                                                  │ Next.js UI   │
                                                  │ :3000        │
                                                  └──────────────┘
```

| Repo | What it is |
|---|---|
| [slack-analyze-extension](https://github.com/core7matrix/slack-analyze-extension) | Chrome MV3 extension: scrapes the open Slack tab, auto-scrolls up through history, sends batches to the backend, timed auto-sync, live capture, offline retry queue |
| [slack-analyze-backend](https://github.com/core7matrix/slack-analyze-backend) | Node 22 + TypeScript + Fastify. Ingest API (extension → DB), read/search/analytics API, Server-Sent Events for live updates. Creates its MongoDB indexes on startup |
| [slack-analyze-frontend](https://github.com/core7matrix/slack-analyze-frontend) | Next.js 15 (App Router) + Tailwind: Slack-like message browser, search, analytics, sync status, admin dashboard |

Clone them side by side (`slack-analyze-backend`, `slack-analyze-frontend`, `slack-analyze-extension` in one folder); the frontend's icon export writes into the extension checkout next to it.


## Quick start

Needs Node 22, a free **MongoDB Atlas** cluster and (for the file archive) a **Google account**. Nothing else runs locally besides the API.

```powershell
npm install
copy .env.example .env      # then fill in MONGODB_URI and the GOOGLE_* keys (steps below)
npm run gdrive:auth         # once: sign in to Google, paste the printed GOOGLE_REFRESH_TOKEN into .env
npm run dev                 # http://localhost:4000, health: /health
```

Or in VS Code / Cursor: **Tasks: Run Task → dev: backend**. Settings are read from `.env` (never committed); every one is listed in [.env.example](.env.example). Indexes are created on startup — there are no migrations to run.

To work without Google Drive, set `FILE_STORAGE=local` (files go to `./data/files`).

### MongoDB Atlas (free)

1. Sign up at [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas/register) → **Create** a cluster → **M0 Free** (512 MB storage, no card needed). Pick a region near your Render region (e.g. Singapore).
2. **Database Access** → add a database user (password auth) with *Read and write to any database*.
3. **Network Access** → add `0.0.0.0/0` (Render's free service has no fixed outbound IP). The database user's password is what protects it, so make it long.
4. **Connect → Drivers** → copy the `mongodb+srv://…` string, put the password in, and set it as `MONGODB_URI`. The database (`MONGODB_DB`, default `slack_analyze`) is created on first write.

Admin → Overview shows the space used ("Database"); M0 allows 512 MB.

### Google Drive (personal account, free 15 GB)

Files are kept in a folder of your own Drive (default *Slack Analyze files*). The backend signs in with an OAuth refresh token for the **`drive.file`** scope, so it can only see and change files it created — nothing else in your Drive.

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project → **APIs & Services → Library** → enable **Google Drive API**.
2. **OAuth consent screen** (Google Auth Platform) → *External* → app name and your email → under *Data access* add the scope `.../auth/drive.file`.
3. **Audience → Publish app → In production.** `drive.file` is a non-sensitive scope, so Google doesn't review the app. **Don't skip this:** while the app is in *Testing*, Google expires the refresh token after 7 days and uploads stop.
4. **Credentials → Create credentials → OAuth client ID → Desktop app**. Put the client id and secret in `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
5. `npm run gdrive:auth`, open the printed link, sign in with the Google account whose Drive should hold the files (Google warns that the app is unverified: *Advanced → Go to …*), and copy the printed `GOOGLE_REFRESH_TOKEN` into `.env` and the Render dashboard.

The folder is created on the first upload and remembered in the database. If the token stops working (password change, or access removed at [myaccount.google.com/permissions](https://myaccount.google.com/permissions)), run `npm run gdrive:auth` again and update the token.

## Deploy (Render + MongoDB Atlas + Google Drive)

[render.yaml](render.yaml) describes the free Render web service. Create the Atlas cluster and the Google refresh token first (above), then the Render service from this repo, fill in the `sync: false` secrets (`MONGODB_URI`, `INGEST_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`), then deploy [slack-analyze-frontend](https://github.com/core7matrix/slack-analyze-frontend) on Vercel with `NEXT_PUBLIC_API_URL` set to the Render URL.

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
| `gdrive` (default) | Your personal Google Drive (15 GB free, shared with Gmail and Photos) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_DRIVE_FOLDER_NAME`, optional `GOOGLE_DRIVE_FOLDER_ID` |
| `local` | Local development without Google | `FILE_STORAGE_DIR` (default `./data/files` in this repo) |

`FILE_MAX_MB` (default 100) is the server's hard cap per file. Uploads stream to a temp file while hashing, then go to Drive as a resumable upload, so large files are never held in memory. In Drive each file is named after its SHA-256; the dashboard shows the original names. The dashboard gets files through the API (with byte ranges for video), never through shared Drive links.

## Database

MongoDB, one collection per former table (field names unchanged). Indexes are created on startup in [src/db/mongo.ts](src/db/mongo.ts). Ids the dashboard and extension use (messages, files, dashboard users, commands, audit entries) are numbers from the `counters` collection.

| Collection | Purpose |
|---|---|
| `workspaces` | Slack teams (`T…` id, name, logo, retention) |
| `channels` | Every conversation: `type` = `public` / `private` / `dm` / `group_dm`, topic, sync bookkeeping (`oldest_synced_ts`, `newest_synced_ts`, `reached_start`, `last_synced_at`), hidden / excluded flags |
| `slack_users` | People seen in messages, avatar, first/last seen |
| `messages` | One document per message, unique on `(workspace_id, channel_id, ts)`: text, sender, thread fields, edited/bot flags, `reactions[]` (replaced on every capture), `mentions[]`, `captured_by` (first account that delivered it) |
| `message_files` | Attachments: Slack file id, link, download/preview URLs, archive `status` (`pending` / `stored` / `failed` / `skipped`), download lease and retry state, stored blob |
| `file_blobs` | Archived file contents, one per SHA-256: size, type, storage driver and key (the Drive file id) |
| `sync_runs` | One per channel per sync run: trigger, status, range, messages received, errors, account + collector |
| `accounts` | Slack users signed in to a capturing browser (`workspace_id`, `user_id`) |
| `collectors` | Extension installs: id, label, browser, version, last account, `last_seen_at`, status |
| `channel_accounts` | Which account sees / captured which conversation, its name for it, messages delivered |
| `app_users`, `app_sessions` | Dashboard logins (scrypt password hashes, hashed session tokens; a TTL index removes expired sessions). Community and account grants are kept on the user |
| `audit_log` | Admin actions |
| `deleted_messages` | Tombstones so deleted messages aren't re-captured |
| `collector_commands` | Commands queued for extension installs and their results |
| `channel_reads` | How far each dashboard user has read in each conversation |
| `counters`, `settings` | Number sequences; the Google Drive folder id |

Re-capturing is safe: ingest is an upsert, so overlapping ranges only update existing documents.

Search works like a web search: every word must appear (also inside longer words, URLs and code), `"exact phrase"`, `-exclude`, and `or` between alternatives. It matches message text and sender names, and ranks text matches above name matches.

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
