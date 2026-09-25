# Workflows
[English](../en/workflows.md) · [简体中文](../zh-Hans/workflows.md) · [繁體中文](../zh-Hant/workflows.md) · [日本語](../ja/workflows.md) · [한국어](../ko/workflows.md)

Workflows make backend actions inspectable.

## User Surfaces

- Workflows: built-in definitions, including the preset follow workflows, with
  their triggers managed in the selected definition. There is no custom
  workflow editor.
- Activity at the right end of the workflow tabs opens a desktop panel or mobile
  sheet for the selected workflow only. Active runs appear above **Needs attention**
  and **History**. Each row shows the status, run number, trigger, and elapsed
  time. List rows and **Recent runs** open details inside the same panel: start
  and finish times, duration, trigger, steps, candidates, run actions, and a
  collapsed **Diagnostic log** of run events. **Back to runs** returns to the
  list. Old Activity links automatically open Workflows and select the run
  context; the separate full Activity page has been removed.

## Current Behavior

- Local scan records folder discovery and local source presence without waiting
  for a metadata provider. Metadata sync, source availability, remote sync,
  cache, fetch, cleanup, circle refresh, and bulk remote actions record separate
  workflow runs.
- For one unambiguous local work, a scan marks old local file locations missing
  when the folder disappears or its stored paths no longer belong to the
  detected folder. It does not delete files or change Fetch ownership. A moved
  folder is indexed lazily when opened; duplicate-code folders remain in Needs attention.
- Node runs expose step-level progress.
- Candidates expose reviewable outcomes.
- Needs attention contains terminal runs with unresolved candidates that need a user
  decision. Routine partial or skipped outcomes remain in History and keep
  their warning status, summary, and events for inspection.
- The header notification center combines Review items with completed or failed
  Fetch results. Fetch notifications open the local work detail and can be
  dismissed independently for the signed-in user.
- The horizontal definition bar lists the built-in workflows in a fixed order,
  with the preset follow workflows after the collectors. Definitions cannot be
  created, edited, or deleted from the page.
- Needs attention collects unresolved candidates, metadata issues, and
  unacknowledged failures. Resolving recorded issues clears the corresponding
  dedicated metadata-run notice. Other failures can be marked reviewed once
  outstanding issues are resolved. This acknowledgement is per user. History
  keeps the original outcome, including failed, partial, and cancelled runs.
- Metadata owns pending-work recovery and metadata settings. Its metadata
  sync shortcut selects the existing workflow here.
- Built-in local scan, metadata sync, remote popular, and DLsite popular
  workflows support editable interval triggers; local scan and the two popular
  collectors also support Startup triggers. Local scan ships
  with the default Startup trigger and does not check remote availability or
  synchronize metadata. Manual, Startup, and interval scans expose a
  disabled-by-default `Follow-up run`; enabling it queues an independent
  metadata run after the scan finishes. Metadata sync has no Startup trigger,
  so it cannot compete with a scan follow-up.
- Local scan also ships with one fixed, enabled folder watcher. It can be paused,
  resumed, or switched between Incremental and Full, but it cannot be created,
  duplicated, converted, renamed, or deleted. Incremental is the default. The
  watcher registers discovery directories and every descendant directory below
  a recognized work root, then dynamically registers new directory trees. It
  waits five seconds after the most recent observed event, ignores Kikoto's
  staging, backup, trash, and claimed per-source Fetch trees, and reconciles the
  affected work roots. Removed files and folders become `missing`; database
  records are retained. Watcher errors, oversized event batches, root
  invalidation, and duplicate roots automatically use a full scan. Fetch
  registers its own published locations directly; Manual, Startup, and interval
  scans always inspect the complete data tree. Changes during an active run
  produce at most one follow-up scan. Paused events are discarded; offline
  changes rely on the default Startup scan.
- **Refresh local work files** sits second, after the local scan. It indexes the
  media files inside local work folders that a scan has already discovered, so
  opening a work does not index a large folder on demand. **Incremental** (the
  default) covers only folders whose files were never indexed; **Full**
  re-indexes every available local work. One run is queued or running at a
  time, and starting another returns the active run. It supports Startup and
  interval triggers that store the mode, and ships without a default trigger.
- Remote and DLsite popular collection surfaces edit tag templates with a
  current-value preview, the complete workflow-specific variable list, and an
  explicit warning when the rendered tag exceeds 40 characters. Manual runs
  expand the template on request; automatic triggers store it unchanged and
  expand it at dispatch. A manual run can turn tagging off; its tag step is
  then recorded as skipped. Remote automatic collection is Track-only so it
  cannot bypass Fetch size and disk-reserve safeguards.
