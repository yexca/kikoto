# Workflows Page and Permissions

The Workflows page, its operation cards, and the capabilities that gate workflow actions.

## Workflows Page

The Workflows page (`/workflows`) holds the maintenance an administrator
starts by hand and every workflow's runs: Running, the active queue, on top
while it holds a run, then three tabs, Operations (the default), Needs
attention (`?tab=attention`), and History (`?tab=history`). A frontend-owned
table keyed by workflow code lists the operations on Operations as cards in
two sections: Library, with Scan (`local_library_scan`), Metadata
(`metadata_sync`), and Index (`local_media_index`), and, while the Record
library is on, Record, with Record scan (`record_library_scan`) and Media
details (`record_media_probe`). Work on one target starts where the target is shown:
Fetch from a work's detail, a catalog sync preset from its circle, series, or
voice actor (see [Catalog Sync Dialog](#catalog-sync-dialog)), and a source
presence check from its remote source (see
[Source Presence Check](source-availability.md#source-presence-check)). A workflow that another page
runs and configures (the DLsite and remote source ranking pulls, Availability
Watch, and the subscription refresh, all on the Discover page) and a system
workflow nobody starts by hand, such as Learn tag names, have no card; their
runs are in the page's run lists.

A card shows what the operation does, its state, what starts it on its own,
and Run. The state is one of never run, starting, queued, running with its
progress (finished jobs for a bulk run, otherwise the stage out of the
workflow's stages), or how and when the latest run ended. A run that still
waits for a candidate decision or a retryable metadata failure reads as
needing review. Every state that has a run opens that run, so a failure stays
on its card until a later run replaces it and leads to its details. The line
below lists its enabled triggers (at startup, after a scan, watching folders,
each interval schedule) with the soonest next scheduled run, says automatic runs are paused
when every trigger is off, and is absent for an operation that runs only by
hand. The
cards sit three across where the tab is at least 42rem wide (a container
query) and stack below. Operations never shares the page with a run: a run its
cards open takes the page until Back.

Run starts the operation without further options. Metadata and Index run
incrementally: metadata sync with scope `all`, mode `missing`, DLsite, and
the card's options; the file index with mode `incremental`. The Metadata
card's options button sets the remote metadata fallback (off by default, 1 to
16 enabled metadata-capable sources in order) and purchase bonus linking (on
by default). They are a per-device convenience in local storage, scoped to the
server; sources no longer enabled or metadata-capable drop out when the page
reads them, and a fallback left without a source is off. The card names
options that differ from the defaults, and Metadata's triggers run with them,
as the trigger dialog below describes. **Full** beside Run sends mode `full`
instead and turns off once the run is requested, so it applies to one run.
A manual scan always walks the complete data tree, so Scan has no Full and
requests no follow-up metadata run. The run control follows the uniqueness
the backend enforces. Starting it marks the card as starting at once, and the
card follows the run through queued and running. The local scan and the file
index are exclusive: a scan request while a complete scan is queued, or an
index request while an index run is queued or running, returns
that run, so their run control returns when the run ends. Metadata sync runs per scope, so its run
control returns as soon as the requested run is listed and another scope can
queue behind the active run. The card then follows the running run, ahead of a
queued one, and counts its other active runs; a request that queued behind
another active run of the operation says so with a link to the new run. A
repeat of the same metadata scope joins the active run on the backend.

The Record operations need `library:write`, as the Record page's Scan does,
and are exclusive. Record scan posts `/api/records/scans`; Media details
posts `/api/records/probes`, which queues a `manual` probe run, or returns the
probe run already queued or running. A new probe run reads every file still
pending, including those an earlier run timed out on. Neither has Full. Record
scan takes Startup and interval triggers; Media details takes an After
trigger, which follows a Record scan, and interval triggers.

`GET /api/workflow-status` states each card's status from every run the
viewer may see, so it holds however many runs are active. It takes the
workflow codes to answer for (`code`, repeatable; every system workflow when
none is named) and returns, per workflow, the `latestRun`, the `currentRun`
that states the card (the newest running run, else the newest queued run, else
the latest), `activeRuns` (queued plus running), `needsReview` (the current
run ended with a candidate decision or a retryable metadata failure waiting),
`nextRunAt` (the soonest next run among the enabled interval schedules), and
`stageCount`. It needs `workflows:run`. The page reads the status of its
cards together with the active queue that feeds Running, every few seconds
while work is active and every 15 seconds otherwise, and reloads the triggers
when the queue changes, so a run started by a trigger, at startup, or from
another browser shows on its card and, for an exclusive operation, holds its
run control the same way. Demo reads both once. A hidden tab skips the poll
and catches up when shown again.

Each card's trigger button, at the end of its name row, opens that
operation's triggers; the icon uses the primary color
while any of them is enabled. The dialog holds one switch for each kind of
[Automatic Triggers](built-in-workflows.md#automatic-triggers) the operation
takes, each named for when it runs: **At startup** for Scan and Record scan;
**After a scan adds works**, **After a scan finds new folders**, and **After a
Record scan finds new files** for Metadata, Index, and Media details; Scan's
fixed folder watcher, **When local library folders change**; and **On a
schedule** for every operation. A Next trigger's edit action opens the same
dialog. A viewer without the operation's permission (`metadata:sync` for a
Library operation, `library:write` for a Record operation) sees the icon's
state without opening it.

Every change saves at once. A switch turned on the first time creates its
trigger; after that the switch pauses and resumes it, so its interval and mode
stay. While on, a schedule shows its interval (1, 6, or 12 hours, 1 day, or 7
days, keeping a stored interval the list lacks), and a trigger that can run in
full shows **Incremental** and **Full**: the Metadata and Index schedules, and
the folder watcher, which stores it as `scanMode`. Each switch stands for the
operation's enabled trigger of its kind, else its oldest; another trigger of
the same kind, such as a second schedule created through the API, is listed
below the switches with its own switch and a delete button that deletes on a
second press and disarms after a few seconds or on Escape.

A new trigger stores the same options as Run: `{}` for the scan, Record scan,
and Media details, `{"mode": …}` for the file index (`incremental` for After),
and the metadata sync options above with the chosen mode (`missing` for
After). While Record is off, a Record trigger queues nothing and records why.
A change keeps every other option a trigger stores, such as a metadata sync's
scope or source, so a trigger created through the API keeps them. A Metadata
trigger that asks DLsite runs with the card's options: saving one from the
dialog stores them, and saving the card's options updates every such trigger
whose stored options differ.

Below the cards, Operations ends with Next, every workflow's enabled triggers; the
run lists are described in [Run Lists](run-lists.md#run-lists). The page's
address keeps the tab, History's filters, and the open run. Phones show the
same page; there is no landing view and no header back action outside a run.

### Catalog Sync Dialog

A circle's **More** menu offers its catalog sync preset, and, while one of its
series is shown, that series' preset; a voice actor's **More** menu offers
its own, and an unknown circle's fetch prompt opens the circle preset. Each
opens the preset's run options (Input, Filter, Actions, stacked) in a dialog
with the page's target filled in. **Run** posts the preset run, closes the
dialog, and confirms with a link to the run in Workflows for a viewer who can
open it. The dialog loads the preset definitions when it opens and says so
when they cannot be loaded. Demo opens it read-only. The preset queues every
request; the dialog closing after a run keeps one click to one run.

## Workflow Permissions

`workflows:run` opens the Workflows page; it is not an administrator
capability on its own. Contributors and administrators hold it (see
[Users](../../user/en/settings.md#users)). Every capability below is checked by
the backend.

- Visibility: every holder sees system-scoped definitions, presets, triggers,
  runs, events, candidates, and Fetch file lists. A run of a user-scoped
  definition, or of a custom definition that no longer exists, stays visible
  only to its owner or requester, and `system:admin`
  sees every run.
- Starting, configuring, and scheduling: a kind of run requires every
  permission its steps use. Track steps (a bulk Track, including one of
  watched works) require `remote:track`; Fetch steps (Fetch, a bulk Fetch,
  including one of watched works) require both `remote:fetch` and
  `metadata:sync`; scans, the local file index, metadata sync, presets, and
  the ranking pulls require `metadata:sync`, as do configuring rankings and
  requesting a pull; the Record scan and Record media details require
  `library:write`; the source presence check requires `sources:write`; tags
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
- Availability Watch: its source setting, targets, and checks require
  `metadata:sync`; Track and Fetch of its targets require the permissions of
  a bulk Track or Fetch.
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
  `downloads:manage`, plus `sources:write` when the cleanup forgets works, a
  folder edit, including one that merges folders,
  requires `downloads:manage` plus
  `remote:fetch` when it downloads, metadata jobs require `metadata:sync`, a
  speech transcription requires `library:write`, Translate with AI requires
  `library:write` and queues only the items the actor may translate, and graph jobs require their
  graph's permissions.
- Local files: candidate decisions, local cleanup, and archived-root review
  for candidates that remove, archive, or mark unavailable local files
  (`local_fetch_merge_cleanup`, `local_duplicate_work_folder`,
  `local_symlink_media_location`) require `downloads:manage`.
- Maintenance: stale-run recovery requires `sources:write`.
