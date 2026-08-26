# Backend

The backend is a Go HTTP API with SQLite persistence.

## Stack

- Go standard `net/http`.
- SQLite.
- Embedded SQL migration catalog and generated fresh-install baseline in
  `backend/migrations/`.
- Docker-first runtime.

## Main Packages

- `backend/internal/httpapi`: HTTP handlers and feature orchestration.
- `backend/internal/localfs`: local folder discovery.
- `backend/internal/dlsite`: DLsite client and parsing.
- `backend/internal/kikoeru`: Kikoeru-compatible client.
- `backend/internal/metasync`: metadata sync.
- `backend/internal/storage`: database opening and migrations.
- `backend/internal/workflow`: workflow persistence helpers.

## Runtime Responsibilities

- Authenticate users and enforce permissions.
- Enforce the production instance access policy before API handlers, with
  sign-in required by default and optional anonymous `GET`/`HEAD` access.
- Scan local libraries.
- Sync metadata snapshots.
- Serve library and detail APIs.
- Browse and sync remote sources.
- Stream local media with range support.
- Publish complete-duration HLS VOD manifests for incompatible local or cached
  video and generate independently seekable, quota-bounded segments under the
  disposable cache root.
- Record workflow runs and activity state.
- Claim durable workflow jobs by priority and serialize jobs that share a
  resource lane.
- Coalesce concurrent local-media indexing for the same work, keep duration
  probes serialized per server, and expose slow index phase timings in logs.

## Code Organization

HTTP handlers own transport concerns: authentication context, request decoding,
response encoding, and status mapping. Reusable domain state transitions,
filesystem transactions, source adapters, and workflow persistence should move
behind focused packages or services as they become independently testable.

Avoid adding unrelated orchestration to already broad handler files. Extract by
cohesive behavior rather than moving a large file mechanically, and keep
dependencies directed from HTTP composition toward domain and storage code.

## API Shape

The backend owns aggregate source availability checks, workflow recording, and
state transitions that should not be spread across the frontend. The frontend
should not fan out directly to every source when one aggregate endpoint can own
the result and diagnostic trail.

Work summary and media APIs remain separate. The media endpoint resolves the
media-bearing edition and loads media items directly; it does not repeat the
complete metadata, credit, tag, and manual-override detail projection.

Public errors use a stable code and retryability decision without returning raw
database, upstream, endpoint, or filesystem details. Logs and workflow Activity
may retain protected diagnostics when they are necessary to operate the
instance.

The access-policy middleware runs after authentication has resolved a session
and before Demo content or handlers. Health, login/logout, current-auth state,
minimal mode/access runtime settings, and CORS preflight remain available for
bootstrap. Operational runtime settings are omitted while production sign-in is
required. Every other unauthenticated request is rejected unless the stored
anonymous-access policy is enabled, in which case only `GET` and `HEAD` continue.
The cached effective value is loaded before the server starts and updated only
after the SQLite setting and audit entry commit.

## Outbound Requests

An administrator-configured source endpoint may intentionally be on a private
LAN. Source-returned media, cover, and redirect destinations remain untrusted
input. New or changed clients must define their permitted origin boundary,
revalidate allowed redirects, prevent DNS-rebinding time-of-check/time-of-use
gaps, remove credentials on origin changes, and bound time, response size,
stream size, concurrency, and retries.

The shared outbound transport accepts only HTTP(S) URLs without embedded
credentials, validates the initial request and every redirect hop, strips
credentials on allowed origin changes, validates the complete DNS answer, and
dials one of those same validated numeric addresses. Built-in public metadata
destinations reject private and reserved addresses. Administrator-configured
source origins may explicitly reach private LAN addresses.

Compatible remote sources default to public-host compatibility mode so a
source may move media, cover, or text storage to another public origin without
a Kikoto configuration change. The configured API, public-site, and fallback
origins retain their explicit private-address exception; every other origin
must resolve only to public addresses. An administrator can instead restrict a
source to those configured origins plus exact public hostnames or leading
wildcards such as `*.media.example.invalid`. A wildcard matches subdomains, not
the parent hostname, and additional hosts never inherit the private-address
exception.

The hardened transport connects directly rather than inheriting ambient HTTP
proxy variables, because a proxy would require its own explicit DNS and
destination trust boundary. Connection, response-header, response-read idle,
buffered-body, streamed-file, concurrency, and retry bounds remain specific to
the request class. See
[Secure development](../development/security.md) and
[Runtime security](../operations/security.md) before extending an outbound
request path.

## Current Limits

- Some operations remain synchronous even though the major Fetch, cache,
  cleanup, scan, metadata, and custom workflow paths use persisted jobs.
- The embedded job runner is single-instance and SQLite-backed; it is not a
  distributed worker system.
- Retry, cancellation, and restart recovery are defined per job family rather
  than by one universal guarantee.

## Related Docs

- [Workflows](workflows.md)
- [Data model](data-model.md)
- [Backend guidelines](../development/backend-guidelines.md)
