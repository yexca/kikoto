# Settings

Settings exposes administrator-managed runtime behavior.

## Current Settings

- Local scan depth.
- Remote cache behavior.
- Cache limits.
- Remote fetch path template.
- Remote request delay and backoff.
- DLsite metadata language.
- Local and compatible remote file sources.
- Circle auto-refresh threshold.

## Source Configuration

Administrators can add, update, disable, and remove compatible remote sources.
Creating or updating a source can trigger a batch availability check for recent
local works, gated by source health.

## Runtime Versus Environment

Environment variables provide startup defaults. Settings stores administrator
choices after startup and should remain the authority for configured sources
once the database exists.

## Related Docs

- [Configuration](../operations/configuration.md)
- [Sources](sources.md)
- [Security](../operations/security.md)
