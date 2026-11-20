# Source Availability

How the backend checks whether remote sources offer library works, and how Availability Watch monitors them.

## Source Availability

Source availability is checked by the backend instead of frontend fan-out.
The local library scan does not check remote source availability. A remote
source that becomes usable, by being created enabled, switched on, or given
another API URL, queues one [source presence check](#source-presence-check)
with the default options and the trigger type `source_change`; renaming or
reordering an enabled source queues nothing, and a source that cannot answer
work checks is skipped.

A check reports a work `not_found` only when the source answered that it has no
such work: its lookup returned 404 and its listing, read in full, holds no such
code. A lookup answered 404 whose listing cannot be read, a timeout, or any
other failure is an `error`, whatever the error text says. Only an answer
changes the work's stored `source` presence: `available` or `missing`. An
`error` keeps the presence the source last reported and only advances when the
work was last asked, recording `unknown` for a work the source never answered
for.

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
[source availability](#source-availability) check does, and an answer is
recorded as that work's `source` presence (`available` or `missing`). A
failed lookup changes no stored presence. The run
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
stores the run options, its `sourceId` included, in its config. Each source
has at most one Startup and one interval trigger, in place of the one Startup
trigger per workflow that other workflows keep, and the workflow trigger API
answers 409 to a second one of a kind for the same source. No trigger is
seeded.

The check is configured on its source, not on the Workflows page. `GET
/api/file-sources` lists, for each remote source that answers work checks, a
`presenceCheck` with the source's latest run (id, status, when it ended or
started, and its checked and available counts), the soonest next run of its
enabled interval trigger, the `options` Run and its triggers share, and its
`startup` and `schedule` checks: whether each is on, the interval, and why a
switched-off one was paused. `PUT /api/file-sources/{id}/presence-check`
requires `workflows:run` and `sources:write` and replaces the options and
both checks of that source in one transaction, answering with the same
`presenceCheck`. A check switched on is created or updated, one switched off
keeps its stored trigger paused, and a later duplicate of a kind, from a
database that held several, is removed; until then the oldest supplies the
interval and options and any enabled one switches the kind on. Switching a
check on requires a source a run could check; saving options or switching
checks off does not. An interval check that stays on at the same interval
keeps its next run.

Source settings show the check's line under the source and read it again every
few seconds while a check is queued or running. The source's check dialog
keeps one set of options for Run and the automatic checks and saves every
change through that request, so a failed save changes nothing.
Disabling a source pauses its triggers like every other source dependency;
deleting a source deletes its source presence check triggers, which would have
nowhere left to show.

## Availability Watch

Availability Watch is one instance-level system workflow with a shared
monitoring pool, rather than one watch per user. It only monitors: a check
reports which watched works a remote source offers and never tracks or
fetches. Authorized users edit the pool of normalized work codes, and its one
setting selects a compatible remote source, or any healthy compatible
source. A change to that setting records the user whose permissions govern
the scheduled checks.

It has no trigger of its own. The [subscription refresh](catalog-refresh-and-subscriptions.md#creator-subscriptions)
queues it after each refresh while its Availability Watch option is on, using
the account that last configured the watch, and Check now on the Discover
page's Watch view queues it directly, for the whole pool or for listed
targets (`POST /api/availability-watch/run` with optional `targetIds`). The
settings hold the source. The run lists show its runs and link to that page.
Each execution snapshots the active targets it checks and records a normal
workflow run, node runs (pool, family metadata, availability check, available
works), and a durable job; only one check is queued or running at a time.
Before checking a waiting or failed target, the run synchronizes the code's
DLsite family metadata when it has not been refreshed within a day; a watched
code is an explicitly requested metadata root, so this may create its edition
works. A metadata failure marks only the metadata node partial and the check
uses the family already known; a code DLsite does not list is checked alone.
The target is available when a remote source offers any edition of its
family: the watched code first, then the other editions and provider-declared
edition codes, at most 32. The target records which source and edition was
found, and Track, Fetch, and opening the remote work use that edition. Remote
results never materialize new `work` rows, and an available target is not
checked again.

Because every check refreshes DLsite metadata, the source setting, target
edits, cleanup, and checks require `workflows:run` and `metadata:sync`. A check
the subscription refresh queues re-checks the configuring account's
permissions.

A successful check that finds new available works creates a notification for
every enabled account that holds `workflows:run`, which opens the Watch view
at its available targets with that run's newly available codes selected, and
adds each newly available work to those accounts' release feeds.

Track and Fetch of available targets are started by hand. `POST
/api/availability-watch/track` and `POST /api/availability-watch/fetch` take
at most 100 `targetIds`, and Fetch an `excludeExtensions` list. They need the
permissions of a bulk Track or Fetch (see
[Workflow Permissions](workflows-page.md#workflow-permissions)): `remote:track`, or
`remote:fetch` with `metadata:sync`. Each queues one `remote_bulk_action`
run per source for the listed targets that are available and have no run of
that action queued or running, acting on the edition each target found. In
the same transaction the targets reference the bulk run; when the bulk run
starts a target's Track or Fetch, the target references that run instead, and
a failure leaves the target on the bulk run with a reason. The view reports
each referenced run's status.

The Watch view groups targets by these rules: a target with a Track or Fetch
queued or running is in progress; otherwise one whose watched code or found
edition has local, cached, or tracked remote files is in the library (the
rule of a ranking's in-library works); otherwise one with a finished or
failed run is in progress; otherwise an available target is available, a
target whose last check failed has failed, and the rest wait.

`PUT /api/availability-watch/targets` replaces the pool;
`POST /api/availability-watch/targets` adds codes without deactivating
targets added by someone else; a code added again after removal starts over
with a new added time. `DELETE /api/availability-watch/targets/{id}` removes
one target and `POST /api/availability-watch/targets/remove` the listed ones.
`POST /api/availability-watch/targets/clean-up` removes, in one statement,
the listed targets that are in the library or whose Track or Fetch succeeded,
so a target that no longer qualifies stays; nothing removes targets on its
own. The view returns each target's title and cached cover (its own, or the
family original's), its known family editions with their titles and
languages, when it was added, its release date when known, whether it is in
the library, and the status of its Track and Fetch runs.
