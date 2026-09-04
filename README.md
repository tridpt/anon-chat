# GhostChat

[![CI](https://github.com/tridpt/anon-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/tridpt/anon-chat/actions/workflows/ci.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

Anonymous, one-on-one chat with language-compatible matching. GhostChat does not create accounts. Chat transcripts are stored server-side for moderator access and automatically expire after the configured retention period.

## Features

- Match two people while prioritizing compatible Vietnamese, English, or any-language preferences.
- Offer localized icebreaker prompts after a match, based on shared interests when possible.
- Show the live number of people waiting and a wait-time estimate based on recent matches.
- Require self-attested 18+ and Community Rules acceptance before joining the queue.
- Skip a chat, block a current partner, and manage or undo blocks in the browser.
- Insert emojis from a built-in picker and switch between dark and light themes (saved per browser).
- React to individual messages with emoji, and get a browser notification on a match or new message when the tab is hidden.
- Switch the interface language between English and Vietnamese; the choice is detected from the browser and saved per browser.
- Report a current partner with a reason, then review and resolve reports in `/admin`.
- Keep resolved reports in a separate archive and apply moderator actions such as a 24-hour chat block or permanent ban.
- Store masked chat transcripts for admin review, with search, date filters, pagination, JSON/CSV export, deletion, and configurable automatic retention.
- Organize the moderation dashboard into separate Overview, Reports, Resolved, Bans, Activity, and Chats tabs.
- Protect browser admin access with short-lived, HttpOnly sessions, same-origin mutation checks, login throttling, and named moderator roles.
- Mask basic profanity, limit links per message, and auto-suspend clients that pass a report threshold.
- Show a live count of people currently online alongside the queue status.
- Server-side validation, message-size limits, queue limits, and per-socket flood controls.

## Run locally

Requires Node.js 20 or newer.

```bash
npm ci
npm start
```

Open `http://localhost:3000`.

For development with automatic restart:

```bash
npm run dev
```

Run the test suite:

```bash
npm test
```

## Configuration

| Variable                  | Default                       | Purpose                                                                                                           |
| ------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `3000`                        | HTTP and Socket.IO port.                                                                                          |
| `DATA_DIR`                | `./data`                      | Directory where durable reports, bans, chat transcripts, moderator accounts, and audit logs are stored.           |
| `CHAT_RETENTION_DAYS`     | `30`                          | Number of days to retain completed chat transcripts. Set to `0` or a negative value to retain indefinitely.       |
| `ADMIN_TOKEN`             | _(recommended for bootstrap)_ | Secret used to bootstrap the first named admin account and for emergency API access.                              |
| `ADMIN_SESSION_TTL_HOURS` | `8`                           | Lifetime of the in-memory admin session created after sign-in.                                                    |
| `ADMIN_COOKIE_SECURE`     | `auto`                        | Force the `Secure` flag on the admin cookie (`true`/`1`); it is automatic for HTTPS and production.               |
| `ADMIN_PATH`              | `/admin`                      | Secret URL path for the moderation dashboard. Use a random path in production; `/admin` returns 404 when changed. |
| `REDIS_URL`               | _(optional)_                  | Enables the Socket.IO Redis adapter for multi-instance deployments (e.g. `redis://localhost:6379`).               |
| `PROFANITY_EXTRA`         | _(optional)_                  | Comma-separated extra words to mask, added to the built-in list.                                                  |
| `PROFANITY_FILE`          | _(optional)_                  | Path to a JSON array of extra words to mask. Malformed or missing files are ignored.                              |
| `TRUST_PROXY`             | `false`                       | Set to `true`/`1` when behind a trusted reverse proxy so per-IP limits use the `X-Forwarded-For` client IP.       |

To enable moderation, set a strong token before starting the app:

```powershell
$env:ADMIN_TOKEN = 'use-a-long-random-secret'
npm start
```

When a local `.env` file exists, the app loads it automatically. Keep `.env` private and do not commit it.

Open the configured `ADMIN_PATH` (for example `http://localhost:3000/admin`) and use the bootstrap token once. The server exchanges it for a short-lived, `HttpOnly`, `SameSite=Strict` session cookie; the browser console does not store the token or send it on every request. From the Team tab, create named accounts with one of three roles: `admin` (full access and team management), `moderator` (review reports, lift bans, and delete transcripts), or `viewer` (read-only access). Passwords are stored as `scrypt` hashes in `DATA_DIR/moderators.json`, never as plaintext. Sessions are held in memory and re-check the account on every request, so disabling an account or changing its role takes effect immediately. Keep at least one active admin account. In production, set a random `ADMIN_PATH` as an additional layer; this path is not a replacement for `ADMIN_TOKEN`.

The admin API still accepts `Authorization: Bearer <ADMIN_TOKEN>` for existing scripts and automation. Prefer the browser session flow for interactive access, and never put the token in a URL.

## Safety behaviour and limitations

Blocks use an anonymous random ID stored only in the visitor's browser. The blocked ID is sent to the server only to avoid matching that browser with the same person again. Clearing browser data creates a new ID, so this is a user-safety feature, not an account-level ban system.

The 18+ confirmation is a self-attestation, not identity or age verification. It is intended to set a clear entry rule and cannot prevent a determined visitor from bypassing it.

Reports are validated, stored in `DATA_DIR/reports.json`, and also written as structured `REPORT {...}` server logs. Each new report includes the matching `chatId`, so moderators can open its transcript directly from the report card. Once resolved, a report moves to `DATA_DIR/resolved-reports.json` and appears in the separate admin archive. Moderators can optionally block the reported anonymous client for 24 hours or permanently revoke its access; active restrictions are listed in the admin Ban monitor and can be lifted there. Every report review, automatic suspension, lifted ban, transcript deletion, and moderator-account change is recorded in `DATA_DIR/moderation-log.json` with the acting account identity. Because GhostChat has no public accounts, enforcement uses the browser's anonymous client ID. Chat transcripts are stored in `DATA_DIR/chats.json` and can be searched, paginated, exported, or deleted through the admin dashboard and admin-only `/api/admin/chats`, `/api/admin/chats/export`, and `/api/admin/chats/:id` endpoints. Completed transcripts are pruned after `CHAT_RETENTION_DAYS`; active chats remain until they end. Named moderator credentials are stored as salted `scrypt` hashes in `DATA_DIR/moderators.json`; this file is sensitive and must be backed up with the rest of the data directory. Establish a moderation process, publish a clear retention/privacy policy, and protect both `ADMIN_TOKEN` and the data directory because stored messages can contain sensitive personal information.

Profanity masking covers a basic built-in word list. Extend it at runtime without editing code by setting `PROFANITY_EXTRA` (comma-separated words) and/or `PROFANITY_FILE` (a JSON array of words); both are additive to the defaults. Auto-suspension is a lightweight safeguard: when an anonymous client is reported enough times within the configured window, it is temporarily blocked from matching. Active bans are persisted to `DATA_DIR/bans.json` (atomic write) and reloaded on startup, so they survive restarts and redeploys. Expired bans are pruned automatically. This is not a substitute for human moderation.

A public `GET /health` endpoint reports `status`, uptime, current online and waiting counts, total matches, the rolling average match wait, and the number of active bans. Use it for uptime checks and basic monitoring.

The app also applies a coarse in-process per-IP rate limit to HTTP requests (the `/health` endpoint is exempt) and to new socket connections, as a lightweight backstop against abuse. This is not a replacement for an edge/proxy limit. For a production release, also put the app behind HTTPS, add a reverse-proxy/IP-level rate limit as the first line of defence, set `TRUST_PROXY=true` so the in-process limiter sees real client IPs, publish a privacy policy, and monitor error and report logs.

## Scaling to multiple instances

Set `REDIS_URL` to attach the [Socket.IO Redis adapter](https://socket.io/docs/v4/redis-adapter/), which delivers events across instances. The `redis` and `@socket.io/redis-adapter` packages are listed as optional dependencies and are loaded only when `REDIS_URL` is set; if the connection fails at startup, the app logs the error and continues in single-instance mode.

When `REDIS_URL` is set, matchmaking also becomes **cluster-wide**: the waiting queue and room registry live in Redis, a short-lived Redis lock ensures only one instance runs a matching pass at a time, and matches plus partner-left events are orchestrated across instances via `serverSideEmit`. This means any instance can pair any waiting visitor, so **sticky sessions are not required for matching** — a visitor on instance A can be matched and chat with a visitor on instance B. Online and waiting counts on `/health` are aggregated across the cluster, and total matches are tracked in a shared counter.

Bans and per-socket rate limits remain per-instance (a reported client is auto-suspended on the instance that processed the report and on re-login checks); replicating those across the cluster is a possible follow-up.

Browser admin sessions are also held in process memory. With multiple app instances, route the
admin console to a single instance (or add a shared session store) so a session remains available
after load balancing.

You can verify the shared queue locally with the bundled Compose stack (two app instances plus Redis):

```bash
docker compose up --build
```

Open `http://localhost:3000` in one browser and `http://localhost:3001` in another, join with a shared interest, and confirm the two are matched across instances.

> Note: the single-instance (in-memory) path is covered by the automated test suite. The distributed path relies on a live Redis and multiple instances, so smoke-test it with the Compose stack (or your staging environment) before relying on it in production.

## Deploy with Docker

Build and run the image locally:

```bash
docker build -t ghostchat .
docker run --rm -p 3000:3000 \
  -e PORT=3000 \
  -e ADMIN_TOKEN='use-a-long-random-secret' \
  -v ghostchat-data:/app/data \
  ghostchat
```

The `Dockerfile` works with any container host that supports an HTTP service. Configure the host to expose port `3000` (or set `PORT` to the port it provides), terminate HTTPS at the host or proxy, and mount persistent storage at `/app/data` so reports, bans, and chat transcripts survive redeploys.
