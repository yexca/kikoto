# Security

## Runtime Secrets

Keep credentials and real source details outside the repository. Use local
environment variables or mounted configuration files.

Do not commit:

- `.env` files with real values.
- SQLite databases.
- Remote source URLs with private tokens.
- Session cookies.
- Local media.

## Authentication

Kikoto supports local users, roles, sessions, and a development mode that
authenticates requests as the configured root administrator. Do not enable
development mode for shared or exposed deployments.

## Cookies

Set `KIKOTO_SESSION_COOKIE_SECURE=true` when serving Kikoto behind HTTPS.

## Related Docs

- [Configuration](configuration.md)
- [Docker](docker.md)
- [Contributing](../../CONTRIBUTING.md)
