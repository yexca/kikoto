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
- `llm_translation`: translate one explicitly selected existing work for review.
  A batch names at most 100 existing works and creates one task per work;
  lyrics selects one work and one file. Progress and cancellation use the
  shared executor. [Translation task persistence](data-model.md#llm-translation)
  defines source/configuration invalidation, restart recovery and explicit
  resubmission of uncertain requests.
- `ai_translation`: Translate with AI for one work: transcribe the tracks it
  lists without lyrics, then translate the missing title, description, shared
  tag names, display names and lyrics into each requested language, accepting
  each item as it finishes while auto-accept is on, in one job that yields
  between requests like a transcription. Each item
  keeps its own state, so one item's failure leaves the others running.
  [Translate with AI](data-model.md#translate-with-ai) defines the items,
  rechecks, review and retry.
- `asr_transcription`: transcribe one local audio track with a configured
  speech recognition service for review, one chunk per request. Between
  chunks the job defers itself for a few seconds whenever another job is
  waiting, so a long track shares the single executor instead of holding it.
  Retry continues after the last committed chunk. [Speech
  transcription](data-model.md#speech-transcription) defines the task,
  rechecks and publication.
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
- `dlsite_popular_collection` and `remote_popular_collection`: pull the
  DLsite and remote source ranking lists (see [Rankings](#rankings)).
- Preset catalog sync workflows `circle_catalog_sync`, `series_catalog_sync`,
  and `voice_catalog_sync`. Circle and voice actor detail refreshes run as
  catalog sync runs.
- `creator_subscription_refresh`: see
  [Creator Subscriptions](#creator-subscriptions).
- `shown_works_metadata_sync` and `shown_works_source_check`: sync the metadata
  of, or check the sources of, the works a Subscriptions view shows (see
  [Shown Works Actions](#shown-works-actions)).

Media, cleanup, and database:

- `media_cache`: cache remote media during playback.
- `media_cache_cleanup`: delete cached media files and mark their cache
  locations unavailable.
- `cache_maintenance`: remove unreferenced managed cache files after a safety
  grace period and prune empty directories.
- `media_location_cleanup`: delete selected cache or local files and mark their
  locations unavailable. `media_cleanup_forget_work` also removes the then
  unlinked work family and its personal state.
- `work_folder_edit`: add files from the family's other local folders and
  remote editions to one local folder of a work, as files or as lyrics of a
  declared language, arrange its files and folders, remove the files taken out
  of it, and delete the local folders merged into it. It collects and
  size-checks every added file in `.kikoto-staging` on the folder's pool,
  removes the files taken out, takes each moved file into the same staging
  directory, moves each collected and moved file to its path, removes the
  folders it emptied, creates the requested ones, indexes the folder, stores
  the requested lyrics assignments, and then deletes the merged folders. A
  retried or resumed run continues from its checkpoint. A Fetch into a new
  folder queues one as its follow-up once it completes.
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

DLsite family metadata accepts `language_editions` as either an array or a
numeric-keyed object, including sparse objects returned by the provider. The
object keys are ordering hints; each edition's `display_order` remains the
relationship order. Provider responses that join several language tokens with
commas are normalized for edition matching and availability checks, so a
combined language value does not prevent the family from synchronizing.

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
at startup, after a metadata sync, family refresh, or preset run finishes (a
sync may have learned new genre ids), and after a user's language changes. A request while one is queued or running joins it. Demo mode
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
jobs, reusing an already queued/running job for that family, or asks one
selected remote source instead (see
[Remote Metadata Fallback](#remote-metadata-fallback)). Explicit recovery
can recheck a provider's `not_found` observation without erasing it first.
Normal bulk and work-detail refreshes skip unavailable products.
DLsite records `not_found` only when every candidate site and locale returned
an empty product list. If any request failed, the attempt is recorded as a
retryable failure.

A pending metadata issue is a failed attempt, or a not-found outcome for a work
that no remote source has filled and no operator has dismissed. A work a
[remote metadata fallback](#remote-metadata-fallback) filled is complete: its
DLsite not-found outcome stays recorded, but it leaves the issue list, run
pending counts, and Activity attention. `POST /api/metadata/issues/dismiss`
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
only in the no-source view and, for custom works, the custom view, and the
server still revalidates family availability. Each permission grants only its
corresponding maintenance actions, without exposing settings to metadata-only
operators. Metadata management chooses the Works group (All, attention
categories, and Custom works) and the Entries group (Tags,
Circles, and Voice actors) from the shared page icon rail. Work records use a
management table (code and title, circle, metadata, source, actions). The
metadata cell reads OK, names the remote source that filled the metadata in
the same neutral style, or flags not synced and metadata issues. The source
cell ranks the family's best available source, `sourceTier`: local when the
Library counts the family as local, then remote for any other available
source or location, both neutral, and no source in the attention color. The
action column
opens the work metadata editor, gated by `library:write`. The list loads on
navigation, filter changes, recovery actions, saves, and manual refresh, never
on a timer. Metadata settings open in a popover anchored to the header, with
the current list kept underneath.
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
keyed by workflow code: Basic (local scan, local files, metadata sync, Learn
tag names), Collect (the DLsite and remote source ranking pulls), Catalog sync
(the subscription refresh and the catalog sync presets), and Remote
(Availability Watch, Fetch, and works on a source). A linked run of any other
workflow adds a read-only entry for it, which stays with Basic. Availability
Watch, the subscription refresh, and the ranking pulls are configured on the
Subscriptions page: their entries show the latest run, the health summary, and
the run history with a link there, and have no Run options or triggers. Each entry shows
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
action such as Availability Watch Save, and the first reason Run is
unavailable. The bar sticks above the page's fixed bottom controls while a long
form scrolls. Preset option groups (Input, Filter, Actions) become columns once
the form is wide enough. A workflow without run options keeps Run in its header.
The latest run's monitor follows the form, then triggers and recent runs.

## Workflow Permissions

`workflows:run` opens the Workflows page; it is not an administrator
capability on its own. Contributors and administrators hold it (see
[Users](../user/en/settings.md#users)). Every capability below is checked by
the backend.

- Visibility: every holder sees system-scoped definitions, presets, triggers,
  runs, events, candidates, and Fetch file lists. A run of a user-scoped
  definition, or of a custom definition that no longer exists, stays visible
  only to its owner or requester, and `system:admin`
  sees every run.
- Starting, configuring, and scheduling: a kind of run requires every
  permission its steps use. Track steps (`track_works`, a bulk Track, a
  watch's Track) require `remote:track`; Fetch steps (`fetch_works`, Fetch,
  a bulk Fetch, a watch's Fetch) require both `remote:fetch` and
  `metadata:sync`; scans, the local file index, metadata sync, presets, and
  the ranking pulls require `metadata:sync`, as do configuring rankings and
  requesting a pull; the source presence check requires `sources:write`; tags
  require `tags:write`. Scheduled dispatch re-checks the trigger owner's
  current permissions.
- Triggers: editing, switching off, or deleting a trigger requires the
  permissions its stored configuration requires to create, read from that
  configuration without validating its source, so a trigger whose source was
  removed can still be switched off by an account that could create it.
- When an administrator disables or deletes a remote source, every enabled
  trigger whose stored configuration depends on that source is paused in the
  same transaction. The trigger keeps its schedule and options, clears its
  next dispatch time, and records whether the source was disabled or removed.
  The scheduler repeats this dependency check to cover a concurrent or
  out-of-band source change. Re-enabling a source does not resume its paused
  triggers automatically; an administrator must review and enable them.
- Availability Watch: its configuration, targets, schedule, and runs require
  the permissions of the configured action, and Track on a ready target
  requires `remote:track`.
- Ownership: a run records its requester as `requested_by_user_id` in its
  input, written by the account that started it or by the trigger owner a
  trigger dispatched for. Cancel, retry, and candidate decisions are limited
  to that requester unless the actor administers workflow runs, which is the
  `sources:write` capability shared with the other instance maintenance, or
  holds `system:admin`. A run without a recorded requester is managed only by
  workflow administrators. Translation-page cancellation follows this ownership
  rule through its dedicated endpoint with `library:write`.
- Retry re-checks what the failed work needs: Fetch jobs require both
  `remote:fetch` and `metadata:sync`, media cache jobs require `remote:fetch`,
  cleanup and local deletion jobs require
  `downloads:manage`, a folder edit, including one that merges folders,
  requires `downloads:manage` plus
  `remote:fetch` when it downloads and `library:write` when it assigns lyrics,
  metadata jobs require `metadata:sync`, a
  speech transcription requires `library:write`, Translate with AI requires
  `library:write` and queues only the items the actor may translate, and graph jobs require their
  graph's permissions.
- Local files: candidate decisions, local cleanup, and archived-root review
  for candidates that remove, archive, or mark unavailable local files
  (`local_fetch_merge_cleanup`, `local_duplicate_work_folder`,
  `local_symlink_media_location`) require `downloads:manage`.
- Maintenance: stale-run recovery requires `sources:write`.

## Activity Summary

Workflows exposes Activity at the right end of its status strip. Activity
lists every run as the administrators' diagnostic view; features with their
own pages show their runs there too. The Translation page reads Translate with
AI runs and items through `/api/translation/runs` and
`/api/translation/items`, open to accounts with `library:write` without
`workflows:run`, and a work's Manage lyrics lists its transcriptions.
`POST /api/translation/runs/{id}/cancel` cancels a queued or running
`ai_translation` run under the [ownership rule](#workflow-permissions).
Each returned translation run carries `canCancel`, which controls whether
the Translation page offers the action.
Notification Center attention rows for a Translate with AI run open the
Translation page's Stopped view, and those for a transcription open its work.
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

A run record's `subject` names the one target the run acts on, read from its
input: a work code for Fetch, Track, ASR, LLM translation, Translate with AI, Edit files, media
cache, local media delete, single-work metadata refresh, and a metadata sync
of one work; the circle code for a circle catalog sync or a circle-scoped
metadata sync; the series id for a series catalog sync; the voice actor's name
for a voice catalog sync or a voice-scoped metadata sync; and the remote
source's name for a source presence check, a remote ranking pull, or a
per-source cache cleanup. Runs over many targets have an empty subject. Run
titles append the subject to the workflow name, and Activity search matches
it.

The active list contains running and queued jobs; Needs attention contains
terminal runs with unresolved candidates, pending metadata issues, or
unacknowledged failures. A dedicated metadata-sync failure with recorded issue
outcomes leaves attention when those issues are resolved. Unrecorded failures
require acknowledgement. The successful-attempt boundary prevents a later
failure from reopening an older resolved association. History contains
successful runs and runs that were cancelled or manually acknowledged, while
unresolved failures stay in Needs attention. Acknowledgements belong to the
viewer; they cannot dismiss an active run, an unresolved candidate, or a
retryable metadata failure. A run whose remaining metadata issues are all
not-found outcomes can be acknowledged, which removes it from that viewer's
Needs attention while the issues stay in the Metadata issue list. Run records
expose `pendingMetadata` and its retryable share, `pendingFailedMetadata`.
Demo keeps these actions read-only.

## Rankings

A ranking list (`ranking_list`) is one tracked ranking shared by every
account: the DLsite voice ranking for 24 hours, 7 days, or 30 days, the DLsite
annual voice ranking of one year, the DLsite all-time voice ranking, or the
popular list of one enabled compatible remote source. A list keeps its depth
(10 to 100 places), whether it is shown, and whether it is pulled
automatically and how often. DLsite lists read the voice works only
(`category=voice&sub=SOU`).

A list is pulled in each of its orders, its variants (`ranking_variant`). A
DLsite list is ordered by popularity or by sales (`sort=sale`); the 24-hour,
7-day, and 30-day rankings are also pulled limited to works released within
30 days (`date=30d`), so they have four variants, and the annual and all-time
rankings two. A remote list has one. Each variant keeps its own snapshots,
entry statistics, seen state, and last pull status.

The Rankings view shows the lists in a fixed order: 24 hours, 7 days, 30 days,
Annual, and All time, then each remote source's popular list in the sources'
configured order. Annual lists share one chip, newest year first, with a year
choice. The view chooses a variant with a 30-day switch, on the 24-hour,
7-day, and 30-day rankings, and a popularity or sales choice; the location
names it with `release=30d` and `sort=sale`, each choice is a history entry,
and the last choice on each chip is a per-device preference. History and
comparisons read the shown variant.

Two system workflows pull the lists, each through the same two nodes:

```text
pull   (each variant of the lists of the run's target that are due or requested)
  -> record (per variant, a snapshot when the order changed and entry statistics;
             per list, the next pull)
```

`dlsite_popular_collection` pulls every DLsite list in one run, holding the
`metadata:provider` resource. `remote_popular_collection` pulls the lists of
one remote source per run, holding that source's resource, and names the
source as its run subject. One run per workflow, and per source for remote
lists, is queued or running at a time. A run picks its lists when it starts,
so a run waiting behind another provider job also takes the lists that became
due meanwhile. A requested pull, from **Refresh now**, **Refresh all now**, or
showing a list for the first time, marks the list and queues its target's run,
or joins the active one. The run consumes its requests when it takes its lists,
in the transaction that records its checkpoint; a request made after that
waits for the next run and survives the current run's result. Lists of a
disabled or incompatible source are not pulled until the source is available
again. Neither workflow adds works to the
library, syncs metadata, tracks, fetches, or tags.

A DLsite variant reads the provider ranking page for its period, order, and
year through the DLsite client, which also returns the title and circle each
entry shows; either may be empty, and no image address is taken from the page.
A remote list reads the source's popular works through the shared outbound
transport on its configured origin; works without a stable catalog code are
skipped and counted. A removed or incompatible source records the list as
`source_unavailable`. A failing variant never stops the others: its last
snapshot stays, the list is `partial` when some of its variants failed, and the
run is partial when some variants failed and failed when all did. Detailed
errors stay in the run and the protected `last_error` of the variant and the
list.

### Schedules

Each workflow keeps one ownerless schedule trigger as its dispatcher. Its next
run is the earliest time one of its enabled lists is due: a requested pull, or
the next automatic pull of a list that is not finished. While a target's run
is queued or running, only its lists due later count. Completion, failure,
cancellation, orphan recovery, and changes to a list replan the dispatcher
from the lists' current settings. Cancelling a pull consumes that run's
request and keeps an enabled automatic list's next pull in the future;
a later manual request remains due. The dispatcher is
configured only through the lists: the Workflows page shows its next run but
cannot edit, pause, or delete it.

A pull whose every variant succeeded plans the list's next one an interval
after it. A pull with any failed variant is retried after one hour, then two,
and so on, never later than the list's interval, and the retry pulls every
variant again. A list without automatic pulls is pulled only on request.

| List | Default interval | Choices |
| --- | --- | --- |
| DLsite 24 hours | 1 hour | 20 minutes to 24 hours |
| DLsite 7 days | 6 hours | 1 hour to 7 days |
| DLsite 30 days | 24 hours | 6 hours to 7 days |
| DLsite annual, year in progress | 7 days | 24 hours to 30 days |
| DLsite all time | 7 days | 24 hours to 30 days |
| Remote source popular list | 24 hours | 1 hour to 7 days |

DLsite's day and year turn over in Japan Standard Time, so the year in
progress is read in JST. An annual list is pulled once more from 3 January
JST after its year, even with automatic pulls off; the first such pull in
which both sort variants succeed records `final_at`, and a finished list keeps
no schedule. With
`follow_current_year`, on by default, the final pull adds the list of the
year then in progress with the same settings and variants and asks for its
first pull. An earlier year added from the settings is pulled once and
finished at once.
**Refresh now** on a finished list pulls it again; an unchanged order adds no
snapshot.

### Recording and history

Recording compares the pulled codes of a variant, in order, with the
variant's latest snapshot. An unchanged order refreshes the entries' display
text and moves the
snapshot's `confirmed_until` forward. Any other order adds a
`ranking_snapshot` with its ranked codes, confirmed at its pull, and updates
each `ranking_entry`: first appearance, the start of the current continuous
presence, best rank, and number of appearances. Entries are codes, and
reading a ranking resolves works by code. An entry is in the library when its
work has files: an available local, cached, or tracked remote location. For an
account with `workflows:run`, the page also marks the codes the Availability
Watch pool watches, directly or through another edition of their family.

A page reads one variant, the default one unless `release` and `sort` name
another the list is pulled in. The latest page compares the variant's latest
snapshot with a baseline of the same variant: the snapshot the account last
displayed (`user_ranking_state`), the previous snapshot, a picked snapshot, or
the snapshot in effect at a picked time. Without a stored or retained seen
snapshot it uses the previous one. A code missing from the baseline is new when
the variant first held it after the baseline and re-entered otherwise; codes of
the baseline missing from the shown snapshot are dropped. Displaying the latest
snapshot records it as seen for its variant, never moving the seen snapshot
back, and a chip's unseen mark reflects the variant the chip shows. A remote
list's covers go through the image proxy, never as the source's address.

A history page shows the snapshot in effect at a requested time `T`: the
latest pulled at or before `T`, compared with the snapshot before it unless
another is named. Its coverage is `confirmed` when a pull confirmed that order
at or after `T`, `unpulled` with the last confirmation time when no pull ran
between it and `T`, and `before` when `T` precedes the history. The page also
names the snapshots before and after the shown one. A paged timeline lists a
variant's snapshots within a time range. Viewing history never records a
snapshot as seen.

History is kept in tiers, configured in the Rankings settings by an account
with `metadata:sync`:

- Every changed snapshot stays for the full retention, 30 days by default. A
  snapshot's age is when the next snapshot of its variant replaced it, so the
  order still in effect is never old.
- After it, the snapshot in effect at the end of each JST day stays for the
  daily retention, one year by default or forever.
- A variant's latest snapshot, every snapshot of a finished annual list, and
  any snapshot an account last displayed are always kept.

The database cleanup task for old ranking history and its daily automatic run
apply these tiers, then remove the entries that no kept snapshot of their
variant holds, so retained history keeps its titles and circles.

Demo serves fixed sample rankings with a short history in each order, built
from obviously synthetic names and reserved codes, and refuses every change.

## Shown Works Actions

Two system workflows act on the works an account is looking at on the
Subscriptions page, only when it asks; no schedule, ranking pull, or
subscription refresh starts them. Both are incremental: each takes only the
shown works that still need it, at most 100 in the order shown, and with
nothing to take queues no run. A request names what is shown:

- `POST /api/rankings/{id}/metadata-sync` and `POST
  /api/rankings/{id}/source-check` take the `snapshotId` of the shown
  [ranking](#rankings) order, which must belong to a list the account may see.
- `POST /api/subscriptions/feed/metadata-sync` and `POST
  /api/subscriptions/feed/source-check` take the `page` and `days` of the
  account's [release feed](#creator-subscriptions) page; the works are the
  codes its family cards show.

A request for the same order or feed page while its run is queued or running
joins that run. Demo refuses both.

- `shown_works_metadata_sync` requires `metadata:sync`. It takes the codes that
  have no work and those whose work's DLsite metadata is missing or older than
  a day, and leaves works DLsite does not list. The shown codes are explicitly
  requested metadata roots, so the run synchronizes each code's DLsite family
  in the order shown through the paced DLsite client, holding
  `metadata:provider`, and may create their edition works, as Availability
  Watch does for watched codes. A code that fails is recorded and the run goes
  on; the run is partial when some codes failed and failed when every code
  did.
- `shown_works_source_check` requires `remote:track` and an enabled source that
  supports work lookups, or answers `409` with `no_remote_source`. It takes
  the codes that have no work and the works not known to be available: without
  an available location or source presence, and whose `source` presence was
  not checked within a day. The run probes the sources once, then asks the
  healthy ones about each code through the paced crawl lane, holding
  `remote:availability`, and records the answer as the `source` presence of
  a code that has a work. It never creates works. Its summary lists, for every
  code, the sources that have it and those that do not, so the page can show
  the answers for codes without a work. After five codes in a row that no
  source answered, it stops and the run is partial.

## Preset Workflows

Preset workflows are system definitions whose graph is composed by the server
from a small validated parameter set. The typed workflow graph runtime
(`workflow_graph*.go`; persisted as `custom_workflow` jobs with checkpoints and
retry) executes the node kinds the presets compose. `circle_catalog_sync`,
`series_catalog_sync`, and `voice_catalog_sync` share one input, filter, and
actions shape:

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
bound of 5000. Syncing a circle or voice actor catalog is therefore an explicit
request for its catalog.
With `metadata` off the run only refreshes the catalog (and checks sources), so
the filter and tag are dropped; a series has no catalog refresh and requires
the metadata action. Refreshing the metadata of works that already have it is
Metadata sync with a circle or voice actor [scope](#metadata-sync-scope).
Catalog sync presets never track or fetch remote works; those actions belong
to Availability Watch, remote collections, and Fetch. The presets run on
demand and accept no trigger: following a catalog on a schedule is a
[creator subscription](#creator-subscriptions).

An administrator with `sources:write` reviews the user definitions saved in
`legacy_workflow_snapshot` during library onboarding. An upgrade from a
database below schema version 35 fills that table, with each definition's
triggers, before the numbered migrations run. The review offers conversion only
for a graph equivalent to a current preset with Startup or schedule triggers.
Conversion subscribes the reviewing account to the circles, series, or voice
actor the graph read; their baselines come from the next successful catalog
pull. Any other definition can be skipped or exported.

`GET /api/workflow-presets` publishes each preset's parameter schema; the
Workflows page renders it as the selected workflow's run form.
`POST /api/workflow-presets/{code}/runs`
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

The catalog sync presets reject the unsupported inputs `newWorks`, `existing`,
`action`, `sourceId`, `metadataRefresh`, and the Fetch limits with a
reconfiguration message rather than reinterpret them. Preset runs are
system-scope runs and share the visibility, cancel, retry, and Activity
behavior of built-in runs.

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
a work whose code lies in several folders switches that run to full mode. An invalidated root keeps
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
available at the same root without newly missing locations; otherwise the work
is indexed again lazily. A full scan commits discovered
folders in batches of 250, so progress saves and other writers are not locked
out for the whole library, and marks unseen works missing only in its final
transaction. An interrupted scan therefore records what it found and marks
nothing missing, and its retry repeats the idempotent folder writes. A folder
whose work, presence, and folder location already match is not rewritten, so
its timestamps record its last change. A work whose code is found in several
folders keeps every one of them as an active folder (see
[File Availability](data-model.md#file-availability)): none of their locations
is invalidated in favour of another, and the scan raises nothing for review.
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
lazily the first time a work's media is requested. A lazy request indexes every
active folder of the work that has no indexed files yet, and skips a folder
that cannot be read, such as one in an offline pool. It never discovers new work
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
`job.interrupted_by_stop` event in both cases. A job waiting for the
`media:cleanup` resource while another job, scan, or Fetch publication changes
library folders stops waiting when the service stops or its run is cancelled.
Fetch publication does not start once a stop has begun, and a publication that
already started finishes its directory swap and records it before the job
stops.

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
`offline_pools` summary; no online pool fails the scan.
A folder below a walk's start that the walk cannot read, for lack of
permission or because it disappeared during the walk, is skipped and recorded
in an `unreadable_folders` summary that makes the scan `partial`; recorded
roots at or below it leave the scope, so they keep their state. Any other walk
error still fails the scan. Every walk, the folder watcher, and file indexing
skip the directories and files `localfs.IsIgnoredDirectoryName` and
`IsIgnoredFileName` name: Kikoto's own transaction directories and the NAS and
operating system additions such as `@eaDir`, `#recycle`, `__MACOSX`, `._*`,
and `.DS_Store`. Of these directories, `localfs.IsMetadataDirectoryName`
names the ones that only hold metadata and never the user's files: `@eaDir`
and `__MACOSX`. A recorded root in any other ignored directory, such as a
recycle bin or snapshot, is outside the scope, and its locations are never
marked missing. A recorded root in a metadata directory
(`localfs.IsMetadataPath`) is never a work folder: it is never indexed or
made primary, and a scan whose online-pool, depth, and unreadable-folder
limits reach it marks it and its locations missing as not found. Inside a
root a scan finds or an
index reads, such an entry is not a file of the work: the scan marks a
location recorded there missing, while the rest of a completed index stays
valid. Fetch planning resolves
new works into the Fetch pool and existing folders in their own pool, rejects
`library_not_configured`, `fetch_pool_required`, `fetch_pool_offline`, and
`library_offline` with `409`, records the pool as `transactionPool` in the
plan, and creates staging, backup, and quarantine entries under that pool.

Pool availability outside scans is computed per request and never stored. A
local file location, work folder, or local presence on an offline pool keeps
its indexed state, and responses report its availability as `offline`, without
a stream URL; it reads as available again once the pool is back, without a
scan. Library filters and counts still treat such a work as local. Every read,
write, or deletion of library files checks the pool of the path it touches
first: streaming, download, text preview, HLS playback, ASR, local file
refresh, Edit files and its copy and merge folders, lyrics edits and their copy
folders, generated-lyrics publication, file and folder deletion, workflow
review cleanup, Fetch trash deletion, and a starting or resuming Fetch run. A
refused request answers `409` with `storage_pool_offline` in pool mode or
`library_offline` in standard mode and changes nothing. Fetch quarantine leaves
a root on an offline pool in place, opening a work does not index a folder on
one, cover candidates omit its images, and the duplicate-file check leaves its
files out.

`remote_work_fetch` runs are named `Fetch <code>` and record the queuing
workflow as their trigger reason. The Workflows page's Fetch run form accepts one work code
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

It has no trigger of its own. The [subscription refresh](#creator-subscriptions)
queues it after each refresh while its Availability Watch option is on, using
the account that last configured the watch, and it may also be run directly
from the Subscriptions page, where its configuration and pool are managed.
Workflows lists its runs and links to that page. Each execution snapshots the
active pool and
records a normal workflow run, node runs, and durable job. Before checking a
target, the run synchronizes the code's DLsite family metadata when it has not
been refreshed within a day; a watched code is an explicitly requested metadata
root, so this may create its edition works. A metadata failure marks only the
metadata node partial and the check uses the family already known; a code
DLsite does not list is checked alone. The target is available when a remote
source offers any edition of its family: the watched code first, then the
other editions and provider-declared edition codes, at most 32. The target
records which edition was found, and Track, Fetch, and opening the remote work
use that edition. Remote results never materialize new `work` rows.

Because every run refreshes DLsite metadata, Availability Watch configuration,
target edits, and manual runs require `metadata:sync`; Track also requires
`remote:track`, Fetch also requires `remote:fetch`, and Track plus Fetch
require both remote permissions. A run the subscription refresh queues
re-checks the configuring account's complete permission set.

Available targets form the pool's Available side; configured Track and Fetch
actions are child workflows with their own histories. A successful run that
finds new available works creates a notification for every enabled account
that holds `workflows:run`, which opens the pool's Available side, and adds
each newly available work to those accounts' release feeds.

`PUT /api/availability-watch/targets` replaces the pool;
`POST /api/availability-watch/targets` adds codes without deactivating
targets added by someone else. The view returns each target's title and
cached cover (its own, or the family original's) and its known family editions
with their titles and languages.

## Voice Catalog Refresh

Opening a voice actor detail reads the persisted local works and voice catalog
only; entering either a voice or circle detail never queues a workflow.

Circle and voice actor detail refreshes are catalog sync preset runs without a
tag or filter. `POST /api/circles/{externalId}/refresh` and `POST
/api/voices/{personId}/catalog/refresh` only queue a `circle_catalog_sync` or
`voice_catalog_sync` run and return its id. A circle refresh runs the catalog node,
the optional source-check node, and the metadata action for catalog works that
lack metadata. A voice actor refresh runs the catalog node and a
`voice_metadata` node limited to the voice actor's known works; it never
materializes a catalog-only row. A voice actor metadata retry uses the stored
catalog. A
request identical to an active run for the same creator joins it, and a
different request is rejected until that run settles. A detail refresh is
authorized by `metadata:sync`; because its graph holds only refresh steps, the
run carries `workflows:run` on the requester's behalf. Circle detail returns
the newest catalog sync run for the circle so the page can follow it across
reloads.
The only inline circle refresh is the bounded incremental catalog lookup
that resolves a series link. Creator
catalogs expose Never, Attention, or Synced from their last successful pull and
the configured freshness window. An authorized user can start an explicit First
pull or manual refresh through the same catalog sync workflow.

Reading a circle, changing its per-user state, and a detail refresh never
create one. An unknown maker id returns `404` with `circle_not_in_database`;
the page offers a user with `metadata:sync` and `workflows:run` the
`circle_catalog_sync` run form with that id filled in, and asks anyone else to
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
metadata node; it synchronizes them within the same `voice_catalog_sync` run
rather than creating one metadata workflow per work. Metadata incremental
refreshes select only those known canonical work families without a DLsite
snapshot; full refreshes retry every known canonical family. Neither mode
materializes a catalog-only row as a work. Metadata failures can make the
workflow partial without making an otherwise complete catalog generation stale.

## Creator Subscriptions

A creator subscription asks for new releases of one circle, one series of a
circle, or one voice actor. It is personal state (`favorites:write`) and is
separate from Favorite. Subscribing never creates a circle, series, or voice
actor; an unknown circle is added by its catalog sync first. A voice actor
subscription needs an enabled compatible remote source, because the voice
actor catalog comes from remote sources.

A circle subscription includes the circle's series. An account cannot
subscribe to a series of a circle it subscribes to, and subscribing to a circle
removes that account's subscriptions to its series once the account confirms
it. A circle merge keeps each account's subscriptions on the target with this
rule applied, and a voice actor merge keeps them on the target; Undo restores
both sides.

Subscribed works come from catalogs: a circle and its series from the DLsite
circle catalog, a voice actor from the voice actor catalog. Each circle and
voice actor keeps a seen set of the catalog codes already accounted for. A
subscription takes effect when its catalog has a baseline: right away when the
catalog was pulled within the catalog freshness window, otherwise after the
next successful pull that finishes after it was created. Taking effect records
the whole catalog in the seen set, unless another active subscription already
keeps that set current, so works already in the catalog never count as new. A
user with `metadata:sync` may queue that pull while subscribing: a full pull
for a catalog never pulled, an incremental one otherwise; anyone else waits for
the next refresh.

One system workflow, `creator_subscription_refresh`, serves every account:

```text
catalogs (each subscribed circle and voice actor once)
  -> metadata (DLsite family sync of codes outside the seen sets)
  -> feed (one entry per subscriber whose subscription covers the code)
  -> watch (queue Availability Watch)
```

A catalog pulled within the last six hours, for example by a detail refresh,
is not pulled again. A failed pull keeps the earlier catalog and makes the run
partial. Codes outside the seen sets are synchronized newest code first, at
most 60 per run; the rest wait for the next run. A code DLsite does not list
enters the seen set without a feed entry, and a code whose metadata fails stays
unseen for a retry. Synchronizing creates the code's edition works, because a
subscription is an explicit request for its new works; catalog codes in the
baseline are never materialized. A work released more than 30 days before a
subscription took effect counts as seen for that subscriber, so a full catalog
refresh that surfaces old works adds no entries. A non-original edition whose
original was released more than 30 days earlier is a new edition rather than a
new release. A series subscription receives the codes its series lists.

The feed (`user_release_feed_item`) records one entry per account, code, and
event (`released`, `edition`, or `available`). Availability Watch adds
`available` entries for every account it notifies, and a target that becomes
available again moves its entry to the top. The Subscriptions page groups
entries by work family, newest event first, and shows each family through its
canonical work, or through catalog details when no work exists yet, and, for
an account with `workflows:run`, whether the Availability Watch pool watches
the shown code, directly or through another edition of its family. Each family
belongs to the day of its newest event in the account's time zone, and a feed
page holds 5, 10, or 15 days that have entries. Opening the
feed records it as read for the navigation badge. A run that adds entries for
an account creates one notification for that account. A subscription whose
Availability Watch option is on also adds its new works to the shared watch
pool, on behalf of a subscriber who may edit the pool.

The workflow has one fixed interval trigger, configured only on the
Subscriptions page by a user with `metadata:sync`: on or off, an interval from
1 to 168 hours (24 by default), and whether each refresh checks Availability
Watch. Startup plans its first run. The trigger needs no owner: the run holds
only refresh steps, and the Availability Watch run it queues uses the watch's
configuring account. Workflows lists its runs and links to the Subscriptions
page; the trigger cannot be edited or deleted there. `POST
/api/subscriptions/refresh` queues a run now; a run that is already queued or
running is kept.

Demo shows a fixed sample feed and subscription list built from obviously
synthetic names and reserved codes. It stores, refreshes, and links nothing.

## Review Candidates

Fetch honors an explicit Replace decision even when the target has the same
size or the source does not declare a size. A file copied from the existing
target into staging is not evidence that the selected replacement was staged.
After an interruption, only a staged file matching a previously verified
manifest hash may be reused; other selected files are copied from their chosen
local or cache source again before verification and publication.

Fetch planning identifies a target path without regard to letter case or
Unicode composition, because a library can sit on a filesystem that stores such
names as one file. Two selected files whose targets differ only that way are a
target conflict for the user to resolve. Verification requires every planned
file to be its own file in staging and refuses to publish otherwise.

A remote track title is untrusted and is normalized once into the name the file
is listed, planned, cached, and stored under: path separators and `.` or `..`
components are dropped, and a title with nothing left is named after its
position in its folder.

Workflow candidates capture user-reviewable outcomes such as unavailable
DLsite products and old local locations left after remote fetches. A Fetch from a source with restricted outbound hosts also creates a
`remote_origin_blocked` candidate when a media origin is outside that source's
boundary. The run and active node become partial, the recoverable job is not
automatically retried, and Activity records only the normalized origin rather
than the media path or query. After an administrator changes the source policy,
a manual Retry resolves that candidate and resumes the same run.

The **All** filter of Metadata's DLsite works sends `reason=catalog` to the bounded maintenance read.
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

## Metadata preview and apply

The work metadata editor can request a bounded preview for one existing work
without writing provider snapshots, projections, work identities, or workflow
state. The preview is retained privately for a short period and is bound to
the requesting user, work, and the work's update timestamp. Applying it fails
when the work changed after the preview was opened.

The comparison presents current, fetched, and expected values. Selecting a
fetched value accepts provider metadata and clears an older manual override
for that field. Editing the expected value creates a manual override. Keeping
the current value while accepting another fetched field pins that current
value as a manual override so the provider update cannot replace it. Shared
tag overrides are cleared only when fetched tags are explicitly accepted.
The comparison can merge current and fetched tag concepts by stable tag id; the
result keeps current concepts as explicit additions to the fetched provider
set. A fetched DLsite family is accepted by a separate action and uses the
bounded family sync path, so ordinary field acceptance never materializes
sibling editions.

## Remote Metadata Fallback

The detail metadata editor also offers an explicit `From <source name>`
refresh for each enabled source with declared metadata capability, and
Metadata issue recovery offers the same per source.
`POST /api/works/{id}/metadata-sync` and `POST /api/metadata/issues/retry`
accept an optional `sourceId`; without one they queue the DLsite family
refresh. Issue recovery with a source still queues only works with a pending
DLsite issue or a family that was never synced. A source refresh requests only
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
