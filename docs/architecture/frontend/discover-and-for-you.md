# Discover and For You

How Discover's release feed, Rankings, and Watch views and the For you page
present works, follow their workflows, and keep their state in the address.

## Discover

The Discover page (`/discover`) is where to find what to listen to next. A
`/subscriptions` address redirects to it with its query, and `?view=for-you`
redirects to the For you page. It switches between three views, the release
feed, Rankings (`?view=rankings`), and Watch (`?view=watch`, for accounts that
can run workflows; any other account sees the release feed), as tabs along the
top of the page with the page toolbar at the end of the same row (below the
tabs on a phone), and composes its settings as a dialog of one fixed height on
every tab, and as a sheet on phones; closing the dialog returns focus to the
settings icon. The page toolbar always holds the actions menu, the display
options, and the settings icon, in that order.

The feed, the subscription list, the schedule panel, and the subscribe button
that circle, series, and voice actor pages render live in
`features/subscriptions`; the Rankings view, its settings, and the shared
ranking state live in `features/rankings`; and the Watch view, the watch
configuration, and their shared state live in
`features/workflows/availability-watch`.

### Shared Cards

The three views and For you compose the same card parts from shared code.
Their cards follow one display choice, kept apart from the Library's, offering
every card mode and starting with simple cards, in the shared work collection
grid. Each card is a fixed-height context strip above the layout card, with
the shared status badge and unread dot as its status vocabulary
(`components/work-card/WorkCardContext`), and the shared action footer orders
the actions and saves a rating or Quick mark. The shared section heading heads
the day groups, For you columns, Watch groups, and the dropped-out list. Each
view adapts its records to the work card view model itself, so the feature
folders do not import one another.

The release feed and Rankings offer the same actions on the works they show
(`components/work-collection/ShownWorksActions`): the page's actions menu
syncs their metadata or checks their sources, a status line in the view
follows the queued run with a link to it, the view reloads when the run ends,
and the source check's answers for codes without a work last for the visit.
Rankings names the recorded order the menu acts on to the page. The release
feed draws each day's families under a section heading.

### Rankings

Rankings shows one tracked ranking (`?list=`) as cards beside their rank,
under a two-row toolbar that sticks below the app header. The first row holds
segmented controls grouped by provider, in the fixed order of the lists, with
the annual lists behind one segment and a year choice, and the History and
refresh icons. The second row holds the order, the
filters with their counts, including the entries a remote source has, and a
status button that opens the update times and the comparison choice; on phones
both rows scroll sideways and the status wraps below them. A 30-day switch and a popularity or sales choice pick
the shown order (`?release=30d`, `?sort=sale`); each choice pushes a history
entry, and the last choice on each segment is a per-device preference that
names the order when it opens. A segment's unseen mark follows the order it
shows. The latest order is compared with a baseline
(`?compare=previous`, a snapshot id, or a time; the last visit when absent).
`?at=` shows the order in effect at a time instead, compared with the update
before it, chosen in the History popover by day and that day's updates in the
account's time zone, with a banner under the toolbar leading back to the
latest order; it does not record the ranking as seen. A card's context line
states a stay or best rank only when they add something, and the cover's
source marks say whether the library has the work. Ranking and release cards
share an icon Watch action, styled like the list and Quick mark actions
beside it, that is lit for a code already in Availability Watch. A finished annual ranking shows its ranks without movement. The
ranking settings show one line per ranking with its Show switch, relative pull
times, and a schedule summary that expands the row in place to edit the
interval and depth, pull it alone, or delete it after a confirmation; earlier
annual years and the history retention each collapse into one line.
Below the shared line, one line per pulling workflow states its latest pull.

### Watch

Watch shows the Availability Watch pool: a summary with Add codes, whose
preview extracts codes from pasted codes, DLsite links, or mixed text; a
search, sort, and Select row; then the targets in groups (available, in
progress, waiting, failed checks, already in library). A target need not be a
work, so the shared card gets only its code, title, and cover; the context
line holds its state and, for a started Track or Fetch, View run, and the
footer keeps the shared order with Track and Fetch (the same buttons as New
releases' "Now available" cards), Check now, and Remove with its second-press
confirmation. Waiting and in-library targets fold to whole rows of the grid's
measured tracks unless a search is active. The page's Actions menu, the
selection bar, the cards, and the family dialog share one set of Track, Fetch,
Check now, Remove, and Clean up actions, and Fetch always passes through a
confirmation dialog that keeps the last extension exclusion in local storage.
Selection reuses the shared work selection bar, whose actions count what each
applies to.

`?target=<id>` opens a target's family dialog and `?dialog=ready` scrolls to
the available targets; with `&run=<id>` the page reads that run's newly
available codes and selects them. The page hands these to the view and
removes them from the address. `?panel=watch` without a view names the Watch
view, so a query the page writes with the Availability Watch settings open
always names its view.

### Discover Settings

The settings hold the subscription list with the refresh schedule, the ranking
settings, and the Availability Watch source setting, which they take from the
workflows feature. The Watch view and that setting read one Availability Watch
state, which loads when either is first shown and polls while either is shown
and the page is visible.

Each of the four Discover workflows (the two ranking pulls, the subscription
refresh, and Availability Watch) shows its latest run as one line at the top
of its panel: the run's state, when it ended, and a link to it in Workflows.
The line comes from the run list by workflow code, which includes every
trigger, read again every 4 seconds while a run is active and every 20 seconds
otherwise, merged with the run the panel's endpoint reports by keeping the
higher run id, so a run just requested shows before the list does. An account
without `workflows:run` has no run list: its line shows the endpoint's status
and no link. The panels take the permissions they need separately: the
subscription panel enables the schedule and **Refresh now** on `metadata:sync`
alone, and the subscriptions on `favorites:write`; Demo disables both. A
manual run's notice carries the run it queued.

`?panel=subscriptions`, `?panel=rankings`, or `?panel=watch` opens the
settings, and the settings button opens the tab of the current view. `?page=`
names the feed page.

## For You

The For you page (`/for-you`, for accounts with `library:read`) composes
`features/for-you`, which holds the draws and their reason sentences, with
Discover's display choice; the display options and the settings icon sit at
the end of the temperature's row. It shows its three columns side by
side on a wide screen with row cards, and one after another with full,
simple, or mini cards, and a labelled random sample in the demo. Below the
three-column width, tabs choose the one column shown and replace its heading,
with that column's shuffle button beside them. Its settings are a dialog, a
sheet on phones, of one scrolling panel: the recommendation tuning of
`features/preferences` (`?panel=tuning`) followed by the recommendation
activity, which `?panel=activity` scrolls to. `/settings?tab=recommendation`
and `/maintenance?tab=recommendation` redirect to `/for-you?panel=tuning`.

The page draws every column on the first open, after a temperature change, and
after saved user preferences, and one column, without the other columns'
works, on its shuffle button. Every draw records its works as shown, so the
settled draw is kept in server-and-user-scoped session storage, with memory
as the fallback, and opening For you again in the same tab shows it without
drawing; saved user preferences clear it.
