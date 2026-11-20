# API Shape

Backend ownership boundaries and endpoint contracts for work resolution, lyrics, custom works, library lists, and the access-policy middleware.

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
[Recommendation catalog and generations](../data-model/recommendations.md#recommendation-catalog-and-generations).
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
[Data model](../data-model.md).

`GET /api/works/{id}/file-display-names` requires `library:read` and lists the
local files and folders of the work whose media the detail shows, by their path
below the work folder, with their [display names](../data-model/file-availability.md#file-availability)
by language. `PUT` requires `library:write` and sets, in one transaction, up to
5,000 names of one supported metadata language: each file names a media item
with an available local file of that work and each folder one of the listed
folders, and an empty name removes that language's name. A name is at most 255
characters and holds no path separator or control character. Both answer with
the current list.

`GET /api/custom-works/folders`, `GET /api/custom-works/folder`,
`GET /api/custom-works/tree`, `POST /api/custom-works`, and
`GET`/`POST /api/custom-works/notice-acceptance` require both `library:write`
and `downloads:manage` and are unavailable in Demo. The list walks the folders a
local scan can observe and returns at most 200 folders that can become a
[custom work](../data-model/custom-works.md#custom-works), as paths relative to the data root,
with `inUse` for a folder Fetch writes into and `noticeAccepted`; `q` narrows it
by path. `folder?path=` checks one path, relative to the data root or starting
with the data root's absolute path, and answers the folder or 409. `tree?path=`
lists at most 500 folders directly inside one folder, or the top level of the
scan scope for an empty path: every folder that can become a custom work and
every folder on the way to one, each with `selectable`, `hasChildren`, and a
`reason` (`holds_works`, `in_use`, or `storage_pool`) when it is not
selectable. It walks only that folder's subtree and leaves out folders that
carry a work code and the folders inside them. `GET` on the notice acceptance
reports whether the current rename notice version is accepted, without reading
the library, and `POST` records it. The create request names one path
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
database, upstream, endpoint, or filesystem details. Logs and workflow runs
may retain protected diagnostics when they are necessary to operate the
instance.

The access-policy middleware runs after authentication has resolved a session
and before Demo content or handlers. Health, login/logout, initial setup, current-auth
state, minimal mode/access runtime settings, the public library migration
status, and CORS preflight remain available for bootstrap. Operational runtime settings are omitted while production sign-in is
required. Every other unauthenticated request is rejected unless the stored
anonymous-access policy is enabled, in which case only `GET` and `HEAD` continue.
While anonymous remote browsing is off, the middleware also refuses remote
routes and remote or cache media for those requests and marks the rest
local-only; handlers then refuse a work without a local folder in its family
and keep only local works, locations, and source counts in what they return.
The rule and the routes it covers are in
[Authentication and Cookies](../../operations/security.md#authentication-and-cookies).
The cached effective value is loaded before the server starts and updated only
after the SQLite setting and audit entry commit.
