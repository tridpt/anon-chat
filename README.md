# GhostChat

[![CI](https://github.com/tridpt/anon-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/tridpt/anon-chat/actions/workflows/ci.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

Anonymous, one-on-one chat with interest-based matching. GhostChat does not create accounts or store chat history.

## Features

- Match two people by shared interests while prioritizing compatible Vietnamese, English, or any-language preferences.
- Offer localized icebreaker prompts after a match, based on shared interests when possible.
- Show the live number of people waiting and a wait-time estimate based on recent matches.
- Select popular interest chips or type custom interests before matching.
- Require self-attested 18+ and Community Rules acceptance before joining the queue.
- Skip a chat, block a current partner, and manage or undo blocks in the browser.
- Insert emojis from a built-in picker and switch between dark and light themes (saved per browser).
- React to individual messages with emoji, and get a browser notification on a match or new message when the tab is hidden.
- Switch the interface language between English and Vietnamese; the choice is detected from the browser and saved per browser.
- Report a current partner with a reason, then review and resolve reports in `/admin`.
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

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and Socket.IO port. |
| `DATA_DIR` | `./data` | Directory where durable report records are stored. |
| `ADMIN_TOKEN` | _(required for admin)_ | Secret used to protect the moderation dashboard and API. |
| `REDIS_URL` | _(optional)_ | Enables the Socket.IO Redis adapter for multi-instance deployments (e.g. `redis://localhost:6379`). |

To enable moderation, set a strong token before starting the app:

```powershell
$env:ADMIN_TOKEN = 'use-a-long-random-secret'
npm start
```

Open `http://localhost:3000/admin` and enter the same token. The token is retained only for that browser session.

## Safety behaviour and limitations

Blocks use an anonymous random ID stored only in the visitor's browser. The blocked ID is sent to the server only to avoid matching that browser with the same person again. Clearing browser data creates a new ID, so this is a user-safety feature, not an account-level ban system.

The 18+ confirmation is a self-attestation, not identity or age verification. It is intended to set a clear entry rule and cannot prevent a determined visitor from bypassing it.

Reports are validated, stored in `DATA_DIR/reports.json`, and also written as structured `REPORT {...}` server logs. The `/admin` dashboard can filter reports and mark them reviewed or resolved. Establish a moderation process and protect the `ADMIN_TOKEN`; the app deliberately does not store chat messages.

Profanity masking covers a basic word list and can be extended in `index.js`. Auto-suspension is a lightweight safeguard: when an anonymous client is reported enough times within the configured window, it is temporarily blocked from matching. Active bans are persisted to `DATA_DIR/bans.json` (atomic write) and reloaded on startup, so they survive restarts and redeploys. Expired bans are pruned automatically. This is not a substitute for human moderation.

A public `GET /health` endpoint reports `status`, uptime, current online and waiting counts, total matches, the rolling average match wait, and the number of active bans. Use it for uptime checks and basic monitoring.

For a production release, also put the app behind HTTPS, add a reverse-proxy/IP-level rate limit, publish a privacy policy, and monitor error and report logs.

## Scaling to multiple instances

Set `REDIS_URL` to attach the [Socket.IO Redis adapter](https://socket.io/docs/v4/redis-adapter/), which delivers events across instances. The `redis` and `@socket.io/redis-adapter` packages are listed as optional dependencies and are loaded only when `REDIS_URL` is set; if the connection fails at startup, the app logs the error and continues in single-instance mode.

Note one current limitation: the matchmaking queue, partner relationships, bans, and online counts are still kept in each instance's memory. With several instances behind a load balancer you should therefore enable **sticky sessions** so a visitor stays on one instance for the duration of their session. In that setup each instance matches visitors within its own connected pool. Matching across the entire pool (a shared queue in Redis) and cross-instance partner state are a larger follow-up that builds on this adapter.

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

The `Dockerfile` works with any container host that supports an HTTP service. Configure the host to expose port `3000` (or set `PORT` to the port it provides), terminate HTTPS at the host or proxy, and mount persistent storage at `/app/data` so reports survive redeploys.
