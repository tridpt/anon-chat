# Contributing to GhostChat

Thanks for your interest! GhostChat is a small, dependency-light project: Node.js,
Express, and Socket.IO on the server, and plain HTML/CSS/JavaScript on the client.
No build step.

For a detailed technical walkthrough (in Vietnamese), see [`TAI_LIEU.md`](TAI_LIEU.md).

## Getting started

Requires Node.js 20 or newer.

```bash
npm ci        # install dependencies from the lockfile
npm start     # run the server at http://localhost:3000
npm run dev   # run with --watch (auto-restart on changes)
npm test      # run the test suite (node --test)
```

To try matchmaking locally, open two different browsers (or one normal and one
incognito window) so each gets a distinct anonymous `clientId`.

## How to contribute

1. Fork the repo and create a branch: `git checkout -b feature/your-feature`.
2. Make your change. Match the existing style (vanilla JS on the client, the
   `LIMITS` object for tunable server limits, `safelyHandle` for socket handlers).
3. Add or update tests in `test/chat-server.test.js` when you change behavior.
4. Run `npm test` and make sure everything passes.
5. Commit with a clear message and open a Pull Request describing what and why.

## Good first contributions

- **Extend the profanity list** or refine matching — see `PROFANITY` and the
  matchmaking helpers in `index.js`.
- **Add interface translations** — extend the `en`/`vi` dictionaries in
  `public/i18n.js` (and add `data-i18n` attributes in `public/index.html`).
- **Tune limits** — adjust the `LIMITS` object (rate limits, auto-ban thresholds).
- **UI polish** — `public/style.css` (uses CSS variables for dark/light themes).

## Guidelines

- Keep the client framework-free and the server in a single, readable `index.js`.
- Validate all socket input on the server; never trust client-provided data.
- Do not log or persist chat message contents — the app deliberately stores no chat history.
- Never commit secrets (e.g. `ADMIN_TOKEN`) or the `data/` directory.
- Update the docs (`README.md` / `TAI_LIEU.md`) when behavior changes.

## Reporting security issues

Please do not open a public issue for security problems. See [`SECURITY.md`](SECURITY.md).
