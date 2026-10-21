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
- `backend/internal/dlsite`: DLsite client and parsing. Its product decoder
  accepts both array and numeric-keyed object forms of `language_editions`,
  and splits comma-separated provider language values when family sync matches
  an edition or its availability status.
- `backend/internal/kikoeru`: Kikoeru-compatible client, including the
  account and SQLite readers used by personal data import.
- `backend/internal/metasync`: metadata sync.
- `backend/internal/remotemetadata`: remote source metadata ordering,
  bounded snapshot decoding, and reconciliation for the opt-in fallback.
- `backend/internal/metadatatags`: shared metadata tag concepts, projection,
  and selection, independent of provider snapshots and personal tags.
- `backend/internal/contentpolicy`: shared deterministic ASR/LLM content
  assessment and service receive maxima, plus the separate Demo admission policy.
- `backend/internal/llm`: bounded translation protocols, endpoint configuration
  and lyrics templates. HTTP composition
  binds these to work identity, review persistence, file scope and workflow jobs.
- `backend/internal/asr`: speech recognition service configuration, the
  OpenAI-compatible transcription protocol, WebVTT rendering of timed
  segments, and quiet cut points between transcription chunks.
- `backend/internal/kikotohelper`: the Kikoto Helper task endpoints shared by
  `asr` and `llm`: the info probe, the translation task path and the helper's
  error codes.
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
A probe that FFprobe completes but cannot use, by exiting with an error,
printing invalid output, or exceeding the output limit, records the observed
version in `probe_failed_version`, and the worker skips that location until a
scan records another version. A timeout, a busy runner, cancellation, or a
missing FFprobe records nothing.

`GET /api/media/{id}/loudness` returns a local audio or video location's EBU
R 128 integrated loudness and peak. It is readable wherever the location's
stream is. When the file version on disk has none, the request measures it with
FFmpeg's `ebur128` filter on the first audio stream, asking for the true peak
and retrying with the sample peak, under the four-minute audio preparation
limit. Measurements run one at a time in their own slot, never in a transcode
slot, so playback conversion does not wait for them; a request waits at most
one second for that slot. FFmpeg's stderr is kept only as a 16 KiB tail for
the summary. Concurrent requests for one file share a measurement, a
measurement of a file that changed meanwhile is discarded, and the stored
result is keyed by the version the measurement read, even before a scan or
probe records that version for the location. Remote and cache locations answer
`404`, a busy slot `503 media_loudness_busy`, and a failed or timed-out
measurement `503 media_loudness_unavailable`; Demo measures nothing.

Audio preparation and realtime video conversion that ends before any output
remember a failure for 30 seconds, and loudness measurement remembers a failure
or timeout for an hour, keyed by purpose, path, size, and modification time,
holding at most 256 entries. A request in that time fails at once instead of
running FFmpeg again.

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
clears, in one transaction, up to 2,000 shared lyrics files of audio items in
the work's edition family. Each change names an audio item, a language (empty
for every language), and a lyrics file, which must be a text item of the same
work as its audio; a null lyrics file removes that language's assignment. `PUT` and `DELETE /api/media/{id}/lyrics-preference` require
`playback:use` and set or clear the signed-in user's own lyrics choice for one
audio item under the same same-work rule. `PUT` takes `lyricsMediaItemId`,
`lyricsOffsetMs`, or both; a field left out keeps its value, and an offset is
an integer from -30000 to 30000 where 0 removes it. `DELETE` clears only the
choice. Both answer with the item's current choice and offset. How clients
rank preferences, assignments, and name matching is in
[Data model](data-model.md).

