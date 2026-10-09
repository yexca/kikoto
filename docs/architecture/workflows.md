# Workflows

Kikoto treats long-running and reviewable operations as workflows.

## Model

```text
workflow_definition
  -> workflow_trigger
  -> workflow_run
      -> workflow_node_run
      -> workflow_job
      -> workflow_candidate
      -> workflow_run_review
```

## Built-In Workflows

Every `workflow_definition` is a system definition: one of the built-in
workflows below or a [preset workflow](#preset-workflows). There are no
user-authored definitions. Each run stores its own workflow code and name.

Library and metadata:

- `local_library_scan`: discover local work folders and synchronize local
  presence (see [Local Folder Trigger](#local-folder-trigger)).
- `local_media_index`: index the media files of discovered local work folders
  (see [Local Work File Refresh](#local-work-file-refresh)).
- `metadata_sync`: bulk metadata sync of existing works (see
  [Metadata Sync Scope](#metadata-sync-scope)).
- `metadata_family_sync`: refresh one work and its bounded language-edition
  family, queued by work detail, Metadata recovery, and link changes.
- `metadata_genre_names`: learn genre names in preferred metadata languages
  (see [Genre Name Learning](#genre-name-learning)).
- `demo_library_scan`: the Demo library scan, which indexes only works
  eligible for public browsing.

Remote sources:

- `remote_source_sync`: track one remote work and its selected-source
  directory.
- `source_availability_check`: check which configured remote sources can
  provide a work (see [Source Availability](#source-availability)).
- `unlinked_work_source_check`: check remote sources for selected works that
  have no available source, from the Metadata no-source view.
- `source_presence_check`: check whether library works exist on one remote
  source (see [Source Presence Check](#source-presence-check)).
- `availability_watch`: see [Availability Watch](#availability-watch).
- `remote_work_fetch`: Fetch one remote work into the local library.
- `remote_bulk_action`: dispatch per-work Track or Fetch workflows for several
  selected remote works.
- `remote_popular_collection` and `dlsite_popular_collection`: see
  [Popular Collections](#popular-collections).
- Preset follow workflows `circle_follow`, `series_follow`, and
  `voice_follow`. Circle and voice actor detail refreshes run as follow runs.

Media, cleanup, and database:

- `media_cache`: cache remote media during playback.
- `media_cache_cleanup`: delete cached media files and mark their cache
  locations unavailable.
- `cache_maintenance`: remove unreferenced managed cache files after a safety
  grace period and prune empty directories.
- `media_location_cleanup`: delete selected cache or local files and mark their
  locations unavailable. `media_cleanup_forget_work` also removes the then
  unlinked work family and its personal state.
- `local_media_delete`: delete one local media file and mark only that location
  unavailable. `local_symlink_review` notifies users when such a request
  targets a symlink.
- `local_location_cleanup`: mark reviewed local locations unavailable and
  optionally delete the files.
- `database_optimize`: single-flight `VACUUM` (see
  [Database](../operations/database.md#maintenance)).
- `database_backup`: a verified database copy with bounded retention (see
  [Database](../operations/database.md#backups)).

## First Library Metadata Prompt

After a local scan finishes, Library offers metadata synchronization when active
local work folders lack DLsite snapshots and no bulk metadata run has occurred.
Empty libraries and scans still in progress do not show the prompt. Only users
with metadata-sync permission see it; Demo mode does not offer this action.

The prompt starts the background metadata workflow. Repeated clicks reuse its
recorded run, and an already active bulk sync shows its current state.
Library keeps browsing and playback while the prompt shows queued/running or
terminal status. Activity is linked for users with workflow permission. The
initiating user receives a notification when the run succeeds or needs attention.
Choosing Later dismisses the prompt for the instance; the manual metadata sync
entry points are unaffected. The dismissal and selected run are stored in
`app_setting`, so they survive browser changes and server restarts.

## Metadata Sync Scope

Metadata sync maintains works that already exist; it never reads a catalog to
add works. `POST /api/workflow-runs/dlsite-sync` and its interval trigger
accept an optional scope:

| Input | Values | Default |
| --- | --- | --- |
| `scope` | `all`, `circle` (with `circleId`), `voice` (with `personId`), `works` (with `workCodes`) | `all` |
| `mode` | `missing` (no DLsite snapshot, or a stale origin link), `full` (every selected work) | `missing` |
| `workCodes` | 1–100 existing product codes; normalized, sorted and deduplicated | none |
| `sourceId` | An enabled metadata-capable remote source; omitted for DLsite. Circle requires DLsite; voice requires a remote source. | DLsite for all, circle and selected works |
| `remoteMetadataFallback` | DLsite only: `enabled` and up to 16 ordered source ids | disabled |
| `purchaseBonusAutoLink` | DLsite only: automatically detect purchase bonus links | true |

Manual runs and interval triggers store the same normalized options. Selecting
works in the UI defaults to full refresh and accepts whitespace, commas and
newlines. Unknown codes are rejected without creating works. Remote missing
mode checks the selected provider's snapshots, independently of DLsite;
full mode bypasses cached remote descriptions. Source capability and enabled
state are checked at submission and execution. DLsite full refresh of selected
works also retries products reported unavailable.

The source tabs show only DLsite for a circle, and only enabled metadata-capable
remote sources for a voice actor. Voice actor scope is disabled until such a
remote is configured. All works and selected works can use either source type.
Run creation, trigger configuration, execution and retries enforce the same
source restrictions.

A circle scope covers works credited to the circle (circle, translator circle,
or official translation brand) and works of its stored catalog that already
exist. A voice actor scope covers works crediting the voice actor and works of
the voice actor's catalog that already exist. An empty body takes every
default: all works in `missing` mode from DLsite, without fallback, with bonus
detection on. Each complete option set is a separate singleton: repeating the
same options while queued or running joins that run; different sources,
fallback orders or bonus choices queue separate runs, and all metadata sync
runs share the `metadata:provider` resource. Local scan follow-ups coalesce
only into a queued DLsite unscoped `missing` run with default options. A retry
repeats every option of the failed run. Run choices do not write instance
settings or reorder existing remote metadata across the library.

### Purchase Bonus Detection

The run's `purchaseBonusAutoLink` option (default on) lets metadata sync link a
purchase bonus to its parent product (see
[data model](data-model.md#purchase-bonuses) for `work_purchase_bonus`). Family
refreshes outside a bulk run take this choice from the instance setting
`metadata_purchase_bonus_auto_link` (default on); a `metadata_family_sync` job
snapshots it when queued. Only the requested work of a family sync is
considered, and only when DLsite reports it permanently free with a bonus
marker such as `【早期購入特典】` in its title or short introduction;
`【特典付き】` marks a paid product that includes a bonus and is excluded.

The parent must share the bonus's maker. Stored works of that maker are scored
first, without a request. Otherwise the maker's profile is read newest first,
stopping after the first page that lists a lower code of the same prefix and
after at most 10 pages, without series catalogs; the 5 unchecked codes nearest
the bonus are requested for scoring only and never stored. A candidate matches
by an identical normalized title reading (`work_name_kana`), or by the same
release day plus the title quoted in the bonus marker appearing in order in its
title. The strongest evidence must name exactly one candidate; otherwise the
bonus is recorded `unmatched`. A request failure records nothing and leaves the
bonus's own metadata intact for a later run.

Bulk sync revisits a stored bonus snapshot without a decision once, even in
`missing` mode, and skips `unmatched` bonuses. The per-work
`metadata_family_sync` job, queued by detail refresh, Metadata recovery and a
manual link change, also retries `unmatched` bonuses. A linked bonus inherits
from its parent on every sync, whatever the detection choice. The job summary
names a newly detected parent as `purchase_bonus_parent`.

## Genre Name Learning

`metadata_genre_names` ("Learn tag names") is a single-flight system workflow
that fills the genre name dictionary for the preferred non-Japanese metadata
languages, as described in the [data model](data-model.md#work-metadata): the
languages some user prefers. There is no instance default language. It is
queued only when some preferred language still has a learnable unnamed genre:
at startup, after a metadata sync, family refresh, preset or DLsite popular run
finishes (a sync may have learned new genre ids), and after a user's language
changes. A request while one is queued or running joins it. Demo mode
does not learn.

The job reads the current languages and asks DLsite through the same
client, proxy routes, outbound policy, request delay and retry backoff as
metadata sync, one locale-specific product request at a time. Each answered
request commits its names before the next, so a restart or retry resumes from
the remaining genres. A timeout, rate limit or network failure fails the job for
the normal workflow retry; other request failures skip that work for the run and
are listed in the run result. Progress counts named and exhausted genre and
language pairs; the run summary reports requests, learned names, exhausted
pairs, failures, and what remains.

## Metadata Recovery

Metadata synchronization is a workflow. Metadata management owns the current
attention list and the DLsite proxy shortcut; sync and its remote metadata
fallback configuration live in Workflows, and creator catalog freshness in
Settings → Library.
Activity run detail links to the unresolved
issues encountered by that run. Selecting works queues recoverable family-sync
jobs, reusing an already queued/running job for that family. Explicit recovery
can recheck a provider's `not_found` observation without erasing it first.
Normal bulk and work-detail refreshes skip unavailable products.
DLsite records `not_found` only when every candidate site and locale returned
an empty product list. If any request failed, the attempt is recorded as a
retryable failure.

The unified `/api/maintenance/works` read composes current metadata failures
with the Library's live no-source predicate, then deduplicates and pages by
family on the server. Edition/provider component details are attached only for
the selected page. Multiple reasons share one family row; resolving metadata
never removes a remaining no-source reason. Search reuses Library semantics.
`reason=metadata` and `reason=no_source` narrow the union. A run filter always
restricts it to unresolved metadata issues associated with that run.

Metadata reasons and retries require `metadata:sync`. No-source reasons, source
checks, and confirmed deletion require `sources:write`; the UI exposes deletion
only in the no-source view and the server still revalidates family availability.
Each permission grants only its corresponding maintenance actions, without
exposing settings to metadata-only operators. Metadata management chooses the
Works group (All and attention categories) and the Entries group (Tags,
Circles, and Voice actors) from the shared page icon rail. Work records use a
management table (code and title, circle, status, actions); the action column
opens the work metadata editor, gated by `library:write`. The list loads on
navigation, filter changes, recovery actions, saves, and manual refresh, never
on a timer. Metadata settings open in a popover anchored to the header, with
the current list kept underneath.
Shared tags and circles use searchable management tables and review dialogs.
Tag and circle changes, work metadata edits, cover overrides, metadata links,
purchase bonus links, and source untracking require `library:write`, granted to
admin and super_admin. Voice alias management requires `metadata:sync`.

Tag APIs live under `/api/metadata/tags` (list/create, one tag with its
names, rename/hide, merge, undo mapping); work additions/removals use `GET/PUT
/api/works/{id}/metadata-tags`, whose `newTagNames` sets language names only
for tags that save creates, never for an existing tag a draft name resolves to.
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
[remote metadata fallback](#remote-metadata-fallback) uses their source. Stored
snapshots fill missing dictionary cells, never replace learned names, and never
guess a request language.
Invalid or over-limit input is skipped as a whole with protected logging, so one
work cannot permanently block startup backfill or an otherwise valid tag edit.

Core workflow definitions, startup triggers, and changed-snapshot projections
run before independent server-lifetime background repairs: shared-tag backfill,
moving flat cover files into the nested cover layout, and removing unreferenced
manual cover assets. No repair delays or prevents these core steps. Protected
logs keep repair errors; durable `startup_cover_migration`,
`startup_manual_asset_cleanup`, and `startup_metadata_tag_backfill` settings
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
Activity links use `/metadata?reason=metadata&metadataRun=<id>`. Filtering by a
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

## Workflows Page

The Workflows page lists the manually runnable built-in workflows and the
preset workflows in one workflow list, grouped by a frontend-owned category
keyed by workflow code: Basic (local scan, local files, metadata sync), Collect
(popular collections), Follow (preset follow workflows), and Remote
(Availability Watch, Fetch, and works on a source). A linked run of any other workflow adds a
read-only entry for it, which stays with Basic. Each entry shows
its latest run's status and time and the enabled automation that starts it
(Startup, schedule, or folder watch). The page reads each listed workflow's
latest run when it loads and again when the active queue or attention count
changes; the per-workflow summaries have no timer of their own.

Wide layouts keep the list beside the selected workflow and can collapse it to
an icon rail. Each icon then keeps a dot for its latest run, the full workflow
name stays the accessible name and tooltip, and the choice is stored locally
for this page. The mobile navigation layout lands on the list and opens one
workflow at a time: opening a workflow adds a history entry, and the header
back action returns to the list. The selected workflow remains the persisted
and linked state (`?workflow=<code>`).

A status strip above the list shows the newest active run with its progress,
the Needs attention count, and the next enabled schedule. It reads the global
queue every few seconds while work is active and every 15 seconds otherwise;
Demo reads it once. Its cells open Activity or select the scheduled workflow.

The selected workflow shows its category, stage count, and description, then a
health summary of its latest 20 runs: the last run, the success rate of finished
runs, their median duration, and the next automatic start. A duration strip
plots those runs oldest first; ordinary successes stay neutral so failures,
partial results, and active runs stand out.

Run options form a run form that ends in a run bar holding Run, any workflow
action such as Availability Watch Configure, and the first reason Run is
unavailable. The bar sticks above the page's fixed bottom controls while a long
form scrolls. Preset option groups (Input, Filter, Actions) become columns once
the form is wide enough. A workflow without run options keeps Run in its header.
The latest run's monitor follows the form, then triggers and recent runs.

## Activity Summary

Workflows exposes Activity at the right end of its status strip.
The desktop popover and mobile sheet show active runs above two server-paged
views: Needs attention and History. The active list and both views are global
across workflow definitions, so a job
submitted from one workflow remains visible while another definition is open.
Recent runs and list rows open full run details inside the same panel; returning
to the list keeps the global scope. Activity has no page of its own:
`/activity` and `/runs` links redirect into Workflows with the panel open, and a
linked run resolves its workflow before loading history, including a read-only
context for workflows without a configurable definition. The header
notification panel and Quick actions open this same surface. Events,
candidates, progress, retries, and cancellation are available within the panel.

The active list contains running and queued jobs; Needs attention contains
terminal runs with unresolved candidates, pending metadata issues, or
unacknowledged failures. A dedicated metadata-sync failure with recorded issue
outcomes leaves attention when those issues are resolved. Unrecorded failures
require acknowledgement. The successful-attempt boundary prevents a later
failure from reopening an older resolved association. History contains
successful runs and runs that were cancelled or manually acknowledged, while
unresolved failures stay in Needs attention. Acknowledgements belong to the
viewer; they cannot dismiss an active run or unresolved candidate/metadata
issue. Demo keeps these actions read-only.

## Popular Collections

Remote popular collection reads the configured compatible file source's own
recommendations and may track or fetch those remote works when run manually.
Startup and interval triggers accept only the Track action with a limit of 1 to
100 works, and expand their tag template when each run is dispatched.

DLsite popular voice collection reads the provider ranking for 24 hours, 7
days, 30 days, or a selected year. Non-annual runs may be limited to works
released within 30 days. The recoverable worker synchronizes metadata and
appends a run-specific tag owned by the user who started the run. It does not
create remote file-source presence or fetch media.

Both collectors accept `skipTag` on a manual run. The run then renders no tag,
adds none, and records its tag node as `skipped`. Without `skipTag`, a remote
collection requires a tag name or template, and a DLsite collection without one
uses its default ranking tag.

Configurable built-in triggers keep the configuring user for user-owned tag
effects and revalidate that user's permissions when dispatching. Triggered runs
store both their trigger reference and the final resolved input.

## Preset Workflows

Preset workflows are system definitions whose graph is composed by the server
from a small validated parameter set. The typed workflow graph runtime
(`workflow_graph*.go`; persisted as `custom_workflow` jobs with checkpoints and
retry) executes the node kinds the presets compose. `circle_follow`,
`series_follow`, and `voice_follow` share one input, filter, and actions shape:

| Section | Circle | Series | Voice actor |
| --- | --- | --- | --- |
| Input | `circleId`, `catalogRefresh` (`incremental`, `full`) | `seriesId` (stored catalog) | `personId`, `sourceIds`, `catalogRefresh` |
| Filter | `releaseFrom`, `releaseTo`, `maxWorks` | same | same |
| Actions | `metadata`, `tagNameTemplate`, `checkSourceIds` | `metadata`, `tagNameTemplate` | `metadata`, `tagNameTemplate` |

```text
discover (circle_catalog | series_catalog | voice_catalog)
  -> circle_sources (circle, when checkSourceIds is set)
  -> filter_works (existing=missing_metadata, releaseFrom, releaseTo, limit)
  -> metadata_sync
  -> tag_works (optional, rendered from a tag template)
```

The filter keeps catalog works that lack DLsite metadata: codes without a work
and works without a DLsite snapshot, skipping works the provider reported as
not found. A candidate without a work takes its release date from the circle
or voice actor catalog. Every filter is off by default; without a work limit a
run syncs every catalog work that lacks metadata, up to the internal catalog
bound of 5000. Following a circle or voice actor is therefore an explicit
request for its catalog. The Workflows page warns before saving an automated
trigger without a release range or work limit, and recommends turning one on.
With `metadata` off the run only refreshes the catalog (and checks sources), so
the filter and tag are dropped; a series has no catalog refresh and requires
the metadata action. Refreshing the metadata of works that already have it is
Metadata sync with a circle or voice actor [scope](#metadata-sync-scope).
Follow presets never track or fetch remote works; those actions belong to
Availability Watch, remote collections, and Fetch.

An administrator with `sources:write` reviews the user definitions saved in
`legacy_workflow_snapshot` during library onboarding. An upgrade from a
database below schema version 35 fills that table, with each definition's
triggers, before the numbered migrations run. The review offers conversion only
for a graph equivalent to a current preset with Startup or schedule triggers,
and creates its triggers disabled; any other definition can be skipped or
exported.

`GET /api/workflow-presets` publishes each preset's parameter schema; the
Workflows page renders it as the selected workflow's run form and as the
startup or interval trigger form. `POST /api/workflow-presets/{code}/runs`
validates the inputs, checks that a selected source is an enabled compatible
remote source, renders the tag template for this dispatch (`{date}`,
`{target}`), builds the graph, validates it with the typed workflow graph
validator, and enqueues one recoverable `custom_workflow` job. The job payload
carries the built graph, so Activity shows the real nodes while the definition
record only stores a display pipeline. Required permissions are derived from
the composed node capabilities: catalog refresh and metadata need
`metadata:sync`, tagging needs `tags:write`.

The circle and series targets (`circleId`, `seriesId`) accept up to 20
entries separated by commas, semicolons, or new lines. They are normalized and
deduplicated into one comma-separated input, and the single discover node reads
each target in order, combining the catalogs and keeping each work once within
its catalog bound. `{target}` renders the joined list as a tag fragment. An
empty tag template omits the tag node.

`releaseFrom` and `releaseTo` are optional inclusive bounds passed to
`filter_works`; either may be omitted to leave that side open, and a start
after the end is rejected. `maxWorks` is optional (1 to 500); an omitted limit
runs at the 5000-work catalog bound, which is still explicit in the composed
graph.

Preset triggers store the configuring user and the normalized inputs in
`config_json`; dispatch revalidates that user's current permissions,
re-renders the tag template, and rebuilds the graph. Automated runs accept
incremental catalog refresh only; a full refresh is a manual action. The
follow presets reject the retired inputs `newWorks`, `existing`, `action`,
`sourceId`, `metadataRefresh`, and the Fetch limits with a reconfiguration
message rather than reinterpret them. The Workflows page marks a stored trigger
that carries one as needing reconfiguration; saving the trigger with current
inputs clears its recorded error. Preset runs are system-scope runs and share
the visibility, cancel, retry, and Activity behavior of built-in runs.

## Local Folder Trigger

`local_library_scan` owns one fixed `filesystem_event` trigger created by the
database migration and enabled by default. A fresh install turns it and the
Startup scan off until [library onboarding](#library-layout-and-onboarding)
chooses. The API allows pause, resume, and a
choice between `incremental` and `full` scan mode. Incremental is the default.
It rejects manual creation, identity or name changes, conversion, duplication,
and deletion.

At watcher startup, the coordinator registers visible directories through the
configured discovery depth and every descendant directory below a recognized
work root. It then consumes native filesystem events and dynamically registers
newly created or atomically moved directory trees; there is no recurring full
registration walk. The number of native watches therefore scales with the
directory count inside local works and remains subject to the host's `inotify`
watch limit.

Each visible Create, Write, Remove, or Rename resets a trailing five-second
timer. Dispatch occurs only after five seconds without another observed event.
This is an event-settling guarantee, not proof that an open writer has closed:
a writer can pause longer than five seconds without emitting an event. Imports
that require strict publication must write into an excluded staging tree,
verify the result, and use a same-filesystem rename into the final work root.

The coordinator deduplicates at most 1,024 changed paths into the durable run
and job input. Incremental execution resolves those paths to affected known or
new work roots, walks each affected work's complete media tree, and reconciles
its locations. It does not walk unaffected media trees. A watcher error, path
batch overflow, invalid or unavailable path batch, watch-root invalidation, or
duplicate work root switches that run to full mode. An invalidated root keeps
the recovery request across watcher restarts and dispatches it only after the
replacement watcher has settled.

Kikoto's `.kikoto-staging`, `.kikoto-backup`, and `.kikoto-trash` transaction
trees are excluded. Claimed per-source Fetch roots are also excluded because
Fetch registers final publication directly. A Fetch root without its
`.kikoto-fetch-root` marker receives the same exclusion only after same-source
Fetch history explains its complete visible structure and at least one exact
historical target exists on disk; watcher configuration does not write the
missing marker.
Startup, interval, and manual workflows always run the complete local scan. If a
filesystem scan is already queued or running, later changes remain pending and
are coalesced into at most one follow-up run. Events while the trigger is paused
are discarded. Changes made while Kikoto is stopped are covered by the default
Startup scan; they cannot be recovered by the native event stream alone.

For one unambiguous affected work folder, incremental execution upserts current
files and marks previously available paths absent from the folder `missing`. If
the complete external work root disappears, its folder, source presence, and
available locations become `missing`; the `work`, `media_item`, and location
history remain. Application-owned deletion updates its known location state
immediately and may also produce a native event; the later incremental run is an
idempotent reconciliation. A full scan records presence for every discovered
folder and keeps a work's completed media index only when the folder stayed
available at the same root without newly missing locations or a duplicate code;
otherwise the work is indexed again lazily. A full scan commits discovered
folders in batches of 250, so progress saves and other writers are not locked
out for the whole library, and marks unseen works missing only in its final
transaction. An interrupted scan therefore records what it found and marks
nothing missing, and its retry repeats the idempotent folder writes. A folder
whose work, presence, and folder location already match is not rewritten, so
its timestamps record its last change. Duplicate-code groups skip automatic
invalidation, fall back to full discovery, and remain review candidates.
Neither mode rewrites `managed_fetch` ownership records.

Local scan and metadata sync have separate definitions, jobs, resource labels,
statuses, failures, review candidates, and retry histories. A local scan never
calls a metadata provider as part of its own run. Manual, Startup, and interval
scan configuration exposes `Follow-up run`; it defaults off and, when enabled,
queues a separate `metadata_sync` run only after the scan reaches a terminal
state. The fixed filesystem trigger keeps this option off. Queued automatic
metadata follow-ups are coalesced so a burst of scans does not create redundant
provider work.

## Local Work File Refresh

`local_media_index` indexes the media tree of local work folders that a local
scan has already discovered, the same per-work indexing that otherwise runs
lazily the first time a work's media is requested. It never discovers new work
roots; that is the local scan's job, and the Workflows page lists it second,
after the scan.

| Mode | Selected folders |
| --- | --- |
| `incremental` (default) | Available `local_folder` presences whose `raw_json.file_tree_scanned` is not set |
| `full` | Every available `local_folder` presence |

The job reads the complete target list before indexing, so no cursor holds a
pooled connection while folders are walked and written. It then indexes each
folder through the shared per-work indexer, which coalesces with a concurrent
lazy request for the same folder, and checkpoints progress at most once a
second. A folder that fails is recorded (the first 50 failures are kept) and the
run continues; the run is `partial` when some folders fail and `failed` when
none succeed. Cancellation stops before the next folder.

One run is queued or running at a time: a manual start, retry, or trigger
dispatch while one is active returns that run. Manual runs, Startup triggers,
and interval triggers store `{"mode": ...}`; retry repeats the failed run's
mode. Starting a run requires `workflows:run` and `metadata:sync`, like the
local scan. No trigger is seeded.

## Queue Ordering

`workflow_job.priority` is persisted with each job. One embedded executor claims
the highest-priority queued job, preserving FIFO order by creation time and id
within a priority, and runs only one workflow job at a time. A submission is
persisted as `queued` before it is claimed as `running`; later submissions wait
in the same durable queue, including jobs from different workflow definitions
and resource keys. Playback-triggered cache fills use the highest tier, direct
user work such as manual workflows and cleanup uses the middle tier, and
scheduled/background work uses the default tier. Priority does not preempt a
job that is already running.

Each executor records its own result, but the runner settles the job when the
executor returns. A transient source failure within the retry budget is
requeued with a delay. A job still running under the executor's lease after
any other exit, including an error or panic that recorded nothing, is marked
failed and Activity records a `job.result_missing` event, so one faulty exit
path cannot hold the single-executor queue.

The executor is single-instance, so the process records every job lease it
holds and that record decides whether a running job still has an executor.
Heartbeats show recent activity but never expire a lease: a busy database or a
long `VACUUM` can delay them while the job is still working. A lease is
recorded before the claim that writes it and released only after its job is
settled. The coordinator settles any running job whose lease is not held,
such as a job whose own settlement write failed: a recoverable job with resume
budget returns to the queue from its checkpoint and spends one resume
(`job.orphan_requeued`), and any other job fails (`job.orphan_failed`).

The manual **Recover stale workflow runs** command applies the same rule to the
runs the user can see. It never touches a job whose executor is still running
or a queued job. It also returns a run left running beside a queued job to the
queue (`run.requeued_stranded`), and fails a run with no queued or running job
(`run.recovered_stale`). A run is repaired this way only when its jobs have not
changed for a minute.

## Service Stop and Restart

On `SIGTERM` or `SIGINT` the service stops claiming jobs, refuses new
connections, and lets in-flight requests finish within
`KIKOTO_SHUTDOWN_TIMEOUT_SECONDS`. Streaming playback and live transcoding are
cancelled after half of that time. The database closes only after the job
executor and other background work have returned.

A running job interrupted by the stop is settled before exit. A recoverable job
returns to the queue with its checkpoint and does not spend its resume budget,
because a requested stop is not a failure; a job that cannot resume from a
checkpoint fails with the stop reason. Activity records a
`job.interrupted_by_stop` event in both cases. Fetch publication does not start
once a stop has begun, and a publication that already started finishes its
directory swap and records it before the job stops.

Startup recovery is the path for crashes, forced kills, and a stop that
exceeds its deadline. No lease from an earlier process is live, so every
running job is settled by the orphan rule under
[Queue Ordering](#queue-ordering): it is requeued from its checkpoint and
spends one resume, or it fails. Queued jobs keep waiting, runs are repaired as
the manual command repairs them but without its one-minute wait, and
interrupted Fetch publications are reconciled from the staging, target, and
backup directories.

Fetch retries and startup recovery share the same publication reconciliation
and local registration steps. A published or registered target is completed
from its persisted plan and files, without re-downloading cache inputs or
refreshing the remote source. Registration and cleanup remain resumable; an
archive moved before its review candidate was saved is recovered on retry.
The completed manifest, retired remote-stream identities, node results, job
lease release, and run result commit together. Rollback backups are removed
only after that commit. Startup also repairs a completed manifest whose job or
run result was left unfinished. Simple workflow result writes likewise commit
their node, job, and run states in one transaction, so an interrupted write
keeps the lease for the runner's settlement path.

## Library Layout and Onboarding

The library is either one standard pool (the data root) or registered storage
pools (first-level folders of the data root). `app_setting` holds
`library_mode`, `storage_pools` (path and marker ID), `fetch_pool`, and the
standard pool's marker ID; paths in the database stay relative to the data
root, so a pool is the first path segment in pool mode and no schema changes.
`GET/PUT /api/library/layout`, `POST /api/library/pools/reconnect`, and
`POST /api/library/onboarding/complete` require `sources:write`.

At startup, before this start is recorded, an instance whose previous start
(`schema_state.last_successful_app_version`) was a release before v0.7.0, or
that has no recorded start but already holds local works, has upgrade
onboarding pending; if unconfigured it becomes `standard`, and it keeps its
triggers. An instance whose previous start was v0.7.0 or later (or a
development build) has already been offered onboarding, so a configured layout
is marked onboarded without changing triggers. The administrator may keep
standard mode or confirm a move into storage pools, then review the local scan
and the saved user definitions described under
[Preset Workflows](#preset-workflows).
The layout step uses one primary action: Next for an unchanged configuration,
or Save and continue for changes. After a confirmed migration finishes, Next
continues with the saved layout and its migration scan.
The standard-to-pools confirmation explains that works already inside selected
pools stay in place, while works outside them move into the chosen Fetch pool
with their data-root-relative paths preserved. Unrelated files remain in place;
the switch does not empty every unselected folder. The summary counts moved
directories and the total size of their files. Copy and verification complete
before library records are updated and original files are removed.
A fresh install stays unconfigured and turns the local scan's Startup trigger
and folder watcher off once; onboarding chooses the layout, runs a scan and
optional metadata sync, and sets both triggers. Its onboarding stays pending
across restarts until finished. A configured mode switch or
Fetch pool switch requires a preview and confirmation. Kikoto blocks ordinary
requests during the durable copy, checksum verification, database path update,
source cleanup, and local scan. Administrators see progress and can retry a
failed move; other users see maintenance. A pool that still holds unrelated
works cannot be removed.
The plan includes indexed local roots and unindexed work folders visible at
the current scan depth. A folder below that depth remains outside the scan's
scope until the administrator increases the depth and scans it.

Each scan computes its scope from the online pools and the effective depth.
Depth counts inside a pool and is at least the deepest Fetch save template or
active `managed_fetch` root. Discovery walks only online pools; missing-marking
of folders and presences applies only to recorded roots inside that scope.
Offline pools make a full or incremental scan `partial` with an
`offline_pools` summary; no online pool fails the scan. Fetch planning resolves
new works into the Fetch pool and existing folders in their own pool, rejects
`library_not_configured`, `fetch_pool_required`, `fetch_pool_offline`, and
`library_offline` with `409`, records the pool as `transactionPool` in the
plan, and creates staging, backup, and quarantine entries under that pool.

`remote_work_fetch` runs are named `Fetch <code>`, expose `workCode` in run
records, match Activity search by code, and record the queuing workflow as
their trigger reason. The Workflows page's Fetch run form accepts one work code
and an enabled compatible remote file source. Its Filter group excludes selected
file extensions from the initial remote selection, with no exclusions by default;
the same exclusions apply when choosing another language edition. Run opens the
shared Fetch workspace to review files, destination, and conflicts before
publication. Submission uses the source Fetch endpoints, permission checks, and
idempotent request scope; Fetch has no automation triggers.

## Source Availability

Source availability is checked by the backend instead of frontend fan-out.
Source-change checks first probe source health, then check candidate works only
against reachable sources. The local library scan does not check remote source
availability.

## Source Presence Check

`source_presence_check` asks one remote source whether library works exist
there. Its options are:

- `sourceId`: an enabled source whose type supports work lookups and that has
  an API endpoint. A run request or trigger that names any other source is
  rejected, and a queued run whose source changed fails without a retry.
- `library`: `local` (the default) selects works with an available local
  presence; `all` selects every work with a primary code.
- `filter`: `no_remote_source` (the default) selects works without an
  available source or tracked presence and without an available remote stream
  location; `all` applies no filter.
- `limit`: the most works one run checks, from 1 to 1000 (default 100).

When more works match than the limit, works the source has never been asked
about come first, then the works it checked longest ago, so repeated runs
cover the whole selection. The selection is fixed when the run starts and kept
in its checkpoint.

The run first probes the source with the same helper and 10-second timeout as
the manual **Check health** action in source settings and records its
`health_status`. An unavailable source fails the run before any work is
checked, so an outage never marks works missing. Each selected work is then
looked up once through the source's paced crawl lane, as a per-work
[source availability](#source-availability) check does, and recorded as that
work's `source` presence (`available`, `missing`, or `unavailable`). The run
never creates works. After five failed lookups in a row it stops and leaves
the remaining works for a later run.

The run `succeeds` when every lookup answered, is `partial` when any lookup
failed, and `fails` on an unavailable source or an internal error. The summary
records the source, the options, and the selected, checked, available,
missing, failed, skipped, and unchecked counts. Upstream errors, which can
name the endpoint, go only to the server log.

One run per source is queued or running at a time: a manual start, retry, or
trigger dispatch for that source while one is active returns that run. Manual
runs (`POST /api/workflow-runs/source-presence-check`), retries, and Startup
and interval triggers require `workflows:run` and `sources:write`; a trigger
stores the run options in its config. No trigger is seeded.

## Availability Watch

Availability Watch is one instance-level system workflow with a shared
monitoring pool, rather than one watch per user. Authorized users can edit the
pool of normalized work codes, while its configuration selects a compatible
remote source (or any healthy compatible source), an action on availability,
and Fetch extension exclusions. Exclusions are opt-in: a watch created without
an explicit configuration excludes no extensions. A change to that
configuration records the user whose permissions govern its scheduled
execution.

It supports at most one interval schedule trigger and may also be run directly
from its configuration surface. Each execution snapshots the active pool,
records a normal workflow run, node runs, and durable job, then leaves unknown
remote results as availability state instead of materializing new `work` rows.
Newly available works move into the Ready pool; configured Track and Fetch
actions are child workflows with their own histories. A successful run that
finds new ready works creates a notification for enabled administrators, and
the notification opens the shared Ready pool.

## Voice Catalog Refresh

Opening a voice actor detail reads the persisted local works and voice catalog
only; entering either a voice or circle detail never queues a workflow.

Circle and voice actor detail refreshes are follow preset runs without a tag
or filter. `POST /api/circles/{externalId}/refresh` and `POST
/api/voices/{personId}/catalog/refresh` only queue a `circle_follow` or
`voice_follow` run and return its id. A circle refresh runs the catalog node,
the optional source-check node, and the metadata action for catalog works that
lack metadata. A voice actor refresh runs the catalog node and a
`voice_metadata` node limited to the voice actor's known works; it never
materializes a catalog-only row. A voice actor metadata retry uses the stored
catalog. A
request identical to an active run for the same creator joins it, and a
different request is rejected until that run settles. A detail refresh is
authorized by `metadata:sync`; because its graph holds only refresh steps, the
run carries `workflows:run` on the requester's behalf. Circle detail returns
the newest follow run for the circle so the page can follow it across reloads.
The only inline circle refresh is the bounded incremental catalog lookup
that resolves a series link. Creator
catalogs expose Never, Attention, or Synced from their last successful pull and
the configured freshness window. An authorized user can start an explicit First
pull or manual refresh through the same follow workflow.

Reading a circle, changing its per-user state, and a detail refresh never
create one. An unknown maker id returns `404` with `circle_not_in_database`;
the page offers a user with `metadata:sync` and `workflows:run` the
`circle_follow` run form with that id filled in, and asks anyone else to
contact an administrator. Only a `circle_catalog` fetch adds the circle: it
starts as an unfetched placeholder, and a failed first fetch removes that
placeholder unless it has since gained a name, catalog, relation, or user
state. A stored-catalog run and the circle metadata and source nodes require
a circle that already exists. A voice actor exists only once a synced work
credits them, so an unknown voice actor page asks a user with
`metadata:sync` to sync the metadata of any of their works and asks anyone
else to contact an administrator. A work's circle, series, or voice link
resolves from stored relationships for any signed-in user; fetching the
work's metadata or its circle's catalog to find a missing link requires
`metadata:sync`, and anyone else gets `404` with `entity_not_in_database`.

The workflow searches the display name and every confirmed alias against each
enabled compatible source. It follows the source-reported result count through
all pages and applies no product-level page or result maximum. Outbound response
limits, a per-source deadline, cancellation, repeated-page detection, and a
three-source concurrency bound still protect the request boundary. Results are
deduplicated by canonical `primary_code` before each successful source is
persisted atomically.

A failed source keeps its earlier catalog observations, while a complete
source marks observations absent from the new generation `not_found`. Remote
discoveries remain catalog rows and never materialize works recursively. In a
detail refresh, only catalog items that already resolve to canonical works enter the refresh run's
metadata node; it synchronizes them within the same `voice_follow` run
rather than creating one metadata workflow per work. Metadata incremental
refreshes select only those known canonical work families without a DLsite
snapshot; full refreshes retry every known canonical family. Neither mode
materializes a catalog-only row as a work. Metadata failures can make the
workflow partial without making an otherwise complete catalog generation stale.

## Review Candidates

Fetch honors an explicit Replace decision even when the target has the same
size or the source does not declare a size. A file copied from the existing
target into staging is not evidence that the selected replacement was staged.
After an interruption, only a staged file matching a previously verified
manifest hash may be reused; other selected files are copied from their chosen
local or cache source again before verification and publication.

Workflow candidates capture user-reviewable outcomes such as duplicate local
folders, unavailable DLsite products, and old local locations left after remote
fetches. A Fetch from a source with restricted outbound hosts also creates a
`remote_origin_blocked` candidate when a media origin is outside that source's
boundary. The run and active node become partial, the recoverable job is not
automatically retried, and Activity records only the normalized origin rather
than the media path or query. After an administrator changes the source policy,
a manual Retry resolves that candidate and resumes the same run.

The Metadata All category sends `reason=catalog` to the bounded maintenance read.
It lists already persisted work families, including those without pending issues,
using the same search, pagination, permission, and demo eligibility boundaries.
It does not discover providers or materialize catalog results. `reason=all`
selects the attention union, and a run filter always narrows the read to that
run's unresolved metadata issues.

The canonical management URL is `/metadata`. `/work-management` URLs and
`/maintenance` work, unlinked, and metadata links redirect there while
preserving their category, settings, and run context. Failed first-sync
notifications and pending metadata results open recovery here; operators
without workflow access use the unscoped issue list, since reading a
run-scoped list requires workflow permission. Runs without recorded pending
issues keep their Activity diagnostics.

## Language-scoped title edits

The work editor and Metadata Works editor share per-language drafts and the same
partial PATCH. Only authored changes are sent; source placeholders never become
manual overrides. Own manual titles load as editable text. Title reset targets
one field/language and keeps other unsaved drafts in the open editor. Cover and
shared metadata tag operations are separate requests with their own
transactions. Title insert, update, language change and delete queue the work's
search document and language titles. Changing a user's metadata language
selects titles and descriptions from stored editions without new provider
requests or work identities. See [data model](data-model.md) for the
precedence and `origin` contract. A remote-filled title follows DLsite in the
title chain. Provider-declared remote edition titles add metadata language
choices; an undeclared remote title remains the languageless fallback.

## Remote Metadata Fallback

The detail metadata editor also offers an explicit `From <source name>`
refresh for each enabled source with declared metadata capability.
`POST /api/works/{id}/metadata-sync` accepts an optional `sourceId`; without
one it queues the DLsite family refresh. A source refresh requests only
the current work, bypasses cached descriptions, and operates independently of
automatic fallback settings and DLsite availability. It preserves manual and
DLsite precedence and uses the same bounded request policy described below.
Submission and execution both validate the source's capability and enabled
state. Repeated requests for the same work and source reuse the active run;
Activity records source codes and fixed outcomes without endpoint details.

When enabled in the DLsite run options, bulk and scheduled metadata sync ask
the selected sources after DLsite reports the requested product
as not found. Timeouts, rate limits and other retryable DLsite failures fail or
retry the job without contacting any remote source, so a DLsite outage cannot
fan out to remote sources. Fallback-enabled runs revisit unavailable works
within their scope. A DLsite `metadata_family_sync` job, used by work detail
and Metadata recovery, snapshots the instance remote metadata fallback and
purchase bonus settings when it is queued.
A work that already has DLsite metadata is skipped, and the
fallback never fills a language DLsite lacks.

For works without DLsite metadata, the same response's `language_editions`
relationships and `other_language_editions_in_db` titles supply stored language
choices. Switching language reads those choices without requesting sibling
codes. These metadata references never materialize library works or playable
editions; an edition relationship without a returned title stays a relationship.

Sources are tried in the configured order, and the first that describes the
work wins. A matching cached description is reused first: that source's earlier
snapshot of the work, then a voice catalog listing. Otherwise the source is
asked exactly once through `workInfo`; the catalog page scan is not used. Each
lookup has a 30-second bound, uses the source's paced crawl lane, buffers at
most 2 MiB, and accepts only a response that decodes within the snapshot bounds
and names the same code. A 404 or a different code counts as not found; other
errors are failures. The snapshot write, reconciliation and shared-tag
projection commit together; the cover is cached afterwards only when the work
has none.

Each attempt records a fixed outcome per source in the shared attempt ledger.
Once a later source fills the work, earlier sources' pending states are
cleared. A family refresh of a product DLsite reports not found succeeds
whatever the fallback outcome. Run output and `metadata.remote_fallback`
Activity events list source codes and outcomes, not endpoints, while protected
logs keep detailed errors. See [data model](data-model.md#remote-metadata-fallback)
for ordering, provenance and switching the fallback off.
