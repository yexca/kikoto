# Run Lists

How the run lists present workflow runs, what needs attention, and the details of one run.

## Run Lists

The run lists under the Workflows page's cards are the run log: they list
every run as the administrators' diagnostic view; features with their own
pages show their runs there too. The Translation page reads Translate with
AI runs and items through `/api/translation/runs` and
`/api/translation/items`, open to accounts with `library:write` without
`workflows:run`, and a work's Manage lyrics lists its transcriptions. Items
take one or more `view` values (review, active, attention, history) and list
each view in the order given, so a work's Translate with AI dialog reads all
four in one request; `workId` narrows them to the work's family.
`POST /api/translation/batch` queues the coverage view's batch: the same
request without lyrics for each of at most 1,000 `workIds`, one run per work.
It returns each work's run and item count, or the code that refused it, such
as `nothing_to_translate`, and a refused work does not stop the others.
`POST /api/translation/runs/{id}/cancel` cancels a queued or running
`ai_translation` run under the [ownership rule](workflows-page.md#workflow-permissions).
Each returned translation run carries `canCancel`, which controls whether
the Translation page offers the action. Each language of a run carries its
`stage` (queued, translating, review, stopped, or done), the `done` items that
have settled out of its `total`, and the `count` the stage names, so the page
states a language's progress as the server worked it out from the item states.
Notification Center attention rows for a Translate with AI run open the
Translation page's Stopped view, and those for a transcription open its work.
Running (the active queue the cards read) sits above the tabs while it holds
a run and stays there on every tab. **Operations**, the default tab, holds the
cards and then Next, the triggers of every workflow; Running and Next each
show five entries and **Show all** the rest. **Needs attention**
(`?tab=attention`, `view=attention`) lists the runs waiting for a decision in
server pages of twenty, with an empty state, and its tab counts them. Next
lists only enabled triggers: interval triggers by their next run, then those
still waiting for one, then Startup, After, and folder triggers. A paused trigger is
left out, since it runs nothing; an operation's trigger dialog still lists it
for resuming. A ranking pull's dispatcher is always enabled and stores no
interval, since the ranking lists plan its `next_run_at`; Next treats a
schedule trigger without an interval as planned by the server, lists it only
while it has a next run, and shows that time in place of a condition. The operations' triggers carry a switch that pauses them and
an edit button that opens their operation's trigger dialog; another
workflow's triggers name the trigger and link to where it is configured: the
Discover panel of a ranking pull, Availability Watch, or the subscription
refresh, and System → Library for a source presence check. **History**
(`?tab=history`) lists the runs that ended and wait for nothing
(`view=history`) newest first in server pages of twenty; a status filter
narrows it to failed runs (`&status=failed`, `view=failed`), a workflow
filter to one workflow (`&workflow=<code>`), including the workflows that have
no card, and a search field matches the workflow name, the trigger reason, and
the run's subject (`&q=`). A workflow that the Discover page configures
states so above its runs and links there. A row of Needs attention or History
opens full run details (`?tab=<tab>&run=<id>`) beside its list from 1280px:
the details stay in view and scroll on their own, and Close, Escape, or
selecting the row again closes them and returns focus to the row. Choosing
another row replaces the open run, and another tab or History filter closes
it. Any other run takes the place of the running list and the tabs
(`?run=<id>`): a run opened from Running, a card's state, a notice, or a link
from another page, and every open run below 1280px, where the mobile layout
returns through the header back action. Opening a run is a history entry, so
Back returns to the list and filters it was opened from; a linked run returns
to the tab its address names. The header notification panel and Quick actions
open runs and lists here. `/runs`,
`/activity`, and `/workflows?activity=1` redirect here with their run;
their ended-run lists (`history`, `completed`, `logs`, `failed`) open
History with that list's workflow (`?runsOf=`, or `?workflow=` on
`/activity`), their `attention` list opens Needs attention, and their other
lists open Operations; an earlier `?tab=now` opens Operations. Events, candidates, progress,
retries, and cancellation are available within the run details.

The four workflows the Discover page configures (the DLsite and remote source
ranking pulls, Availability Watch, and the subscription refresh) have no row on
the Workflows page, so each Discover settings panel states the workflow's
latest run in one line: never run, queued or running, or how and when the run
ended, with a link to that run. Every run of the workflow counts,
whoever or whatever started it, so the Watch's line includes the checks a
subscription refresh queued. The line shows for every account that can open
the settings. The time and the link need `workflows:run`, which the workflow
status (`GET /api/workflow-status`, whose `latestRun` states the line) and the
run lists require; an account without it sees the run's status as the
settings endpoint reports it, without a time or link. A failed run is named
as failed with its link always visible. The line never repeats the run's error
text; the reason is in the run's details. A manual run from these settings
(**Refresh all**, **Pull now**, **Refresh now** on the Rankings view and in the
settings, and the Watch's checks) reports itself in a notice that opens the
run it queued, or the run lists when it queued several, such as a
DLsite pull and a remote source pull. Whether an account may start a run
follows the endpoint's own permission and nothing more: `metadata:sync` for
the subscription refresh and the ranking pulls; `workflows:run` with
`metadata:sync` for an Availability Watch check. Demo shows the lines and
starts nothing.

A run record's `subject` names the one target the run acts on, read from its
input: a work code for Fetch, Track, ASR, LLM translation, Translate with AI, folder edit, media
cache, local media delete, single-work metadata refresh, and a metadata sync
of one work; the circle code for a circle catalog sync or a circle-scoped
metadata sync; the series id for a series catalog sync; the voice actor's name
for a voice catalog sync or a voice-scoped metadata sync; and the remote
source's name for a source presence check, a remote ranking pull, or a
per-source cache cleanup. Runs over many targets have an empty subject. Run
titles append the subject to the workflow name, and History's search matches
it.

Running contains running and queued runs; Needs attention contains
terminal runs with unresolved candidates, pending metadata issues, or
unacknowledged failures. A dedicated metadata-sync failure with recorded issue
outcomes leaves attention when those issues are resolved. Unrecorded failures
require acknowledgement. The successful-attempt boundary prevents a later
failure from reopening an older resolved association. History contains
successful runs and runs that were cancelled or manually acknowledged, while
unresolved failures stay in Needs attention, which marks a run reviewed. Acknowledgements belong to the
viewer; they cannot dismiss an active run, an unresolved candidate, or a
retryable metadata failure. A run whose remaining metadata issues are all
not-found outcomes can be acknowledged, which removes it from that viewer's
Needs attention while the issues stay in the Metadata issue list. Run records
expose `pendingMetadata` and its retryable share, `pendingFailedMetadata`.
Demo keeps these actions read-only.
