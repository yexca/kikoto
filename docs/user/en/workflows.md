# Workflows
[English](../en/workflows.md) · [简体中文](../zh-Hans/workflows.md) · [繁體中文](../zh-Hant/workflows.md) · [日本語](../ja/workflows.md) · [한국어](../ko/workflows.md)

Workflows make backend actions inspectable.

## User Surfaces

- **Workflows** lists what an administrator starts by hand to maintain the
  library, under **Library**: Scan local library, Refresh local work files,
  and Sync work metadata. Work on one target starts where that target is:
  Fetch from a work, a catalog sync from its circle, series, or voice actor,
  and a remote source's library work check from that source in
  [Library](settings.md#library) settings. There is no custom workflow editor.
- Each operation is one row: its name, what starts it on its own, its state,
  and a run control. The line under the name lists its automatic starts, such
  as **At startup**, **Watching folders**, or **Every 6 hours**, with when the
  next scheduled run is due, or says **Automatic runs paused** when every
  trigger is off. An operation that runs only by hand has no such line. The
  state reads **Never run**, **Starting**, **Queued**,
  **Running** with its progress, or how the latest run ended and when, such as
  **Succeeded** or **Failed**. **Needs review** marks a run with items that
  wait for a decision. Select the state to open that run in Activity.
- **Run** starts an operation with its default options, and the row shows the
  run at once. Scan local library and Refresh local work files cover the whole
  library, so they cannot be started again until their run ends. Sync work
  metadata runs per scope and can start a run for another scope while one is
  active. Its row follows the running run and counts the others, and a new run
  that waits behind another says so. Starting the same scope again while its
  run is active does not queue a second run. A run started by a schedule, at
  startup, or in another browser shows on its operation the same way.
- **Options** opens, below the row, one sentence on what the operation does
  with **All runs**, its Run options with their own **Run**, and its triggers.
  One operation is open at a time.
  Phones show the same list.
- When runs need attention, a line at the top of Workflows says how many and
  opens them in Activity.
- **Activity** is the run log, in the **Manage** group right after Workflows. Tabs
  choose the list: **All**, **Running**, **Needs attention**, **Failed**, and
  **History**; Running and Needs attention show how many runs they hold. A
  menu narrows the list to one workflow, and the search field finds runs by
  workflow name, work code, circle, or source. Each row shows the status, run
  number, trigger, and elapsed time. Selecting a row opens the run's details:
  start and finish times, duration, trigger, steps, candidates, run actions,
  and a collapsed **Diagnostic log** of run events. Wide screens show the
  details beside the list; elsewhere they replace it, and **Back to runs** or
  the header back button returns to the list. `/runs` links and earlier links
  to Activity inside Workflows open Activity and select the linked run.
- Activity lists every run, including those of features with their own pages:
  translations are followed on the [Translation](translation.md) page, and
  transcriptions in a work's **Manage lyrics → Transcribe**. A notification
  about such a run opens that page.

## Who Can Use Workflows

Workflows and Activity open for accounts with `workflows:run`: contributors and
administrators (see [Users](settings.md#users)). Every such account sees the
same definitions, presets, triggers, and runs, including runs other accounts
started, and can follow their status, events, and file progress. A run of a
custom definition stays visible only to the account that started it and to
administrators.

- Starting, configuring, or scheduling a workflow needs every permission its
  steps use: Track needs `remote:track`, Fetch and every Fetch-based bulk
  action need both `remote:fetch` and `metadata:sync`, scans, metadata
  workflows, and the ranking pulls need `metadata:sync`, and the source check
  needs `sources:write`. Contributors
  without `metadata:sync` can still see these operations, but cannot start or
  automate their Fetch paths.
- Editing, switching off, or deleting a trigger needs the same permissions as
  creating it.
- Availability Watch only monitors and always refreshes family metadata, so
  its source setting, watch pool, and checks require `metadata:sync`. Track
  and Fetch of a watched work are started by hand and check their own
  permissions: Track needs `remote:track`, and Fetch needs `remote:fetch` and
  `metadata:sync`, as a remote source's bulk Fetch does.
- A run can be cancelled or retried, and its items reviewed, by the account
  that started it, directly or as the owner of the trigger that fired it.
  Administrators can do so for every run. A retry needs the permissions that
  starting the same work requires.
- Items whose resolution removes, archives, or marks unavailable local files,
  such as a Fetch archive review, need `downloads:manage`. Recovering stale
  runs needs `sources:write`.

## Current Behavior

- **Fetch** starts from a work's [detail page](work-detail.md), including a
  work the library does not have, which Quick actions opens by its code. It
  runs manually and has no automation triggers.
- Local scan records folder discovery and local source presence without waiting
  for a metadata provider. Metadata sync, source availability, remote sync,
  cache, fetch, cleanup, circle refresh, and bulk remote actions record separate
  workflow runs.
- For one unambiguous local work, a scan marks old local file locations missing
  when the folder disappears or its stored paths no longer belong to the
  detected folder. It does not delete files or change Fetch ownership. A moved
  folder is indexed lazily when opened. A work whose code is found in several
  folders keeps all of them, and its detail page offers to tidy them up.
- Node runs expose step-level progress.
- Candidates expose reviewable outcomes.
- The header notification center shows **Updates** (your completed or failed
  workflow results, such as Fetch) and, for workflow operators, the runs that
  **Need attention**, with the newest running job above both. Fetch
  notifications open the local work detail and can be dismissed independently
  for the signed-in user; a translation that needs attention opens the
  Translation page's **Stopped** view, and a transcription its work;
  **Open Activity** opens the Activity page.
- **Pull remote source rankings**, **Pull DLsite rankings**, Availability
  Watch, and **Refresh subscriptions** are run and configured on the
  [Discover](discover.md) page, and Learn tag names runs on its own; Workflows
  lists none of them. Activity lists their runs, and its workflow menu narrows
  the list to one of them. The operations cannot be created, edited, or deleted
  from the page.
- Needs attention collects unresolved candidates, metadata issues, and
  unacknowledged failures. Resolving or dismissing recorded issues clears the
  corresponding dedicated metadata-run notice. Other failures can be marked
  reviewed once outstanding candidates and retryable metadata failures are
  resolved; a run whose remaining metadata issues are only products reported
  unavailable, such as delisted works, can be marked reviewed while those
  issues stay in Metadata. This acknowledgement is per user. History keeps the
  original outcome, including failed, partial, and cancelled runs.
- Metadata owns pending-work recovery and the DLsite proxy shortcut. Its
  metadata sync shortcut opens the options of **Sync work metadata** in
  Workflows.
- Built-in local scan and metadata sync support editable interval triggers;
  local scan also supports a Startup trigger. Local scan does not check remote
  availability or synchronize metadata. Manual, Startup, and interval scans expose a
  disabled-by-default `Follow-up run`; enabling it queues an independent
  metadata run after the scan finishes. Metadata sync has no Startup trigger,
  so it cannot compete with a scan follow-up.
- Local scan has one Startup trigger and one fixed folder watcher. On a new
  install both start off, and library setup offers to turn them on. The
  watcher can be paused,
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
  changes rely on the Startup scan.
- **Refresh local work files** sits second, after the local scan. It indexes the
  media files inside local work folders that a scan has already discovered, so
  opening a work does not index a large folder on demand. **Incremental** (the
  default) covers only folders whose files were never indexed; **Full**
  re-indexes every available local work. One run is queued or running at a
  time, and starting another returns the active run. It supports Startup and
  interval triggers that store the mode, and ships without a default trigger.
- **Check works on a source** asks one remote source whether library works
  exist there and records the answer on each work, as checking availability
  on a work does; it never adds works. It runs and is scheduled from the
  source in [Library](settings.md#library) settings, and Activity lists its
  runs. Each work is one lookup on the source. When more works match than
  one run checks, the ones this source has never checked come first, then the
  ones checked longest ago, so repeated runs cover the whole library. The run
  first checks the source's health, as **Check health** does, and stops
  without recording any work when the source is unavailable; it is partial
  when some lookups failed. One run per source is active at a time.
- An operation's options start with its **Run options** form. The form ends
  in a bar with `Run` and, when `Run` is unavailable, the reason, such as a
  missing required input. While a long form scrolls, the bar stays at the
  bottom of the screen, above the phone navigation and the player. Options
  apply to the next manual run only and reset when the options are closed.
  **Run** on the row uses the defaults: no follow-up run for the local scan,
  Incremental for local work files, and all works from DLsite with Missing or
  outdated for metadata sync.
- **All runs** opens Activity with only this operation's runs; choose
  **All workflows** in Activity's menu to show every workflow again. A run's
  steps and its log are in its details in Activity.
- Availability Watch, **Refresh subscriptions**, **Pull DLsite rankings**, and
  **Pull remote source rankings** are configured on the
  [Discover](discover.md) page, where the watch keeps its source setting
  and its pool is the **Watch** view, the subscription refresh
  its schedule, and
  each ranking its own pull schedule. Activity narrowed to one of them says
  where it is configured and links there.
- Sync a circle catalog, Sync a series catalog, and Sync a voice actor catalog
  are preset workflows that run on demand from their target:
  **Sync this circle's catalog…** in a circle's **More** menu, **Sync this
  series' catalog…** there while one of its series is shown, and **Sync this
  voice actor's catalog…** in a voice actor's **More** menu; see
  [Circles](circles.md) and [Voice actors](voices.md). Each opens its Run
  options in a dialog with the target filled in, and **Run** queues the sync,
  closes the dialog, and links to the run in Activity. The Run options have
  three sections:
  **Input** (the target and the catalog refresh, Incremental or Full),
  **Filter** (a release date range and a work limit), and **Actions** (Sync
  metadata, the tag template, and for circles Check remote sources).
  Circle and series targets accept up to 20 comma-separated IDs, whose catalogs
  are combined before filtering. The voice actor target is one picked voice
  actor; its catalog is refreshed on the checked remote sources with the
  display name and confirmed aliases. A series reads its stored works and has
  no catalog refresh.
  Sync metadata covers the catalog works that lack metadata, including works
  not yet in the library, and the filter and tag apply to those works. Every
  filter is off by default: without a release range or work limit, a run syncs
  every catalog work that lacks metadata. The tag template is also off by
  default; turn it on to tag the synced works. With Sync metadata off, a circle
  or voice actor catalog sync only refreshes the catalog (and checks sources).
  Catalog sync does not Track or Fetch; use a remote source's works, the
  Watch view in Discover, or a work's detail page for that.
- The catalog sync presets have no triggers. To follow new works on a schedule,
  subscribe to the circle, series, or voice actor instead; see
  [Discover](discover.md).
- Metadata sync refreshes works in the library; Selected works can also add
  works the library does not have yet. Its Run options choose
  **Works** (All works, one circle, one voice actor, or Selected works),
  **Metadata source** tabs, and **Refresh** (Missing or outdated, or All metadata).
  All works and Selected works default to DLsite and can select an enabled
  metadata-capable remote source. Circle shows only DLsite. Voice actor shows
  only remote sources and is unavailable until one is configured and enabled.
  Selected works accepts up to 100 codes separated by spaces, commas or
  newlines and defaults to All metadata. With DLsite, a code the library does
  not have adds that work and its language editions, and a code DLsite does not
  list counts as unavailable; a remote source refreshes only works already in
  the library. With DLsite selected, Run options also show the
  [remote metadata fallback](settings.md#remote-metadata-fallback) and
  [purchase bonus linking](settings.md#purchase-bonuses). These choices apply
  to this run, and retries keep them. Interval triggers store the same options
  for All works, a circle, or a voice actor; Selected works runs only on
  demand, and a trigger that still holds Selected works switches itself off
  when it fires.
  Remote refresh preserves manual edits and DLsite precedence; Missing or
  outdated checks metadata from the selected source. The source selector and
  fallback controls are hidden when no capable enabled remote is configured.
- Workflows are built in; users cannot author their own. Custom workflows
  preserved from an older installation are reviewed during library setup,
  where exact preset matches can become subscriptions of the reviewing
  administrator and others can be exported; see [Getting started](getting-started.md). Their earlier runs stay
  in Activity history.
- **Pull DLsite rankings** pulls every DLsite ranking that is due, in each of
  its orders, in one run, and **Pull remote source rankings** one remote
  source's popular list per run; see [Rankings](discover.md#rankings). Neither adds works to the library,
  syncs their metadata, tracks, fetches, or tags them. Popular collection runs
  that tagged, tracked, or fetched works stay readable in Activity and cannot
  be retried.
- A queued or running Fetch is unique per canonical work. Repeated Fetch
  requests reuse that run instead of downloading the same work twice, and every
  requesting user receives the shared run's terminal notification.
- Fetch Activity reports byte-level remote-transfer progress, the observed
  transfer rate, and the estimated time remaining. Unknown-size files stay
  explicit and suppress percentage and remaining-time presentation until their
  actual size is known.
- A Fetch run's detail lists its files. The file being downloaded stays at the
  top with its own progress bar, and the full list marks each file as done,
  waiting, or where the run failed or paused.
- Each Fetch run is named after its work, such as `Fetch RJ00000001`, and
  Activity search finds a Fetch by its work code. Fetches queued by a bulk
  action, including one started from the Watch view, record that origin as
  their trigger reason.
- Runs that act on one work, circle, series, voice actor, or remote source add
  it to their title, such as `Sync a circle catalog · RG00000000`, and Activity
  search finds them by it.
- A scan never marks works missing in a place it cannot see: an unmounted data
  folder or offline storage pool, folders deeper than the scan depth, folders
  it has no permission to read, and the recycle bins and snapshots that NAS
  systems and operating systems add. A scan of an unmounted standard library
  fails and changes nothing; a scan that skips an offline pool or an
  unreadable folder finishes as partial and names it.
- Scans, file lists, and folder watching skip the folders `@eaDir`, `#recycle`,
  `#snapshot`, `__MACOSX`, `.Trash-*`, `$RECYCLE.BIN`,
  `System Volume Information`, and `lost+found`, and the files `._*`,
  `.DS_Store`, and `Thumbs.db`. A work folder inside any of these folders is
  never found as a work. A work folder already recorded in a recycle bin,
  snapshot, `.Trash-*`, `$RECYCLE.BIN`, `System Volume Information`, or
  `lost+found` folder keeps its state. `@eaDir` and `__MACOSX` only hold
  metadata, never your files: a folder recorded inside one is not a folder of
  the work, its files are never added to the work, and the next scan that can
  see it marks it missing. Inside a work folder a scan reads, these folders
  and files are not files of the work, and the scan marks any that the library
  lists as missing.
- When FFprobe cannot read a media file, such as a damaged file, Kikoto records
  that for the file's current version and stops probing it in the background.
  A timeout or an interrupted probe records nothing, and a scan that sees the
  file change probes it again.
- Works on a disk that is not mounted stay in the library. Their cards show
  **Local · Offline**, and the work's local files say that the disk is not
  mounted. Until it is mounted again, their files cannot be played, downloaded,
  edited, or deleted, and **Manage files** shows such a folder as offline and takes
  nothing from it. Once the disk is back, the files are available again without
  a scan.

## Limits

- Retry and checkpoint recovery apply only to workflow families that explicitly
  declare their jobs recoverable; an arbitrary failed node cannot be resumed in
  isolation.
- Workers run inside the Kikoto process, so queued jobs make progress only while
  that process is running. Distributed or multi-instance execution is not
  supported.
- A normal service stop returns a running recoverable job to the queue without
  spending its retry budget. Recovery after a crash or forced kill is bounded
  by each job's retry budget. Manual stale-run recovery marks interrupted non-recoverable work failed for
  inspection.

## Related Docs

- [Architecture workflows](../../architecture/workflows.md)
- [Reliability](../../operations/reliability.md)
- [Testing](../../development/testing.md)
