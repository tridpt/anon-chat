# GhostChat

Anonymous, one-on-one chat with interest-based matching. GhostChat does not create accounts or store chat history.

## Features

- Match two people by shared interests while prioritizing compatible Vietnamese, English, or any-language preferences.
- Offer localized icebreaker prompts after a match, based on shared interests when possible.
- Show the live number of people waiting and a wait-time estimate based on recent matches.
- Select popular interest chips or type custom interests before matching.
- Skip a chat, block a current partner, and manage or undo blocks in the browser.
- Report a current partner with a reason, then review and resolve reports in `/admin`.
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

To enable moderation, set a strong token before starting the app:

```powershell
$env:ADMIN_TOKEN = 'use-a-long-random-secret'
npm start
```

Open `http://localhost:3000/admin` and enter the same token. The token is retained only for that browser session.

## Safety behaviour and limitations

Blocks use an anonymous random ID stored only in the visitor's browser. The blocked ID is sent to the server only to avoid matching that browser with the same person again. Clearing browser data creates a new ID, so this is a user-safety feature, not an account-level ban system.

Reports are validated, stored in `DATA_DIR/reports.json`, and also written as structured `REPORT {...}` server logs. The `/admin` dashboard can filter reports and mark them reviewed or resolved. Establish a moderation process and protect the `ADMIN_TOKEN`; the app deliberately does not store chat messages.

For a production release, also put the app behind HTTPS, add a reverse-proxy/IP-level rate limit, publish a privacy policy, and monitor error and report logs.

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
