# Workflows Page and Permissions

The Workflows page, its operation cards, and the capabilities that gate workflow actions.

## Workflows Page

The Workflows page (`/workflows`) holds the library maintenance an
administrator starts by hand and every workflow's runs. A frontend-owned table
keyed by workflow code lists the operations as three cards under Library:
Scan (`local_library_scan`), Metadata (`metadata_sync`), and Index
(`local_media_index`). Work on one target starts where the target is shown:
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
below lists its enabled triggers (at startup, watching folders, each interval
schedule) with the soonest next scheduled run, says automatic runs are paused
when every trigger is off, and is absent for an operation that runs only by
hand. The cards sit three across from 768px and stack below.

Run starts the operation without further options. Metadata and Index run
incrementally: metadata sync with scope `all`, mode `missing`, DLsite, and
the card's options; the file index with mode `incremental`. The Metadata
card's options button sets the remote metadata fallback (off by default, 1 to
16 enabled metadata-capable sources in order) and purchase bonus linking (on
by default). They are a per-device convenience in local storage, scoped to the
server; sources no longer enabled or metadata-capable drop out when the page
reads them, and a fallback left without a source is off. The card names
options that differ from the defaults, and new Metadata triggers start from
them. **Full** beside Run sends mode `full`
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
repeat of the same metadata scope joins the active run on the backend. The
page reads the active queue every few seconds while work is active and every
15 seconds otherwise, and reloads each operation's latest run and the triggers
when the queue changes, so a run started by a trigger, at startup, or from
another browser shows on its card and, for an exclusive operation, holds its
run control the same way. Demo reads both once. A hidden tab skips the poll
and catches up when shown again.

Each card's trigger button, at the end of its name row, opens that
operation's triggers; the icon uses the primary color while any of them is
enabled. The dialog lists the triggers with their switch and edit action and
offers **Add trigger**; an operation without triggers opens straight to the
add form, and a trigger edited from Next opens straight to its form. A form
returns to where it was opened from. A viewer without `metadata:sync` sees the
icon's state without opening it. A trigger takes Startup
or an interval of 1, 6, or 12 hours, 1 day, or 7 days, and Full. Metadata
sync offers only an interval, and an operation that already has a Startup
trigger cannot add another, as the backend enforces. A new trigger stores the
same options as Run: `{"followUpRun": false}` for the scan, `{"mode": …}`
for the file index, and the metadata sync options above, the card's options included, with the
chosen mode.
Editing a trigger changes its interval and Full and keeps every other option
it stores, such as a metadata sync's scope, source, or fallback, so a trigger
created through the API keeps them. The scan's fixed folder watcher edits only
Full, which it stores as `scanMode`, and cannot be deleted.

Below the cards, the run lists (see [Run Lists](run-lists.md#run-lists)) start on Now,
whose Next part lists every trigger. The page's address keeps the list, its
filters, and the open run. The Library heading folds the cards; they fold
while a run is open and open again when the run closes, and a choice made in
between holds until then. Phones show the same page; there is
no landing view and no header back action outside a run.

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
