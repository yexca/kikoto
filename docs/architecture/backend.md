# Backend

The backend is a Go HTTP API with SQLite persistence.

## Stack

- Go standard `net/http`.
- SQLite.
- Embedded SQL migration catalog and generated fresh-install baselines in
  `backend/migrations/` (see [Migrations](../development/migrations.md)).
- Docker-first runtime.

## Main Packages

- `backend/internal/httpapi`: HTTP handlers and feature orchestration.
- `backend/internal/account`: user identity, password credentials, sessions,
  and role permission expansion.
- `backend/internal/accesspolicy`: the stored anonymous-access policy and its
  cached effective value.
- `backend/internal/library`: persisted work browsing: search parsing, list
  queries and projection, batch enrichment, and recommendation sessions.
- `backend/internal/storagepool`: storage pool layout below the data root and
  the marker that distinguishes an online pool from an empty mount point.
- `backend/internal/localfs`: local folder discovery.
- `backend/internal/download`: the bounded atomic download writer, cover
  publication, and raster image type detection.
- `backend/internal/dlsite`: DLsite client and parsing.
- `backend/internal/kikoeru`: Kikoeru-compatible client, including the
  account and SQLite readers used by personal data import.
- `backend/internal/metasync`: metadata sync.
- `backend/internal/remotemetadata`: remote source metadata ordering,
  bounded snapshot decoding, and reconciliation for the opt-in fallback.
- `backend/internal/metadatatags`: shared metadata tag concepts, projection,
  and selection, independent of provider snapshots and personal tags.
- `backend/internal/metadatatitles`: display-title selection from edition,
  declared remote, and manual titles without changing provider data.
- `backend/internal/outbound`: the shared outbound transport policy, forward
  proxy dialing, and proxy failover.
- `backend/internal/proxyconfig`: outbound proxy configuration validation and
  per-scope proxy resolution.
- `backend/internal/storage`: database opening and migrations.
- `backend/internal/sqlutil`: shared `database/sql` helpers with no application imports.
- `backend/internal/workflow`: workflow persistence helpers, lease-based
  settlement of orphaned jobs, and release of jobs interrupted by a service stop
  (recoverable jobs requeue from their checkpoint, others fail).
- `backend/internal/personal`: account-owned tag changes, durable listening
  history, and transactional personal data transfer.

## Runtime Responsibilities

- Authenticate users and enforce permissions.
- Enforce the production instance access policy before API handlers, with
  sign-in required by default and optional anonymous `GET`/`HEAD` access.
- Scan local libraries.
- Sync metadata snapshots.
- Serve library and detail APIs.
- Browse and sync remote sources.
- Stream local media with range support.
- Prepare incompatible local or cached audio as complete, quota-bounded MP3
  cache files with duration and HTTP Range support, preserving original media.
- Publish complete-duration HLS VOD manifests for incompatible local or cached
  video and generate independently seekable, quota-bounded segments under the
  disposable cache root.
- Record workflow runs and activity state.
- Claim durable workflow jobs by priority through one global executor, so only
  one workflow job runs at a time.
- Coalesce concurrent local-media indexing for the same work, keep duration
  probes serialized per server, and expose slow index phase timings in logs.

Local duration probing runs in one service-scoped worker. Indexing coalesces
wakeups instead of retaining file lists in waiting goroutines. The worker reads
at most 64 pending local locations at a time, skips complete duration metadata,
and resumes missing or unversioned metadata on startup. Local file observations
include size and nanosecond modification time; scans clear derived duration and
audio metadata after a change, and probes commit only against their observed
location id and file version. Probe reads use the same online-pool and work-root
depth scope as scans. Identical size and preserved modification time cannot be
distinguished without content hashing. A pass has a fixed location-id frontier;
indexing during a pass requests one follow-up. Duration probes share the
bounded FFprobe runner with playback probes: at most two concurrent processes,
two waiters that give up after one second, a five-second limit per probe
including that wait, and 128 KiB of output. Shutdown cancels active probing.

Compatibility preparation starts only from a playback request for that file,
including the player's single next-track preload, which requests the same
playback URL. The backend never prepares an unplayed queue, work, or library in
the background, because speculative preparation would spend the two transcode
slots and the shared cache quota without a demonstrated benefit.

