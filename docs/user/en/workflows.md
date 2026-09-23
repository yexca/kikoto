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
  workflows support editable Startup and interval triggers. Local scan ships
  with the default Startup trigger and does not check remote availability or
  synchronize metadata. Manual, Startup, and interval scans expose a
  disabled-by-default `Follow-up run`; enabling it queues an independent
  metadata run after the scan finishes.
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
- Follow a circle, Follow a series, and Follow a voice actor are preset
  workflows. Their Run options hold the target, filter, action, Fetch limits,
  and tag template; the same fields configure Startup and interval triggers.
  The target accepts up to 20 comma-separated circle IDs, series IDs, or voice
  actor names, whose catalogs are combined before filtering. Sync metadata only needs no source;
  Track and Fetch need an enabled compatible remote source, and Fetch requires
  download management permission plus explicit file, size, and free-space
  limits. New works only skips works already in the library. The work limit is
  on by default; switching it off still stops a run at 100 works. The release
  date range is off by default; when on, each end is a date or No limit, and
  works released on either boundary date are included. Turning the tag template
  off skips tagging. Automated runs use stored or incremental circle
  catalog refresh; a full refresh is manual only.
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

## Current Limits

- Retry and checkpoint recovery apply only to workflow families that explicitly
  declare their jobs recoverable; an arbitrary failed node cannot be resumed in
  isolation.
- Workers run inside the Kikoto process, so queued jobs make progress only while
  that process is running. Distributed or multi-instance execution is not
  supported.
- Restart and expired-lease recovery are bounded by each job's retry budget.
  Manual stale-run recovery marks interrupted non-recoverable work failed for
  inspection.

## Related Docs

- [Architecture workflows](../../architecture/workflows.md)
- [Reliability](../../operations/reliability.md)
- [Testing](../../development/testing.md)

Run monitor: each workflow page lists its stages on the left and the most recent run's log on the right. While a run is active, new log lines stream in and the log follows the latest output unless you scroll up. Select a stage to show only its lines, and select the run summary to open that run in Activity.