- Every workflow exposes `Run` in its header. Workflows with run parameters show
  them in a Run options section directly below the header, with each label
  beside its control, so the inputs, tag preview, and run action stay visible
  without opening a dialog. Options apply to the next manual run only and reset
  when another workflow is selected.
  Local scan shows its follow-up option there; built-in workflows without run
  parameters show only the run action.
- Availability Watch keeps a saved configuration. `Configure` beside `Run`
  opens a panel for the remote source, the action on availability, and optional
  Fetch extension exclusions, which are off until enabled; the section below
  the header summarizes the saved values that `Run` uses.
- Follow a circle, Follow a series, and Follow a voice actor (tab **VAs
  follow**) are preset workflows. Their Run options have three sections:
  **Input** (the target and the catalog refresh, Incremental or Full),
  **Filter** (a release date range and a work limit), and **Actions** (Sync
  metadata, the tag template, and for circles Check remote sources). Trigger
  popovers use these values by default; enable Customize run options to
  override them.
  Circle and series targets accept up to 20 comma-separated IDs, whose catalogs
  are combined before filtering. The voice actor target is one picked voice
  actor; its catalog is refreshed on the checked remote sources with the
  display name and confirmed aliases. A series reads its stored works and has
  no catalog refresh.
  Sync metadata covers the catalog works that lack metadata, including works
  not yet in the library, and the filter and tag apply to those works. Every
  filter is off by default: without a release range or work limit, a run syncs
  every catalog work that lacks metadata. The tag template is also off by
  default; turn it on to tag the synced works. A trigger popover warns when an
  automated follow has no filter and recommends turning one on. With Sync
  metadata off, a circle or voice actor follow only refreshes the catalog (and
  checks sources). Track and Fetch are no longer follow actions; use Remote
  popular, Availability Watch, or a work's detail page instead. Automated runs
  use incremental catalog refresh; a full refresh is manual only.
- Upgrading disables follow triggers saved before these options, and each shows
  that it needs reconfiguring. Open the trigger, check its Run options, save it,
  and turn it on again.
- Metadata sync refreshes works already in the library. Its Run options choose
  **Works** (All works, one circle's works, or one voice actor's works) and
  **Refresh** (Missing or outdated, or All metadata). Its interval triggers
  store the same choice.
- User-authored custom workflows, the DAG editor, slash commands, and the
  definition run dialog were removed. Upgrading deletes existing user
  definitions and their triggers; their runs stay in Activity history.
- DLsite popular collection supports 24-hour, 7-day, 30-day, and annual voice
  rankings. Recent periods can be limited to works released within 30 days;
  annual runs select an explicit year and default to a template containing
  `{year}`. Runs synchronize metadata and append the previewed user tag without
  replacing existing user tags.
- A queued or running Fetch is unique per canonical work. Repeated Fetch
  requests reuse that run instead of downloading the same work twice, and every
  requesting user receives the shared run's terminal notification.
- Fetch Activity reports byte-level remote-transfer progress, the observed
  transfer rate, and the estimated time remaining. Unknown-size files stay
  explicit and suppress percentage and remaining-time presentation until their
  actual size is known.
- Each Fetch run is named after its work, such as `Fetch RJ00000001`, and
  Activity search finds a Fetch by its work code. The **Fetch** tab lists Fetch
  history and steps but has no Run form: a Fetch always starts from a work.
  Fetches queued by Availability Watch, bulk actions, popular collections, or
  preset workflows record that origin as their trigger reason.
- On a new install, the local scan's Startup trigger and folder watcher start
  off; library setup offers to turn them on. An upgraded instance keeps its
  existing triggers.
- A scan never marks works missing in a place it cannot see: an unmounted data
  folder or offline storage pool, or folders deeper than the scan depth. A scan
  of an unmounted standard library fails and changes nothing; a scan that skips
  an offline pool finishes as partial and names the pool.

## Current Limits

- Retry and checkpoint recovery apply only to workflow families that explicitly
  declare their jobs recoverable; an arbitrary failed node cannot be resumed in
  isolation.
- Workers run inside the Kikoto process, so queued jobs make progress only while
  that process is running. Distributed or multi-instance execution is not
  supported.
- A normal service stop returns a running recoverable job to the queue without
  spending its retry budget. Recovery after a crash, forced kill, or expired
  lease is bounded by each job's retry budget. Manual stale-run recovery marks interrupted non-recoverable work failed for
  inspection.

## Related Docs

- [Architecture workflows](../../architecture/workflows.md)
- [Reliability](../../operations/reliability.md)
- [Testing](../../development/testing.md)

Run monitor: each workflow page lists its stages on the left and the most recent run's log on the right. While a run is active, new log lines stream in and the log follows the latest output unless you scroll up. Select a stage to show only its lines, and select the run summary to open that run in Activity.
