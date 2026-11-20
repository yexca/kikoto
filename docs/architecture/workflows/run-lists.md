# Run Lists

How the run lists present workflow runs, what needs attention, and the details of one run.

## Run Lists

The run lists under the Workflows page's cards are the run log: they list
every run as the administrators' diagnostic view; features with their own
pages show their runs there too. The Translation page reads Translate with
AI runs and items through `/api/translation/runs` and
`/api/translation/items`, open to accounts with `library:write` without
`workflows:run`, and a work's Manage lyrics lists its transcriptions.
`POST /api/translation/runs/{id}/cancel` cancels a queued or running
`ai_translation` run under the [ownership rule](workflows-page.md#workflow-permissions).
Each returned translation run carries `canCancel`, which controls whether
the Translation page offers the action. Each language of a run carries its
`stage` (queued, translating, review, stopped, or done), the `done` items that
have settled out of its `total`, and the `count` the stage names, so the page
states a language's progress as the server worked it out from the item states.
Notification Center attention rows for a Translate with AI run open the
Translation page's Stopped view, and those for a transcription open its work.
Two tabs choose the list. **Now**, the default, shows from top to bottom the
Running part (the active queue the cards read), the Needs attention part
(`view=attention`), and Next, the triggers of every workflow. Running and
Needs attention show only while they hold a run; each part shows five entries
and **Show all** the rest, Needs attention a page of twenty at a time, and the
tab counts the runs of both. Next lists enabled interval triggers by their
next run, then those still waiting for one, then Startup and folder triggers,
and paused triggers last. The operations' triggers carry a switch that pauses
and resumes them and an edit button that opens the trigger dialog; another
workflow's triggers name the trigger and link to where it is configured: the
Discover panel of a ranking pull, Availability Watch, or the subscription
refresh, and System → Library for a source presence check. **History**
(`?tab=history`) lists the runs that ended and wait for nothing
(`view=history`) newest first in server pages of twenty; a status filter
narrows it to failed runs (`&status=failed`, `view=failed`), a workflow
filter to one workflow (`&workflow=<code>`), including the workflows that have
no card, and a search field matches the workflow name, the trigger reason, and
the run's subject (`&q=`). A workflow that the Discover page configures,
and the Record scan, which the Record page starts, state so above their runs
and link there. Rows open full run details
(`?run=<id>`) beside the list from 1280px and in place of it below, where the
mobile layout returns through the header back action; returning to the list
keeps its filters. Opening a run is a history entry. A card's state, the header
notification panel, and Quick actions open runs and lists here. `/runs`,
`/activity`, and `/workflows?activity=1` redirect here with their run;
their ended-run lists (`history`, `completed`, `logs`, `failed`) open
History with that list's workflow (`?runsOf=`, or `?workflow=` on
`/activity`), and their other lists open Now. Events, candidates, progress,
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
