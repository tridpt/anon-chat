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

- The app deliberately **does not store chat messages**.
- The `18+` confirmation is a self-attestation, not identity or age verification.
- Blocking uses a browser-local random `clientId`; it is a user-safety feature,
  not an account-level ban.
- The moderation dashboard and API are protected by `ADMIN_TOKEN`. Never commit
  this token. Run the app behind HTTPS and an IP-level rate limit in production.

## Supported versions

The latest version on the `main` branch receives security fixes.