Query planner statistics are refreshed by one bounded background worker after
committed bulk changes; GET requests never run analysis. Its triggers and
bounds are in [Database maintenance](../operations/database.md#maintenance).

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

Work summary and media APIs are separate. The media endpoint resolves the
media-bearing edition and loads media items directly; it does not repeat the
complete metadata, credit, tag, and manual-override detail projection.

`GET /api/works/{code}/resolve` reads persisted edition and alias relationships
without updating them or scheduling title projections, so repeated resolution
never writes. A legacy snapshot resolves its declared origin without a write.
Metadata ingestion and synchronization own relationship maintenance.

`GET /api/works/{id}?includeMedia=false` and `GET /api/works/{id}/media`
accept either a numeric work id or a work code in `{id}`. A code uses the same
read-only canonical resolution, including aliases and legacy origins; a numeric
id selects that exact edition. Both forms apply the same access, Demo
visibility, and media-selection rules, so a direct link requests summary and
directory in parallel without a preceding resolve.

Cold recommendation session preparation admits at most 32 active or queued
requests, coalesces matching tasks, bounds CPU preparation concurrency, and
serializes short publication writes. Waiting tasks borrow no database connection.
Warm sessions reuse frozen profiles. Cancellation releases a queue place; a full
queue or an unpublished initial catalog returns a retryable 503
`service_unavailable`. The shared catalog worker and versioning rules are in
[Recommendation catalog and generations](data-model.md#recommendation-catalog-and-generations).
Demo bypasses catalog preparation and uses the simulated scores described there.

`PUT /api/works/{id}/lyrics-assignments` requires `library:write` and sets or
clears, in one transaction, the shared lyrics file of up to 2,000 audio items
in the work's edition family; each lyrics file must be a text item of the same
work as its audio. `PUT` and `DELETE /api/media/{id}/lyrics-preference` require
`playback:use` and set or clear the signed-in user's own lyrics choice for one
audio item under the same same-work rule. How clients rank preferences,
assignments, and name matching is in [Data model](data-model.md).

The Library list endpoint always returns one bounded page; a request without
page parameters receives the first page of the default order. No endpoint
returns the complete library in one response.

Library pagination selects normalized fields and ordering inputs before loading
media aggregates, source presence, and metadata snapshots for the selected page.
Ordinary sorting projects only its selected page, then optionally scores up to
100 displayed works. Recommendation sorting uses bounded candidate recall and
lane windows over the complete exploration tail. Voice credits are loaded in
one batch per page and alternate-edition availability is loaded only when the
media edition differs. Optional badge failures return the page with
`recommendationUnavailable`; recommendation-sort preparation failures remain
retryable errors. The list returns `recommendationContext` for owner- and
generation-validated query explanations. Count, complex filters, deep offsets,
and large user feedback profiles retain their corresponding read costs.

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

## HTTP Responses

`POST /api/playback-reports` requires `playback:use`, accepts up to 32 resume
checkpoints and 64 dated cumulative listening reports, and bounds JSON to
128 KiB. Strict JSON/envelope errors reject the request before mutation.
Finite nonnegative positions, matching media locations, valid session ids,
bounded cumulative totals and sorted UTC date buckets are validated per item.
Dates must sum to the cumulative total; accepted buckets cannot decrease or
disappear. Occurrence timestamps cannot be more than five minutes in the future.
All accepted items commit in one transaction; unexpected database errors or
cancellation roll back the entire batch. Expected invalid/missing/conflicting
items return separate statuses. A history-generation rejection therefore does
not undo a valid resume checkpoint. A successful response acknowledges each
submitted id and returns the generation observed by the transaction.

Recorded and stale progress acknowledgements carry an `identity` object: the
unified cursor owner's `workId` and its persisted `editionWorkIds` (including
the owner and played edition). Membership is read in the same transaction,
without discovering or materializing works. Only a recorded checkpoint returns
a `cursor`; stale identity is ownership evidence, not permission to publish the
submitted position. Acknowledgements without a stored cursor omit `identity`.

`PATCH /api/media-items/{id}/progress` and `GET/POST /api/listening-sessions`
serve web and native clients that do not send playback reports; their responses
carry no `identity`. Undated sessions use receipt-date accounting. Dated
sessions use occurrence UTC buckets and cannot switch to the undated format
under the same session id. Resume and history are independent tables and are
never inferred from one another.

When the backend serves the bundled frontend, content-hashed files under
`/assets/` are cached for a year as `immutable`. HTML files including
`index.html` and the SPA fallback, `sw.js`, `theme-bootstrap.js`, and
`manifest.webmanifest` use `no-cache`, and other static files use a one-hour
public lifetime. A missing `/assets/` file returns 404 rather
than the app shell.

A response middleware gzip-compresses JSON, HTML, CSS, JavaScript, SVG, and web
manifest bodies of at least 1 KiB when the client accepts gzip, and adds
`Vary: Accept-Encoding` to those content types. It never compresses Range
requests, 206 responses, responses that already carry `Content-Encoding`,
event streams, or media, cover, and asset routes, and it preserves flushing.
Authentication responses are also excluded because a mobile sign-in response
returns a session token next to the reflected username. Without that exclusion,
compressed response length could leak the token (a BREACH-style attack). No other
response embeds a credential or CSRF token. The split-deployment
`frontend/nginx.conf` applies the same `/assets/` caching, `no-cache` app shell,
and static compression.

Every API request must start its response within 60 seconds. When it has not,
its request context is cancelled, so a request waiting for one of the file
database's four pooled connections cannot wait forever and hold up
authentication and every later request. A cancelled request answers with a
retryable 503 `service_unavailable` error. The budget stops once the handler
writes its headers, so event streams and long downloads are unaffected. Routes
that legitimately work longer before their first byte are registered with
`handleSlowFirstResponse`: synchronous media transcodes, remote-source
operations that make several paced upstream requests, and filesystem
maintenance that should not stop halfway.
The server also samples the connection pool every 10 seconds. It logs an error
when the pool stays fully checked out while new requests keep queueing, logs
the recovery afterwards, and warns when completed connection waits average a
second or more.

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
destinations reject private and reserved addresses; a NAT64 well-known-prefix
address (`64:ff9b::/96`) is judged by the IPv4 address it embeds, so DNS64
networks keep working. Administrator-configured
source origins may explicitly reach private LAN addresses.

Requests to a compatible remote source send `Accept-Language`: on behalf of a
signed-in user with a preferred metadata language, that user's languages
first, then the source's configured fallback language last, with decreasing
weights. The original language has no request language, so a viewer without a
preference, anonymous browsing, and results stored for everyone (crawls,
catalog refreshes, remote metadata fallback, downloads) send the fallback
language alone. The short-lived remote work snapshot
cache is keyed by the viewer's languages, so one viewer's response never serves
another language. The header changes no destination or transport policy.

Compatible remote sources default to public-host compatibility mode so a
source may move media, cover, or text storage to another public origin without
a Kikoto configuration change. The configured API, public-site, and fallback
origins retain their explicit private-address exception; every other origin
must resolve only to public addresses. An administrator can instead restrict a
source to those configured origins plus exact public hostnames or leading
wildcards such as `*.media.example.invalid`. A wildcard matches subdomains, not
the parent hostname, and additional hosts never inherit the private-address
exception.

The hardened transport never inherits ambient HTTP proxy variables. A policy
may instead name one operator-configured forward proxy, optionally with
credentials; it then dials only that proxy endpoint, with the configured
private-address exception, while URL, origin, and redirect checks still apply
to each request. Destination DNS is validated locally, and HTTP(S) CONNECT or
SOCKS tunnels target the same validated numeric address. Original Host and TLS
certificate checks are preserved; a configured proxy does not expand a
destination's private-address permission. The
`outbound_proxy_config` setting holds an ordered proxy list and routes for the
DLsite, remote-source, and other scopes, with per-source overrides;
`internal/proxyconfig` validates it and resolves a scope to proxies. Each
request path builds one policy transport per resolved proxy behind a priority
failover transport; the opt-in direct fallback adds a direct policy transport
that the failover always tries last. The DLsite transport and the pooled remote-source
transports rebuild when their resolved proxies change and close the previous
idle connections. A legacy `metadata_proxy_url` value is read as a DLsite route
until the proxy configuration is first saved. Connection, response-header, response-read idle,
buffered-body, streamed-file, concurrency, and retry bounds are specific to
the request class. See
[Secure development](../development/security.md) and
[Runtime security](../operations/security.md) before extending an outbound
request path.

Configured-source clients reuse a bounded pool of transports, keyed by source
identity and its complete outbound policy. Policy changes replace the transport
and close its idle connections; pooled requests retain URL checks and pinned
connections. Each origin has separate interactive, crawl, download, and playback
lanes. The first three serialize response bodies; playback permits four active
streams. Each lane admits at most 32 waiting requests, and queued cancellation
does not wait for the active response to finish.

`POST /api/works/{id}/lyrics-fetch` downloads lyrics files from a configured
source through that source's download lane and stages them on the target
work's storage pool before publication. Its permissions, destination checks,
and file, byte, and time limits are in
[Remote lyrics download](../development/security.md#remote-lyrics-download).

Remote queries requiring local filtering retain only upstream pages for up to
30 seconds, with at most 32 pages and 16 MiB of serialized data per server.
Pages larger than 2 MiB bypass the cache. Keys distinguish the viewer, complete
source configuration and invalidation generation, language, query and filter
plan, ordering, recommendation seed, and upstream page. Every request reads
current personal tags, marks and local availability again. Source configuration
is checked before and after a cached read or upstream request. Cache misses
use the existing outbound transport and request lanes; discovery never creates
new work identities. Upstream metadata may lag by the cache lifetime.

Remote covers accept JPEG, PNG, and WebP file signatures rather than trusting
upstream MIME headers or filename extensions. Publication retains the bounded
atomic download writer. Cover serving checks legacy cached content too and
sets an explicit raster MIME type, `nosniff`, and a sandboxed content policy.
It does not decompress or re-encode the image. Cover URLs carry a revision token
derived from the cached file; a request whose token matches the current file is
privately cacheable as immutable, while an unversioned or stale request is
revalidated.

## Current Limits

- Some operations remain synchronous even though the major Fetch, cache,
  cleanup, scan, metadata, and preset workflow paths use persisted jobs.
- The embedded job runner is single-instance and SQLite-backed; it is not a
  distributed worker system.
- Retry, cancellation, and restart recovery are defined per job family rather
  than by one universal guarantee.

## Related Docs

- [Workflows](workflows.md)
- [Data model](data-model.md)
- [Backend guidelines](../development/backend-guidelines.md)
