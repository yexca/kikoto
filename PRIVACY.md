# Privacy and Data Handling

Kikoto is a self-hosted, local-first media library. This document describes the
data flows implemented by the current repository so operators can make informed
deployment decisions. It is not a substitute for the privacy terms of a remote
source, metadata provider, reverse proxy, hosting provider, or network operator.

## Project-Operated Services

The current Kikoto repository does not include a project-operated cloud sync,
analytics upload, advertising, or crash-report upload service. Application data
is stored by the Kikoto instance and its clients unless an operator configures an
external source or a user deliberately opens or shares an external link.

Kikoto records bounded recommendation events locally so the instance can explain
and tune its personal recommendation behavior. These events contain the local
user and work identifiers, event type, bounded context identifier, algorithm
version, seed, rank, score, and timestamp. They remain in the instance SQLite
database and are not a project telemetry feed.

## Server-Side Data

The `/config/kikoto.db` SQLite database may contain:

- Usernames, display names, roles, password hashes, and active session state.
- Personal favorites, tags, listening marks, and playback cursors.
- Remote-source configuration, including private endpoints and credentials when
  an adapter requires them.
- Local media metadata and paths below configured roots.
- Workflow definitions, inputs, events, errors, and review history.
- Local recommendation events and settings.
- Account-owned listening sessions, lifetime totals, and daily listening time.

Personal listening history is retained until cleared or its account/work is
deleted; recommendation-event retention does not remove it. Clearing history
keeps only an account counter to reject delayed retries. Data transfer exports work
codes, personal marks/notes/ratings, portable resume targets, listening totals,
playlists and custom tags. It excludes media, source settings, credentials,
local paths, provider metadata and raw sessions. Treat an exported personal
document as private collection data.

The `/cache` mount may contain derived covers, media cache entries, playback
derivatives, and other rebuildable assets. The `/data` mount contains operator
media plus durable Fetch staging, rollback, and review directories. Treat all
three mounts as private even when an operator enables anonymous access to a
subset of Library data through the application.

Kikoto does not currently provide application-level encryption at rest. Host
filesystem permissions, disk encryption, backup controls, and container access
protect stored data.

## Browser and Mobile App Data

The browser stores presentation and continuity state such as theme, layout,
player Dock mode, scoped browse restoration, and a validated playback queue.
Account-bearing browser state is scoped by configured server identity and user.
IndexedDB also retains a bounded outbox of unconfirmed playback checkpoints and
cumulative listening sessions, with work/media/location ids and occurrence UTC
timestamps. It contains no credentials, titles, source URLs or file paths.
Confirmed records are removed; unconfirmed or quarantined reports remain in
their original server/account scope across sign-out until acknowledged, history
clearing invalidates them, or browser/app storage is cleared. Queue capacity and
recovery behavior are described in
[Playback reports](docs/architecture/frontend.md#playback-reports).

The Android client stores the configured server address and a bearer session in
the app's private preferences. The iOS client stores the configured server
address in its app preferences and the bearer session in the Keychain, readable
after the first unlock and never restored from a backup or moved to another
device. Neither app keeps the session in WebView storage. Clearing the
configured server clears the stored session. Recent Android diagnostics are kept in memory until the app process
ends and are exported only when the user chooses to copy them.

## Anonymous Library Access

Production mode requires authentication by default. A super administrator can
enable anonymous Library browsing and media playback under Settings -> Users.
While that setting is enabled, authentication still protects personal state,
configuration, and mutations, but it is not a privacy boundary for the complete
Library. Restrict network access when the collection itself must remain private.

## Outbound Requests

Kikoto may send requests to:

- Metadata providers used to identify or enrich a work.
- Remote source endpoints configured by an administrator.
- Media, cover, or public-work URLs returned by a configured source. By default
  these may use any public origin; a source with **Restrict outbound hosts**
  stays on its configured origins and allowed hosts. See
  [Deployment security](docs/operations/security.md).
- A Kikoeru-compatible server whose address a user enters for a Kikoeru
  account import, for that request only.
- The GitHub Releases API, from the server, when someone opens the About page
  (cached for six hours).

Depending on the action, these requests may reveal the instance IP address,
requested work identifier, search terms, source path, standard HTTP headers, or
credentials configured for that endpoint. Third-party processing is controlled
by that service and the operator's agreement with it, not by this document.

## Logs, Diagnostics, and Support

Server logs and workflow Activity may contain local paths, work identifiers,
configured endpoints, and upstream error details. A copied Android diagnostic
report may contain the configured server address, current username, versions,
connection state, and recent API errors.

Review and redact diagnostics before sharing them. Do not post databases,
credentials, session tokens, private endpoints, personal media paths, or media
files in a public issue. Follow [SECURITY.md](SECURITY.md) for a suspected
vulnerability.

## Backup and Removal

Backups of `/config`, `/data`, or `/cache` inherit the sensitivity of their
source. Use encrypted, access-controlled backup storage and a consistent SQLite
backup procedure.

Removing a browser profile, Android app data, database row, or container does
not remove copies retained in backups, reverse-proxy logs, or third-party
services. Operators are responsible for the retention and deletion policy of
those systems.

## Related Documentation

- [Security policy](SECURITY.md)
- [Runtime security](docs/operations/security.md)
- [Database operations](docs/operations/database.md)
- [Configuration](docs/operations/configuration.md)
