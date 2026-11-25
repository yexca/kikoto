# Metadata Sync

What a metadata sync covers and how its first prompt, purchase bonus detection, and genre name learning work.

## First Library Metadata Prompt

After a local scan finishes, Library offers metadata synchronization when active
local work folders lack DLsite snapshots and no bulk metadata run has occurred.
Empty libraries and scans still in progress do not show the prompt. Only users
with metadata-sync permission see it; Demo mode does not offer this action.

The prompt starts the background metadata workflow. Repeated clicks reuse its
recorded run, and an already active bulk sync shows its current state.
Library keeps browsing and playback while the prompt shows queued/running or
terminal status. The run is linked for users with workflow permission. The
initiating user receives a notification when the run succeeds or needs attention.
Choosing Later dismisses the prompt for the instance; the manual metadata sync
entry points are unaffected. The dismissal and selected run are stored in
`app_setting`, so they survive browser changes and server restarts.

## Metadata Sync Scope

Metadata sync maintains works; it never reads a catalog to add works. Selected
codes are explicitly requested metadata roots, so a DLsite run may add their
works. `POST /api/workflow-runs/dlsite-sync` accepts an optional scope, and its
interval trigger accepts every scope except `works`:

| Input | Values | Default |
| --- | --- | --- |
| `scope` | `all`, `circle` (with `circleId`), `voice` (with `personId`), `works` (with `workCodes`) | `all` |
| `mode` | `missing` (no DLsite snapshot, or a stale origin link), `full` (every selected work) | `missing` |
| `workCodes` | 1–100 product codes; normalized, sorted and deduplicated. DLsite accepts codes without a work; a remote source requires existing works. | none |
| `sourceId` | An enabled metadata-capable remote source; omitted for DLsite. Circle requires DLsite; voice requires a remote source. | DLsite for all, circle and selected works |
| `remoteMetadataFallback` | DLsite only: `enabled` and up to 16 ordered source ids | disabled |
| `purchaseBonusAutoLink` | DLsite only: automatically detect purchase bonus links | true |

Manual runs and interval triggers store the same normalized options. Selected
works are a one-off request: creating or editing a trigger refuses `works`, and
a stored trigger with `works` switches itself off with that reason when it
fires instead of queuing a run. Selecting works in the UI defaults to full
refresh and accepts whitespace, commas and newlines.

With DLsite, a selected-works run first synchronizes the DLsite family of each
code that has no work, which adds its edition works, then refreshes the
selected works that already existed; a code the run added is not requested
twice. A code DLsite does not list adds no work, counts as unavailable, and
gets no remote fallback. A custom code without a work is skipped. A remote
source refreshes only existing works: submission rejects a code without a
work. Execution resolves the codes again, so a work deleted after queueing is
added again by a DLsite run and skipped by a remote one. Remote missing
mode checks the selected provider's snapshots, independently of DLsite;
full mode bypasses cached remote descriptions. Source capability and enabled
state are checked at submission and execution. DLsite full refresh of selected
works also retries products reported unavailable.

DLsite family metadata accepts `language_editions` as either an array or a
numeric-keyed object, including sparse objects returned by the provider. The
object keys are ordering hints; each edition's `display_order` remains the
relationship order. Provider responses that join several language tokens with
commas are normalized for edition matching and availability checks, so a
combined language value does not prevent the family from synchronizing. A
response with neither `translation_info` nor `language_editions` declares no
family; an edition that is already classified keeps its family and canonical
state, and only its descriptive fields follow the response.

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
runs share the `metadata:provider` resource. A scan that adds works joins
the run its After trigger's options already have queued, but never a running
one, which chose its works when it started; it queues its own instead. A retry
repeats every option of the failed run. Run choices do not write instance
settings or reorder existing remote metadata across the library.

### Purchase Bonus Detection

The run's `purchaseBonusAutoLink` option (default on) lets metadata sync link a
purchase bonus to its parent product (see
[data model](../data-model/overrides-normalized-fields-bundles.md#purchase-bonuses) for `work_purchase_bonus`). Family
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
languages, as described in the [data model](../data-model/work-metadata.md#work-metadata): the
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