`GET /api/works/{id}/file-display-names` requires `library:read` and lists the
local files and folders of the work whose media the detail shows, by their path
below the work folder, with their [display names](data-model.md#file-availability)
by language. `PUT` requires `library:write` and sets, in one transaction, up to
5,000 names of one supported metadata language: each file names a media item
with an available local file of that work and each folder one of the listed
folders, and an empty name removes that language's name. A name is at most 255
characters and holds no path separator or control character. Both answer with
the current list.

`GET /api/custom-works/folders`, `POST /api/custom-works`, and
`POST /api/custom-works/notice-acceptance` require both `library:write` and
`downloads:manage` and are unavailable in Demo. The list walks the folders a
local scan can observe and returns at most 200 folders that can become a
[custom work](data-model.md#custom-works), as paths relative to the data root,
with `noticeAccepted`; `q` narrows it by path. The notice acceptance records
the current rename notice version. The create request names one listed path
and an optional title, which defaults to the folder name. It answers 201 with
the work id, the assigned code, the renamed path, and the queued scan run; 409
`custom_work_notice_required` before the notice is accepted; and 409 when the
folder is no longer eligible or the library is unavailable.

Provider and remote-source actions on a custom work answer 409
`custom_work_unsupported`: `POST /api/works/{id}/metadata-sync` and
`.../metadata-preview`, `PUT .../metadata-link`, `.../purchase-bonus`, and
`.../bundle-members/{code}`, `POST .../folder-edit/sources/check`, and
`POST /api/works/{code}/source-availability`.
Filesystem failures are logged; the response does not name host paths.

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

Circle and voice actor work pages follow the same shape: one statement selects,
filters, orders, and counts the logical works, and only the selected page is
enriched. A voice actor's logical works are the canonical codes of the works
crediting them plus the codes of their remote catalog, so every edition of a
work counts once. The availability filter reads the available media locations
and source presence of a work's editions and the catalog's source rows; the
search reads the editions' Library search documents and the catalog row.

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
bounded cumulative totals and sorted date buckets are validated per item. A
bucket is a calendar date of the account's time zone as the client resolves
it, so it may be one day before the session's first UTC date or one day after
its last.
Dates must sum to the cumulative total; accepted buckets cannot decrease or
disappear. A date may split its listening into ascending hours of the day that
hold no more than the date; an hour reported lower keeps what it holds. Occurrence timestamps cannot be more than five minutes in the future.
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
carry no `identity`. `GET /api/listening-sessions` returns the history
generation with the time zone the account fixed, `null` while it follows the
device, and `hours: true` for a server that takes hour buckets. The listening
statistics, calendar, breakdown, and profile endpoints take the
device's zone as a `timeZone` query parameter and count days in the account's
zone as [User State](data-model.md#user-state) defines it; the calendar
response names that zone and whether it follows the device. Their `range` is
`30d`, `12m`, `all`, or a calendar year such as `2026`, which ends on its last
day or, for the current year, today. The calendar shows the year a range
names and the weeks up to today for any other range. Statistics list the years
with dated listening and the range's listening per hour of the day, and add a
year's highlights: its busiest day, the works first heard in it, and the voice
and circle listened to most. Undated sessions
are credited to the receipt date in the account's zone. Dated sessions use the client's occurrence date
buckets and cannot switch to the undated format under the same session id. Resume and history are independent tables and are
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

Error responses share one shape: `error`, a stable `code`, and `retryable`. A
request the caller got wrong answers with a 4xx, is not retryable, and is not
logged as an error. An addressed work, media location, source, alias, or
tracked source that does not exist is a 404 `not_found`; one of the wrong kind,
or in a state the operation does not apply to, is a 400 or a 409. A 502
`upstream_unavailable` means a remote source failed to answer. A source that
answers that it has no such work is a 404, and that answer leaves the source's
health unchanged. A Fetch the server refuses carries its own code, such as
`download_limit_exceeded`, `insufficient_disk_space`, or `source_not_usable`.
A JSON body with a value of the wrong type names the field in its 400 message.

Every API request must start its response within 60 seconds. When it has not,
its request context is cancelled, so a request waiting for one of the file
database's four pooled connections cannot wait forever and hold up
authentication and every later request. A cancelled request answers with a
retryable 503 `service_unavailable` error. The budget stops once the handler
writes its headers, so event streams and long downloads are unaffected. Routes
that legitimately work longer before their first byte are registered with
`handleSlowFirstResponse`: synchronous media transcodes, remote-source
operations that make several paced upstream requests, filesystem maintenance
that should not stop halfway, and the Kikoeru imports, which run under their
own deadlines.
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
`outbound_proxy_config` setting holds an ordered proxy list, routes for the
DLsite, remote-source, LLM and ASR, and other scopes, with per-source overrides,
and a bypass list; a stored configuration without the bypass list uses
`proxyconfig.DefaultBypass`. `internal/proxyconfig` validates it and resolves
a scope to proxies. A proxied policy dials a destination the bypass list
matches by hostname or by validated address directly, under the same address
rules. Each
request path builds one policy transport per resolved proxy behind a priority
failover transport; the opt-in direct fallback adds a direct policy transport
that the failover always tries last. The DLsite transport and the pooled remote-source
transports rebuild when their resolved proxies or bypass list change and close the previous
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

`POST /api/works/{id}/lyrics-edit/plan` and `POST /api/works/{id}/lyrics-edit`
preview and apply an edit of the lyrics Kikoto manages in one local work
folder. An addition is a lyrics file of that folder, which moves, a file of
another local folder of the family, which is copied, or a file a configured
source offers for a family edition, which is downloaded through that source's
download lane; each declares its language and lands in that language's lyrics
folder. The plan items share the Fetch plan item's shape and conflict
decisions. Copies and downloads are staged on the target work's storage pool,
removals run through media cleanup, and the work folder is rescanned; the
lyrics assignments and personal lyrics choices of a moved file follow it to the
media item of its new path. Its permissions and limits are in
[Lyrics files](../development/security.md#lyrics-files).

`POST /api/works/{id}/local-files/duplicates` requires `downloads:manage` and
reports the local files of the work's family that hold the same bytes, in any
of its editions and folders. It first indexes family folders that have no
indexed files, then hashes only files that share a size and caches each hash
per file version. One request hashes for at most 20 seconds and always
completes at least one file; a response with `complete: false` reports how
much is pending, and repeating the request continues from the stored hashes. A
link, an unreadable file, and a file that changes while it is read are left
out. The request never changes a library file.

`GET /api/works/{id}/bundle-candidates`, `PUT /api/works/{id}/bundle-members/{code}`,
and `DELETE /api/works/{id}/bundle-members/{code}` require `library:write` and
manage the members of the bundle a work is; see
[Bundles](data-model.md#bundles). A member cannot be a code of the work's own
family, and a bundle holds at most 64 members. Candidates come from the work's
DLsite series: the series' catalog codes in catalog order, then library works
of the work's circles whose stored DLsite metadata names the series, at most
32, leaving out members, removed members, and the family. The response reports
whether the title names a bundle or the bundle has members.

`GET /api/works/{id}/folder-edit/sources`,
`POST /api/works/{id}/folder-edit/plan`,
`POST /api/works/{id}/folder-edit/merge-check`, and
`POST /api/works/{id}/folder-edit`
edit one active local folder of a work. Sources lists the family's editions
with their local folders and stored source availability.
`POST /api/works/{id}/folder-edit/sources/check` first asks every enabled
remote source that passes its health check about each of the family's
editions, at most 16, one edition at a time, records the answers as their
stored availability, and then returns the same listing. A plan names the
files to add, from another active local folder of the family or from a remote
edition of the family, and the folder's local file locations to remove. An
addition with a declared `language` is a lyrics file of that language and
targets the language's folder inside `lyrics_kikoto`; any other addition may
name a `targetPath` below the folder instead of its own path. `moves` give
files of the folder another path below it, `folders` are folders to create,
and `mergeFolderIds` are other active local folders of the family to delete
once the folder holds what the edit copies from them. The plan checks that no
two files of the result share a path and that no file sits where a folder of
another path belongs; a path a removed or moved file frees can be taken, and
only that very file frees it: another file whose path differs only in letter
case or Unicode composition stays and is a conflict. It
resolves each addition's target as a Fetch plan does, with the same
decisions, and never changes a file. The merge check takes the same request
and lists the files of the merged folders that the edited folder will not hold
with the same size and SHA-256, hashing within a time budget, caching hashes on
the files' locations, and reporting `complete: false` while files remain to
compare; a remote addition is not compared, and a file an addition replaces
does not stay even when its path differs only as a case-insensitive
filesystem compares it. Metadata a NAS or operating system keeps beside files
(`@eaDir`, `__MACOSX`, `._` files, `.DS_Store`, `Thumbs.db`) is neither
listed nor compared and is deleted with its merged folder. A complete check
returns a `review` that identifies the files it compared, with their sizes
and modification times, and carries the files it reported lost. Apply of an
edit that merges folders requires that `mergeReview` and answers
`409 folder_edit_merge_changed` when the merged folders or the files the
edited folder keeps changed since the check, when comparing again finds a
merged file without a copy that the review did not report lost, such as a
file that can no longer be read, or a Fetch of a merged folder's work is still
running. Apply rejects a plan that has
conflicts or changes nothing, and queues one `work_folder_edit` run; a folder
has one active run, which also covers a folder another run merges, and a
repeated request id returns the run it queued. The run collects additions,
removes each removed file only while it is the version the plan saw on disk,
takes every moved file out of its place before any file takes a path,
publishes without ever replacing a file that appeared after planning, and
replaces an existing file only where a decision chose to and while it has the
size the plan saw, gives each moved file's media item its new path when the item
has no other available file outside the folders the edit merges, so its
references follow it; an item whose file at that path the edit removes gives
the path up and keeps its own references. It then removes the folders
it emptied, creates the requested folders, and indexes the folder. A resumed
or retried run never collects again a file it already published. It deletes
each merged folder last, only while it holds exactly the files the edit was
planned with and each of them the reviewed merge check did not report lost
still has a file of the same size and SHA-256 in the edited folder; otherwise the run
stops and asks for a new review. It marks the deleted folder's locations
unavailable and its folder ignored; a run that fails or is cancelled returns a
merged folder it had started on to the work, also while the edited folder is
offline. A run that stops before it finishes puts every moved file that left
its place but has not reached its new path back where it was; a file whose old
path another file took since stays in the run's staging folder for a retry.
Cancelling a run that no executor holds, such as one waiting for a retry, for
recovery after a restart, or for another job that is changing library
folders, settles it the same way once no other job is changing library
folders. A cancelled run that a service stop or an offline folder kept from
settling is settled at the next start. Apply may also carry
`assignments`, each naming an added lyrics file and an audio file of the work
by media item or by path below the folder; the run stores them in the lyrics'
language once it has indexed the folder, skipping a file the index does not
hold. Its permissions, destination checks, and limits are in
[Folder edit](../development/security.md#folder-edit).

A Fetch plan or Fetch request may carry `followUp`: folder edit additions,
decisions, and assignments for the folder the Fetch publishes. The plan
response then adds `followUp`, a folder edit plan resolved against that folder
with the Fetch's own targets already taken, so a follow-up file that would
land on a fetched file is a conflict. Once the Fetch completes, it queues one
`work_folder_edit` run on the folder it registered, with request id
`fetch-follow-up:<run id>`, and records `follow_up_run_id` or
`follow_up_error` in its run summary. `follow_up_error` holds only a reason
written for the user, which a `fetch.follow_up_failed` event of the Fetch run
repeats in Activity; any other cause stays in the server log. While the
library or a storage pool the follow-up reads or writes is offline, the
summary records `follow_up_waiting` instead, with one `fetch.follow_up_waiting`
event, and the workflow coordinator tries again every minute until the
storage is back. Startup recovery queues the follow-up of every completed
Fetch that records neither `follow_up_run_id` nor `follow_up_error`, so a stop
between the Fetch's completion and its follow-up neither loses the follow-up
nor queues it twice: the request id finds a run queued before the stop. A
failure of this recovery is logged and never keeps the service from starting.
Automatic Fetches never carry a follow-up.

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
