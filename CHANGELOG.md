# Changelog

All notable changes to GhostChat are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A cancel button on the waiting screen to leave the queue and return to login.
- Runtime-configurable profanity list via `PROFANITY_EXTRA` (comma-separated words) and
  `PROFANITY_FILE` (a JSON array), both additive to the built-in defaults.
- Coarse in-process per-IP rate limiting for HTTP requests (health checks exempt) and new
  socket connections, with `TRUST_PROXY` support for correct client IPs behind a proxy.
- Cluster-wide matchmaking when `REDIS_URL` is set: the waiting queue and room registry are
  shared in Redis and matches are orchestrated across instances, so sticky sessions are no
  longer required for matching. `/health` counts are aggregated across the cluster.
- A `docker-compose.yml` stack (two app instances + Redis) for verifying the shared queue.
- Short-lived browser admin sessions using `HttpOnly`, `SameSite=Strict` cookies, with sign-out,
  expiration, login throttling, and same-origin checks for moderation changes.
- Named moderator accounts with salted `scrypt` passwords, `admin`/`moderator`/`viewer` roles,
  immediate account revocation, team management, and actor-aware moderation audit events.
- Ban appeals with a public submission form, durable appeal storage, report/transcript links,
  and moderator approval or rejection actions that lift or preserve the ban.
- Authenticated admin event streaming for new report/appeal notifications, tab badges, and
  automatic moderation-list refreshes.
- A timestamped JSON backup utility (`npm run backup`) with SHA-256 manifests, configurable
  retention, scheduled startup/interval backups, and a direct Node staging profile.
- An admin-only Backups tab that verifies snapshot checksums and JSON before showing a
  preview, queues an explicitly confirmed recovery, and creates a safety backup before
  applying the recovery on the next startup.
- A smoother chat experience: expiring typing states, preserved scroll position with an
  unread-message jump button/title badge, and an in-chat block confirmation that saves only
  after server acknowledgement.
- Post-chat ratings with optional comments, admin feedback totals, and a safe report-and-block
  flow linked to the ended transcript.

### Changed

- Compacted the login screen layout and replaced the native language `<select>` with a
  custom, theme-aware dropdown with centered options.
- Interest chips now insert the localized (translated) label.
- Moved "manage blocked people" to a corner icon button on the login screen.
- Reduced the no-match fallback pairing time from 10s to 5s.

### Fixed

- Emoji picker and reaction panels not closing because a CSS `display` value overrode
  the `hidden` attribute.
- Centered the blocked-people and report modal dialogs (were pinned to the top-left).
- Login form no longer needs a visible scrollbar; the language dropdown options are readable.

## [1.1.0] - 2026-06-26

### Added

- Emoji picker in the message composer and per-message emoji reactions.
- Dark/light interface theme toggle, saved per browser.
- Full English/Vietnamese interface internationalisation with a language switcher.
- Browser notifications on a match or new message when the tab is hidden.
- Server-side profanity masking and a per-message link limit.
- Report-based automatic suspension (auto-ban) with bans persisted to disk and
  reloaded on startup.
- Public `/health` endpoint exposing uptime, online/waiting counts, total matches,
  and active bans.
- Optional Socket.IO Redis adapter (`REDIS_URL`) for multi-instance deployments,
  with graceful single-instance fallback.
- Detailed Vietnamese technical documentation (`TAI_LIEU.md`).
- Continuous integration (GitHub Actions) running the test suite on Node 20 and 22.
- Tests for profanity masking, link limits, reactions, auto-ban, ban persistence,
  and the health endpoint.

## [1.0.0]

### Added

- Anonymous one-on-one matchmaking by shared interests and language preference.
- Real-time chat with typing indicators and localized icebreaker prompts.
- Live queue status with waiting count and estimated wait time.
- Skip, block (with undo), and report flows.
- Self-attested 18+ and Community Rules acknowledgement before joining.
- Moderation dashboard at `/admin` protected by `ADMIN_TOKEN`, with durable report storage.
- Server-side validation, payload/size limits, queue limits, and per-socket rate limits.
- Docker support.

[Unreleased]: https://github.com/tridpt/anon-chat/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/tridpt/anon-chat/releases/tag/v1.1.0
