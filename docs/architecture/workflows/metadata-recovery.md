# Metadata Recovery

How works with missing or failed metadata are listed, retried, and recovered.

## Metadata Recovery

Metadata synchronization is a workflow. Metadata management owns the current
attention list and the DLsite proxy shortcut; sync and its remote metadata
fallback configuration live in Workflows, and creator catalog freshness in
System → Library.
A run's detail links to the unresolved
issues encountered by that run. Selecting works queues recoverable family-sync
jobs, reusing an already queued/running job for that family, or asks one
selected remote source instead (see
[Remote Metadata Fallback](metadata-editing.md#remote-metadata-fallback)). Explicit recovery
can recheck a provider's `not_found` observation without erasing it first.
Normal bulk and work-detail refreshes skip unavailable products.
DLsite records `not_found` only when every candidate site and locale returned
an empty product list. If any request failed, the attempt is recorded as a
retryable failure.

A pending metadata issue is a failed attempt, or a not-found outcome for a work
that no remote source has filled and no operator has dismissed. A work a
[remote metadata fallback](metadata-editing.md#remote-metadata-fallback) filled is complete: its
DLsite not-found outcome stays recorded, but it leaves the issue list, run
pending counts, and the run lists' Needs attention. `POST /api/metadata/issues/dismiss`
(`metadata:sync`, refused in Demo) dismisses the selected works' not-found
outcomes, such as delisted products, with the same effect; it skips works
without one and never dismisses a retryable failure. A dismissal survives a
repeated not-found result, and an outcome with another status clears it. A
catalog family is not synced while none of its editions has a DLsite attempt
outcome, provider state, or snapshot.

The unified `/api/maintenance/works` read composes pending metadata issues and
not-synced catalog families with the Library's live no-source predicate, then
deduplicates and pages by family on the server. Edition/provider component
details, the not-synced state with whether its family sync is queued or
running, and the remote source that filled the family are attached only for
the selected page. Multiple reasons share one family row; resolving metadata
never removes a remaining no-source reason. Search reuses Library semantics.
`reason=metadata` and `reason=no_source` narrow the union. A run filter always
restricts it to unresolved metadata issues associated with that run. Recovery
queues a family sync for a selected not-synced family as for a pending issue. Every
reason except `reason=custom` leaves out custom works; `reason=custom` lists
every custom work family, with its no-source state, and nothing else. `/api/maintenance/works/counts` counts the families of the catalog, attention,
metadata, no-source, and custom views under the same permissions, leaving out
a view the caller may not open. It reads every family once and evaluates its
metadata and source predicates once for all views.
`/api/metadata/translation-coverage` pages every family, catalog and custom,
with the same search and narrows it to the parts missing in one target
language. It reads stored editions, manual titles and descriptions, accepted LLM translations,
shared tag names, file display names, lyrics assignments, and the family's
translation items in the language, and never contacts a provider. The
Translation page shows it, and selected works request Translate with AI one
work at a time. It requires `metadata:sync` or `library:write`.

Metadata reasons and retries require `metadata:sync`. No-source reasons, source
checks, and confirmed deletion require `sources:write`; the UI exposes deletion
for no-source families only in the attention view and, for custom works, the
custom view, and the server still revalidates family availability. Each
permission grants only its corresponding maintenance actions. Metadata
management chooses the Works group (All, Needs attention, and Custom works)
and the Entries group (Tags, Circles, and Voice actors) from the page's top
tabs; the page reads `reason=metadata` and `reason=no_source` links as Needs
attention. Work records use a management table (code and title, circle,
status, actions). The status cell names only what the family needs, in the
attention color: not synced or metadata issues, and no source when
`sourceTier` is none, the family's best available source ranked local when
the Library counts it as local, then remote for any other available source or
location. A healthy family, including one a remote source filled, leaves it
empty; the inspector shows the complete metadata and source states. The
action column opens the work metadata editor, gated by `library:write`. The
list loads on navigation, filter changes, recovery actions, saves, and manual
refresh, never on a timer.
Shared tags and circles use searchable management tables and review dialogs.
Tag and circle changes, work metadata edits, cover overrides, metadata links,
and purchase bonus links require `library:write`, granted to admin and
super_admin. Untracking a remote source requires `remote:track`. Voice alias management requires `metadata:sync`.

Tag APIs live under `/api/metadata/tags` (list/create, one tag with its
names, rename/hide, merge, undo mapping); work additions/removals use `GET/PUT
/api/works/{id}/metadata-tags`, whose `newTagNames` sets language names only
for tags that save creates, never for an existing tag a draft name resolves to.
Both return every known name of each tag, so the editor can show a work's tags
in one language.
Circle APIs under `/api/metadata/circles` list identities and manage manual
names, aliases, merge reviews, and undo.
These actions change known metadata only and never crawl or materialize a
provider catalog. Demo keeps all mutation paths read-only.

Management reads require an authenticated Metadata-page operator with at least
one of `library:write`, `metadata:sync`, `sources:write`, or `system:admin`.
This keeps library-writer tag completion available without sync permission.
Anonymous read access does not include these management endpoints. Circle
lists, details, and merge history share the circle visibility predicate.
Demo lists only entries related to eligible demo works and counts those works
only; circle merge review history is withheld in Demo.

Startup projects shared tags in transactions of at most 64 existing works.
`metadata_tag_projection_version` records completion only after every batch
commits. Stored projections always use the original language; a user's own
language changes no stored projection. `metadata_projection_pending` makes an
interrupted pass resume at the next startup. Before the shared-tag backfill,
startup deletes the instance-level `dlsite_metadata_languages` and
`dlsite_metadata_language` settings and sets that flag when either held a value
other than `origin`, so the same batched projection returns stored titles and
tag names to the original language. Repeating a completed projection preserves
unchanged relations and recommendation revisions. Hiding, merging, and undo
collect only works referencing the connected merge component through provider
bases, genre ids, effective links, or manual additions/removals. The state
change and queue entries commit in one bounded transaction; no
per-work projection runs in the request. A dedicated worker drains eligible
backlog in consecutive batches, releasing the write lock between transactions;
it checks every two seconds only while idle or waiting for retries. Batches start
at 32 works, capped at 64 by the projection service and a five-second transaction
deadline. Projection timeouts halve batches down to one work; four successful
batches double the size back toward 32. Write-lock wait timeouts do not reduce it.
Failed batches roll back atomically, then only the failing work is durably deferred
for 30 seconds, doubling up to five minutes on repeated failure. Protected logs
record each failed attempt, other works continue, and backoff survives restart.
Each work keeps its committed links and authority marker until its
new set commits, with search and recommendation invalidation in that transaction.
Tag lists and mutations expose the instance-wide pending count; management
refreshes it on navigation, saves and manual refresh. Names are refreshed only
for changed concepts.

Every snapshot writer is covered by durable queue triggers. Snapshot fallback
normalizes DLsite input only; remote tags display from their snapshot alongside
manually added shared tags unless the opt-in
[remote metadata fallback](metadata-editing.md#remote-metadata-fallback) uses their source. Stored
snapshots fill missing dictionary cells, never replace learned names, and never
guess a request language.
Invalid or over-limit input is skipped as a whole with protected logging, so one
work cannot permanently block startup backfill or an otherwise valid tag edit.

Core workflow definitions, startup triggers, and changed-snapshot projections
run before independent server-lifetime background repairs: shared-tag backfill,
moving flat cover files into the nested cover layout, removing unreferenced
manual cover assets, and moving personal state an edition holds to its
family's canonical work (see [User State](../data-model/user-state.md#user-state)). No
repair delays or prevents these core steps. Protected logs keep repair errors;
durable `startup_cover_migration`, `startup_manual_asset_cleanup`,
`startup_family_personal_state`, and `startup_metadata_tag_backfill` settings
record running/failed/complete status and whether another startup should retry.
Committed backfill batches remain consistent; the next startup retries an
incomplete pass idempotently. A bad cover file leaves its
original in place while other files move, and prevents the layout completion
marker until a later successful retry.

All cover writers share publication serialization across a work's extensions.
They stage complete bounded files on the cache filesystem and publish by
rename, without requiring hard links. Remote cover publication and the flat
cover layout move preserve an existing provider cover; provider publication
wins a concurrent fallback and removes its stale extensions. Windows handle
conflicts have a cancellable one-second retry bound. No partially written final
file is exposed.

Work tag saves accept add/remove overrides and optional custom-name drafts in
one transaction. Exact names in any language, ignoring surrounding whitespace
and case, reuse an existing concept. Canceling the editor sends no creation
request. Hiding a merged source changes its post-undo state; only a hidden final
target hides the current tag. Search keeps merged source names as aliases and
rebuilds affected documents when names or mappings change.
Run links use `/metadata?reason=metadata&metadataRun=<id>`. Filtering by a
run additionally checks workflow permission and that run's ownership.
Successful recovery changes shared work state, never `workflow_run_review` or
the historical execution status.

All production DLsite family syncers share an application-instance coordinator.
Identical in-flight requests reuse their result; requests for different
editions/settings of the same known family wait. Per-product gates cover
overlapping discovery and cover writes. Unrelated families can proceed within
the active metadata job, subject to provider pacing.
Database attempt ordering prevents late failures from replacing newer outcomes
and late successes from replacing newer successful metadata. This is not a
distributed request lock between separate application processes.
