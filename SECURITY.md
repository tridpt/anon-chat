# Security Policy

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue, pull
request, or discussion for a vulnerability.

- Use GitHub's [private vulnerability reporting](https://github.com/tridpt/anon-chat/security/advisories/new) (Security tab → "Report a vulnerability"), or
- Contact the maintainer directly through their GitHub profile.

Please include:

- A description of the issue and its impact.
- Steps to reproduce or a proof of concept.
- Affected version or commit.

We aim to acknowledge reports within a few days and will keep you updated on the fix.

## Scope and notes

This project is an anonymous chat service. A few design points worth knowing:

- The app stores masked chat transcripts for the configured retention period;
  treat the data directory as sensitive.
- Ban appeal explanations are also stored in `DATA_DIR/appeals.json` and may contain
  sensitive information; protect and retain this file under the same policy as transcripts.
- The `18+` confirmation is a self-attestation, not identity or age verification.
- Blocking uses a browser-local random `clientId`; it is a user-safety feature,
  not an account-level ban.
- The moderation dashboard uses `ADMIN_TOKEN` to bootstrap a named admin account
  and as an emergency server-to-server credential. Browser requests use a
  short-lived, `HttpOnly`, `SameSite=Strict` session cookie. Named moderator
  passwords are salted `scrypt` hashes in `DATA_DIR/moderators.json`; never
  commit either that file or the token. Run the app behind HTTPS and an IP-level
  rate limit in production.
- Roles are enforced server-side: `admin` manages moderator accounts, `moderator`
  handles reports, bans, and transcript deletion, and `viewer` is read-only.
  Account status and role are looked up on every request, so disabling an account
  also invalidates its existing sessions. Keep at least one active admin account.
- Existing automation may still use `Authorization: Bearer <ADMIN_TOKEN>`; keep
  those requests server-to-server and never expose the header in browser code.
- Live moderation notifications are delivered through `/api/admin/events` only after the
  `HttpOnly` admin session is validated; the stream carries event metadata, while report and
  transcript details are fetched through the protected APIs.
- Public appeal submission is limited to an actively banned anonymous client, guarded by
  same-origin checks and a per-IP daily limit. The anonymous `clientId` is not a durable identity,
  so a visitor who clears browser storage can obtain a new ID; appeals do not replace account-level
  identity or abuse controls.

## Supported versions

The latest version on the `main` branch receives security fixes.
