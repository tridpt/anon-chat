# GhostChat

Anonymous, one-on-one chat with interest-based matching. GhostChat does not create accounts or store chat history.

## Features

- Match two people by shared interests, then fall back to the next available person.
- Skip a chat, block a current partner, and persist that block in the browser.
- Report a current partner with a reason for moderator follow-up.
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

## Safety behaviour and limitations

Blocks use an anonymous random ID stored only in the visitor's browser. The blocked ID is sent to the server only to avoid matching that browser with the same person again. Clearing browser data creates a new ID, so this is a user-safety feature, not an account-level ban system.

Reports are validated and written as structured `REPORT {...}` records to the server log. Before a public launch, route those logs to durable storage and establish a moderation process. The app deliberately does not store chat messages.

For a production release, also put the app behind HTTPS, add a reverse-proxy/IP-level rate limit, publish a privacy policy, and monitor error and report logs.

## Deploy with Docker

Build and run the image locally:

```bash
docker build -t ghostchat .
docker run --rm -p 3000:3000 -e PORT=3000 ghostchat
```

The `Dockerfile` works with any container host that supports an HTTP service. Configure the host to expose port `3000` (or set `PORT` to the port it provides), terminate HTTPS at the host or proxy, and keep server logs available for report review.
