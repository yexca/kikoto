# Rankings

Tracked ranking lists, their pull schedules, and how pulls are recorded and shown as history.

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
snapshot stays, and the list is `partial` when some of its variants failed.
The run is failed when it recorded no variant, and partial when it recorded
some but a variant failed or a list's next pull could not be written. Detailed
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
a later manual request remains due. A run that fails, or is interrupted by a
restart, before it takes its
lists consumes no request or due pull, and its target is dispatched again
five minutes after the failure. The dispatcher is
configured only through the lists: no page edits, pauses, or deletes its
trigger.

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
no schedule. The annual list of the year in progress follows the current year
(`follow_current_year`): on when it is added, it can be switched off until the
list is finished and on again only while its year is in progress. Its final
pull then adds the list of the year then in progress with the same settings
and variants and asks for its first pull. An earlier year added from the
settings is pulled once, finished at once, and
not followed by another year.
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

The database cleanup task for old ranking history and its automatic run
apply these tiers, then remove the entries that no kept snapshot of their
variant holds, so retained history keeps its titles and circles.

Demo serves fixed sample rankings with a short history in each order, built
from obviously synthetic names and reserved codes, and refuses every change.
