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

## Current Built-In Workflows

- Local library scan.
- Metadata sync.
- Remote source sync.
- Source availability check.
- Availability Watch.
- Media cache.
- Remote work fetch.
- Remote bulk action.
- Remote popular collection.
- DLsite popular voice collection.
- Cache cleanup.
- Local location cleanup.
- Database optimization (single-flight `VACUUM`; see
  [Database](../operations/database.md#maintenance)).
- Preset follow workflows: Follow a circle, Follow a series, Follow a voice
  actor. Circle and voice actor detail refreshes run as follow runs.

## First Library Metadata Prompt

After a local scan finishes, Library offers metadata synchronization when active
local work folders lack DLsite snapshots and no bulk metadata run has occurred.
Empty libraries and scans still in progress do not show the prompt. Only users
with metadata-sync permission see it; Demo mode does not offer this action.

The prompt starts the existing background metadata workflow. Repeated clicks
reuse its recorded run, and an already active bulk sync shows its current state.
Library retains browsing and playback while the prompt shows queued/running or
terminal status. Activity is linked for users with workflow permission. The
initiating user receives a notification when the run succeeds or needs attention.
Choosing Later dismisses the prompt for the instance; existing manual metadata
sync entry points remain available. The dismissal and selected run are stored
in `app_setting`, so they survive browser changes and server restarts.

## Metadata Sync Scope

Metadata sync maintains works that already exist; it never reads a catalog to
add works. `POST /api/workflow-runs/dlsite-sync` and its interval trigger
accept an optional scope:

| Input | Values | Default |
| --- | --- | --- |
| `scope` | `all`, `circle` (with `circleId`), `voice` (with `personId`) | `all` |
| `mode` | `missing` (no DLsite snapshot, or a stale origin link), `full` (every selected work) | `missing` |

A circle scope covers works credited to the circle (circle, translator circle,
or official translation brand) and works of its stored catalog that already
exist. A voice actor scope covers works crediting the voice actor and works of
the voice actor's catalog that already exist. An empty body keeps the previous
behavior. Each scope is a separate singleton: repeating the same scope while it
is queued or running joins that run, a different scope queues its own run, and
all metadata sync runs share the `metadata:provider` resource. Local scan
follow-ups coalesce only into a queued unscoped `missing` run. A retry repeats
the failed run's scope.

## Metadata Recovery

Metadata synchronization remains a workflow. Metadata management owns the current
attention list and metadata settings; sync itself starts from Workflows.
Activity run detail links to the unresolved
issues encountered by that run. Selecting works queues recoverable family-sync
jobs, reusing an already queued/running job for that family. Explicit recovery
can recheck a provider's `not_found` observation without erasing it first.
Normal bulk and work-detail refreshes retain their unavailable-product skip.

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
exposing settings to metadata-only operators. Metadata management presents All and attention categories horizontally.
Metadata settings open in a popover anchored to the header, with the current list retained underneath.
Activity links use `/metadata?reason=metadata&metadataRun=<id>`;
legacy Maintenance work and metadata links redirect to Metadata management. Filtering by a run additionally
checks workflow permission and that run's ownership. Successful recovery changes shared work state, never
`workflow_run_review` or the historical execution status.

All production DLsite family syncers share an application-instance coordinator.
Identical in-flight requests reuse their result; requests for different
editions/settings of the same known family wait. Per-product gates cover
overlapping discovery and cover writes. Unrelated families can proceed within
the active metadata job, subject to provider pacing.
Database attempt ordering prevents late failures from replacing newer outcomes
and late successes from replacing newer successful metadata. This is not a
distributed request lock between separate application processes.

## Activity Summary

Workflows exposes Activity at the right end of its horizontal definition bar.
The desktop popover and mobile sheet show active runs above two server-paged
views: Needs attention and History. The active list and both views are global
across workflow definitions, so a job
submitted from one workflow remains visible while another definition is open.
Recent runs and list rows open full run details inside the same panel; returning
to the list retains the global scope. There is no separate Activity page.
Legacy `/activity` and `/runs` links redirect into Workflows; a linked run resolves
its workflow before loading history, including a read-only context for workflows
without a configurable definition. Account and notification entries open this
same surface. Events, candidates, progress, retries, and cancellation remain
available within the panel.

The active list contains running and queued jobs; Needs attention contains
terminal runs with unresolved candidates, pending metadata issues, or
unacknowledged failures. A dedicated metadata-sync failure with recorded issue outcomes leaves attention
when those issues are resolved. Unrecorded failures still require
acknowledgement. The successful-attempt boundary prevents a later failure from
reopening an older resolved association. History contains successful runs and
runs that were cancelled or manually acknowledged, while unresolved failures
remain in Needs attention. Acknowledgements belong to the viewer; they cannot
dismiss an active run or unresolved candidate/metadata issue. Demo keeps these
actions read-only.

## Popular Collections

Remote popular collection reads the configured compatible file source's own
recommendations and may track or fetch those remote works when run manually.
Startup and interval triggers retain a bounded Track configuration and expand
their tag template when each run is dispatched. Automatic Fetch remains in the
typed preset-workflow path where file, byte, known-size, and disk-reserve bounds
are explicit.

DLsite popular voice collection reads the provider ranking for 24 hours, 7
days, 30 days, or a selected year. Non-annual runs may be limited to works
released within 30 days. The recoverable worker synchronizes metadata and
appends a run-specific tag owned by the user who started the run. It does not
create remote file-source presence or fetch media.

Both collectors accept `skipTag` on a manual run. The run then renders no tag,
adds none, and records its tag node as `skipped`; omitting the template without
`skipTag` keeps the previous required (remote) or default (DLsite) tag.

Configurable built-in triggers retain the configuring user for user-owned tag
effects and revalidate that user's permissions when dispatching. Triggered runs
store both their trigger reference and the final resolved input.

## Preset Workflows

Preset workflows are system definitions whose graph is composed by the server
from a small validated parameter set. They replace the removed user-authored
custom workflow editor: `workflow_definition` rows are system-scope only, the
definition CRUD, preview, node-type, slash-command, subworkflow, and workflow
input surfaces are gone, and migration 035 deletes any remaining user
definitions with their triggers while runs keep their code and name snapshots.
The typed workflow graph runtime (`workflow_graph*.go`; persisted as
`custom_workflow` jobs with checkpoints and retry) stays and executes the node
kinds the presets compose. `circle_follow`, `series_follow`, and
`voice_follow` share one input, filter, and actions shape:

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
Track and Fetch are no longer follow actions.

`GET /api/workflow-presets` publishes each preset's parameter schema; the
Workflows page renders it as the inline Run options below the workflow header and
as the startup or interval trigger form. `POST /api/workflow-presets/{code}/runs` validates the inputs,
checks that a selected source is an enabled compatible remote source, renders
the tag template for this dispatch (`{date}`, `{target}`), builds
the graph, validates it with the typed workflow graph validator, and enqueues
one recoverable `custom_workflow` job. The job payload carries the built graph,
so Activity shows the real nodes while the definition record only stores a
display pipeline. Required permissions are derived from the composed node
capabilities: catalog refresh and metadata need `metadata:sync`, tagging needs
`tags:write`.

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
incremental catalog refresh only; a full refresh remains a manual action. An
input the follow presets no longer accept (`newWorks`, `existing`, `action`,
`sourceId`, `metadataRefresh`, and the Fetch limits) is rejected with a
reconfiguration message rather than reinterpreted. Migration 039 disables every
follow trigger saved before this shape and records that message; saving the
trigger again clears it. Preset runs are system-scope runs and follow the
existing visibility, cancel, retry, and Activity behavior of built-in runs.

## Local Folder Trigger

`local_library_scan` owns one fixed `filesystem_event` trigger created by the
database migration and enabled by default. The API allows pause, resume, and a
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
duplicate work root switches that run to full mode. An invalidated root retains
the recovery request across watcher restarts and dispatches it only after the
replacement watcher has settled.

Kikoto's `.kikoto-staging`, `.kikoto-backup`, and `.kikoto-trash` transaction
trees are excluded. Claimed per-source Fetch roots are also excluded because
Fetch registers final publication directly. A markerless root from an older
release receives the same exclusion only after same-source Fetch history
explains its complete visible structure and at least one exact historical target
exists on disk; watcher configuration does not write the missing marker.
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
idempotent reconciliation. Full scans retain the existing folder-presence and
lazy-index repair behavior. Duplicate-code groups skip automatic invalidation,
fall back to full discovery, and remain review candidates. Neither mode rewrites
`managed_fetch` ownership records.

Local scan and metadata sync have separate definitions, jobs, resource labels,
statuses, failures, review candidates, and retry histories. A local scan never
calls a metadata provider as part of its own run. Manual, Startup, and interval
scan configuration exposes `Follow-up run`; it defaults off and, when enabled,
queues a separate `metadata_sync` run only after the scan reaches a terminal
state. The fixed filesystem trigger keeps this option off. Queued automatic
metadata follow-ups are coalesced so a burst of scans does not create redundant
provider work.

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

Startup recovery remains the path for crashes, forced kills, and a stop that
exceeds its deadline: running jobs left with a lease are requeued from their
checkpoints and consume one resume, and interrupted Fetch publications are
reconciled from the staging, target, and backup directories.

## Source Availability

Source availability is checked by the backend instead of frontend fan-out.
Source-change checks first probe source health, then check candidate works only
against reachable sources. The local library scan does not check remote source
availability.

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
actions remain child workflows with their own histories. A successful run that
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
The only inline circle refresh left is the bounded incremental catalog lookup
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
else to contact an administrator.

The workflow searches the display name and every confirmed alias against each
enabled compatible source. It follows the source-reported result count through
all pages and applies no product-level page or result maximum. Outbound response
limits, a per-source deadline, cancellation, repeated-page detection, and a
three-source concurrency bound still protect the request boundary. Results are
deduplicated by canonical `primary_code` before each successful source is
persisted atomically.

A failed source keeps its previous catalog observations, while a complete
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
size or the source does not declare a size. A file copied from the previous
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
a manual Retry resolves the old candidate and resumes the same run.

The Metadata All category sends `reason=catalog` to the bounded maintenance read.
It lists already persisted work families, including those without pending issues,
using the same search, pagination, permission, and demo eligibility boundaries.
It does not discover providers or materialize catalog results. The legacy `all`
reason still means the attention union, and a run filter always narrows the read
to that run's unresolved metadata issues.

The canonical management URL is `/metadata`. Legacy `/work-management` URLs and
Maintenance work/settings links redirect there while preserving their category,
settings, and run context. Failed first-sync notifications and pending metadata
results open recovery here; operators without workflow access use the unscoped
issue list, since reading a run-scoped list requires workflow permission. Runs
without recorded pending issues retain their Activity diagnostics.
