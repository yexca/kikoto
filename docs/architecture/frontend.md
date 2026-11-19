# Frontend

The shell separates listening from managing. Each navigation destination
declares a group in `app/navigation`: `browse` pages (Library, Favorites,
Circles, Voice Actors) are the listening collections, `explore` pages (Record,
For you, Discover) are the listening destinations beyond them, `personal`
pages belong to the signed-in account, `manage` pages are administration, and
`app` pages (About) describe Kikoto itself. The desktop sidebar
(`app/AppSidebar`) lists the browse pages, then below a hairline the explore
pages; below another hairline, the collapsible groups that `navigationGroups` declares:
**Personal**, holding Insights, Tags, and Settings, and **Manage**, holding
Workflows, Metadata, Translation, Cleanup, and System; and below another
hairline the `app` pages. The sidebar renders a group from its declaration and the pages that
name it, so a new page joins a group by declaring it. Each group is collapsed
by default, remembers its expanded state in browser storage, and opens while
one of its pages is current; collapsed, it still marks the current page. An
account that can open none of a group's pages does not see the group. The icon
rail that the sidebar collapses to keeps the same structure.

On phones, the app header holds Notifications (when authenticated),
Appearance, and the account avatar, or Sign in for anonymous visitors. Wider
screens group Quick actions, Notifications, and Appearance in one header tray
before the avatar, which shows the display name on extra-wide screens but
never the role. Quick actions is always an icon button, never a search field,
so it is not confused with library search; its tooltip names the keyboard
shortcut. It opens the searchable Command Palette, a bottom sheet on phones
and a centered surface on desktop; Notifications, Appearance, and the account
panel are anchored popovers. Appearance (`app/ThemeTrigger`) is one palette
icon whose tooltip states the current mode, style, and color; its popover owns
only those three choices. Quick actions lists every destination the viewer can
open, in every group.

The account panel (`app/header/AccountPanel`) opens from the avatar, or from
Sign in for anonymous visitors, on every screen size. Where the sidebar is
shown, three shortcut tiles under the profile open Discover, Insights, and
Tags (`accountShortcutIds` in `app/navigation`); the sidebar keeps these
pages in their own groups, so the tiles repeat them. The sidebar itself offers
every page, About last below a divider, so the panel lists pages only below
the sidebar breakpoint. There one list under the profile holds, in order:
Quick actions on phones; the browse and explore pages the bottom navigation does not
carry, such as Discover and Record; the Personal pages; one **Manage** entry
that opens the Manage pages as a view of the panel and names the current page
while it is one of them; and About. The tiles do not appear below the
breakpoint, so no destination is listed twice. While a listed page or a tile is
current, its entry and the account trigger carry the selected state. **Language** opens a
view of its own inside the panel and shows its current value on the entry.
Sign-in or sign-out
ends the panel, and in the native shell it also holds the server connection
actions. A signed-in user also chooses the personal preferred metadata language
in the Language view:
**Origin** is shown when the user has no preference and choosing it clears the
stored preference, and a saved change refreshes the routed page through the
user preference event. Demo keeps the choice in browser storage scoped to the
server and Demo user, and the API client sends it with authenticated requests
(see [Metadata Language](data-model.md#metadata-language)). The
notification panel (`app/header/NotificationCenter`) splits personal workflow
notifications (**Updates**) from the global **Needs attention** runs for
workflow operators, shows the newest running job above both, and ends in an
**Open Workflows** button. Its badge counts unread notifications plus runs needing attention,
and a dot marks running work. It polls every 30 seconds, every 5 seconds while
open over a running job, and skips hidden documents.

`MobileSheet` is the shared bottom-sheet primitive. It animates in from the
bottom and out toward the bottom, supports Escape and outside dismissal, and
accepts a downward drag on its handle to close. A sheet's height stops below
the top safe-area inset with a strip of page left above it, so its handle stays
reachable and an outside tap can always dismiss it. Its default layer is
transparent so sheet content does not add a backdrop mask. The shared
`MobileSheetHeader` and `MobileSheetBody` keep command and catalog-options
sheets on the same bordered header and compact scrolling body treatment. Mobile
command and catalog-options sheets rely on sheet dismissal rather than an
in-content close icon; desktop command surfaces may retain an explicit close
action. Centered dialogs pad their backdrop by the safe-area insets and cap
their height to the space between them, so a tall dialog's header and close
action never sit under the status bar or notch.

The page alone pads for the system bars. Both native shells draw the WebView
under the status bar, and the `--safe-area-*` tokens give each surface the
inset to clear. The Android shell (`KikotoSystemInsets`) lays every Android
version out edge to edge, adds no native padding for a bar, and publishes the
bar sizes as `--native-safe-area-*` variables; each token takes the larger of
that variable and `env(safe-area-inset-*)`, so a WebView that reports the
insets itself still gets them once. With the keyboard open, the shell ends the
WebView above the keyboard and reports no bottom inset.

The header owns the desktop page title and carries no description, so page
content owns any additional context it needs. Mobile browsing destinations use
the bottom navigation as their location cue and show a compact Kikoto mark
instead; other destinations retain a single-line title.

The frontend is a React application focused on library browsing, work detail,
remote source management, and playback.

At startup, the authentication provider loads current-user and public runtime
settings before mounting the application shell or global player. A production
client without a user sees the full-page sign-in surface when anonymous access
is disabled; when it is enabled, the same client enters the read-only-capable
Library shell. Stored theme mode, style, and color are applied before React
renders, including on the sign-in and Demo surfaces.

Native server health checks omit both bearer credentials and cookies and reject
redirects. Switching the normalized server URL, including its base path, clears
the old credential in browser storage and native preferences before publishing
the new server configuration. Re-selecting the same server retains its session.

## Stack

- React.
- TypeScript.
- Vite.
- Tailwind CSS 4 with PostCSS and matching `tailwind-merge` utilities.
- Local shadcn-style primitives.
- lucide-react icons.

The web app and Android WebView require modern CSS support (Chrome 111+,
Safari 16.4+, or Firefox 128+), following the
[Tailwind browser requirements](https://tailwindcss.com/docs/compatibility).

Non-English translation resources and their surface labels live in separate
language modules loaded on demand. The English fallback must not synchronously
import a module that also owns deferred languages, or those languages enter the
initial bundle despite the dynamic resource entry points. Each deferred locale
module owns its own copy, and a unit test keeps other scripts out of the English
modules apart from the language picker's native labels.

## Code Organization

New and extracted frontend code follows a downward dependency direction:

```text
app and routes -> domain features -> shared application code -> UI primitives
```

- `app` and page shells compose navigation, providers, and domain surfaces.
- `features/<domain>` owns a cohesive business slice such as work detail,
  workflows, or maintenance. Sibling features should not deep-import each
  other's internals.
- `components`, reusable hooks, and `lib` hold application-wide behavior with no
  single domain owner.
- `components/ui` contains generic primitives and must not acquire work, source,
  or workflow knowledge.

This is an incremental extraction direction, not a request for a repository-wide
move. A domain earns its own feature boundary after it owns a real page or flow
and several mostly private components, models, or hooks. App composition or a
small shared contract should resolve cross-domain needs.

Work detail lives in `features/work-detail` and loads as its own chunk
through the feature's single lazy entry, `lazyWorkDetail`. It is a page of its
own rather than a Library route: the shell mounts one `WorkDetailPage`, which
loads the work the location names and renders it over the page the work was
opened from. That page stays mounted and hidden, so only one detail loads,
checks sources, or follows playback however many destinations have a work
open. The browse lists learn what a detail changed from `app/workDetailEvents`
(a changed listening status, a play, a changed set of works) instead of
sharing state with it. The app shell recognizes a direct work link with
`workDetailCodeFromLocation` from `app/workDetailNavigation` and starts the
detail chunk with the session request; an idle Library also preloads it, so
opening a work normally renders without suspending.

`WorkDetailLayout` composes the persisted and remote-only details from the
same parts: the Hero, the Directory, and the Source info panel. Each
controller hands it the Hero actions and the selected source's actions, which
Source info lists at every width. `heroPlaybackModel` decides the Hero's one
primary action from the shown directory, the folder routing rules, and the
saved playback cursor: Resume, Play for the folder the Directory opens on
(the tracks that folder queues when played from its first track), loading, or
the reason nothing can play. `WorkDetailActionBars` renders that action, the
quiet Mark, rating, and List controls, the Manage menu (the shared
`ActionMenu`), and the source action list. The List control on a work card
and on work detail is the shared `WorkCardListButton`; it names lists in the
order `workMemberLists` gives a work's lists, which follows the `memberOrder`
the server sets on each list holding the work. The controllers decide each management entry and source action
from the viewer's permissions and pass nothing for one the viewer may not use,
so those components never check permissions themselves.

Library, circle, voice actor, and work
detail surfaces load the remote Fetch workspace dialog on demand through
`LazyRemoteFetchWorkspaceDialog`, which mounts it only while a draft is open
and closes the draft with a toast if its chunk fails to load. The persisted
work detail's `folder-edit` feature owns the **Manage files** workspace of a
local folder and the Fetch into a new folder: `folderEditModel` derives the
resources, the request, and the final folder from the selection, the lyrics
role of each file, and the layout, `folderEditLayout` moves, places, and
numbers files and folders of the final folder as pure functions over that
layout, `fileWorkspaceModel` names what each place may do and derives
everything the edit deletes, `identicalFilesModel` relates the identical-file
check to the edited folder and suggests the copy each repeated set keeps,
`useIdenticalFiles` turns its review into selection changes,
`useFolderEditWorkspace` and `useFetchComposeWorkspace` load each resource's
files when a column or pane first shows it and the server preview,
`folderEditLyrics` suggests track assignments for added lyrics,
`FolderWorkspaceView` renders the columns from `FolderWorkspaceColumns` for
both `FolderEditDialog` and `FetchComposeDialog`, and for Manage files on a
workspace at least 1280 pixels wide `FileManagerPanes` instead, with
`FolderEditArrangeTree` as the draggable final folder and
`PendingDeletionPanel` as the deletions view. `FolderEditMergeConfirmDialog`
reviews a merge, and `useFolderEditWorkflow` follows the queued run and
reloads the detail. `usePersistedFileManagement` opens the workspace for a
manager of the selected local folder and `DirectoryManagerDialog`, a list of
files to delete, for a tracked source's cache and every other viewer. The production
build keeps React, i18next, and `tailwind-merge` in a separate `vendor` chunk
so a release that changes only app code leaves it cached; list only libraries
the entry already loads there, because everything in that chunk loads eagerly.

Explicit local Library routes restore their saved filters, sort and page before
starting the list read, while source configuration loads independently. Source
routes wait for configuration to identify their target. After work-code
resolution, summary and media-directory reads start together. The summary can
render first; a directory error preserves it. Edition redirects cancel the
speculative directory before loading the canonical work. Both reads preserve
principal-scoped media caching and reject cancelled or obsolete responses.

The production build stamps `public/sw.js` with a build id derived from the
version and the emitted file names. Each build therefore owns one service
worker cache, and activating a new worker deletes the previous build's cache
instead of keeping its hashed assets.

The API client lives in `lib`. `lib/apiTransport` owns the authenticated request
functions: base URL and asset URLs, credentials, session fencing, shared
in-flight reads, and error mapping. JSON and plain-text API reads share browser
cookie or native bearer authentication. Each domain module declares its response
types beside its requests: `accountApi`, `libraryApi`, `workApi`, `mediaApi`,
`metadataApi`, `creatorApi`, `remoteSourceApi`, `workflowApi`, `recordsApi`, and
`settingsApi`. A domain module imports the transport and, for types only, a
domain it builds on; none imports `lib/api`. `lib/api` composes the domain
modules into the single `api` object and re-exports their types, and is the
entry pages, features, and tests import.

`features/records` owns the Record surface, which `pages/RecordsPage` mounts
through the feature's `RecordsBrowser` entry, and its `RecordSettingsSection`
entry is the Record section of System → Library, which turns Record on and
initializes the independent record root. The navigation offers Record only
while the runtime settings report it on. `RecordsBrowser` browses the root one
folder at a time through `recordsApi`, ordering subfolders, videos, and photos
by natural name, and lists the folder's audio, subtitle, metadata, and other
files below them in `RecordFileList`, where audio rows open the player.
`recordsLocation` keeps the open folder and an open video (`?play=`) or photo
(`?photo=`) in the `/records` URL. Opening a folder or an overlay pushes a
history entry; previous or next inside an overlay replaces it; closing an
overlay the page opened goes back, and closing one opened from a pasted link
replaces it with its folder. Each entry carries the breadcrumb trail, and a
pasted folder link recovers the trail by walking from the root along a child's
relative path. The single-row header places the breadcrumb on the left and the
Continue watching picker and Scan (or Refresh without `library:write`) on the
right. Scan follows the queued run through the root's scan generation and
last-scanned time with bounded polling. Tiles show the server's thumbnails,
falling back to an icon for a video and to the full image for a photo, and the
folder's artwork images stay out of the photos. Group headings appear only when
a folder contains more than one kind of item. Saved progress arrives with the
folder listing; `useRecordProgress` overlays the positions the video player
and the global player save during the visit, the latter announced by
`RECORD_PROGRESS_SAVED_EVENT`, so tiles update without reading the folder again.
`RecordContinuePicker` lists the viewer's unfinished videos and audio files in
a popover on wide screens or a sheet on phones. It opens a video over its own
folder in a new entry (`openFolderVideoNavigation`), resuming without asking,
so closing it returns to the folder where it was opened; an audio file opens
its folder (`openContinueFolderNavigation`) and plays once that listing
arrives. The full-screen `RecordMediaPlayer` plays videos in the shared
full-screen video player layout described with the work video player below:
it asks whether to continue from a saved position, reads Record playback info
while it asks, plays the chosen source, and asks for a transcode after a direct
file or a remux fails to decode. It saves progress through
`RecordProgressTracker` every ten seconds, on pause, at the end, and when it
closes. A same-name subtitle sidecar the server serves as WebVTT is the video's sidecar
track for `useVideoSubtitleTracks`, a WebVTT file before a SubRip one, and
embedded text subtitles from playback info follow it. `RecordPhotoViewer`
steps through photos by button, arrow key, or touch swipe and shows each photo
in the shared `ZoomableImage`, the same zoomable stage as the work file viewer.
Both overlays are modal dialogs over authenticated asset routes; a record video
that starts playing pauses the global audio player through `usePlayer`, and
pauses when that player starts again.

Record audio plays in the global audio player. `recordPlayerTrack` turns a
Record asset into a `PlayerTrack` that carries `record` (the asset and its
folder), a negative location id apart from library locations, the `record`
location type, the folder's name as its subtitle, and the asset's thumbnail,
which for an audio file is its embedded cover art and otherwise absent, as its
cover. Selecting an audio row queues the folder's audio files; **Play as
audio** in the video player queues the folder's videos as sound from the
position the video reached and closes the overlay. Such a track has no work, so
listening history, lyrics, queue restoration, and display-name refresh skip it,
and the cover leads to its Record folder (`openPlayingRecordFolder`) instead of
a work.

The Record video player keeps its actions in a row under the stage: **Play as
audio** and an `ActionMenu`. For an account with `downloads:manage`, that
menu, one at the top of the photo viewer, one at the end of each
`RecordFileList` row, which is narrowed to a readable width, and one beside
each folder tile's name hold Delete. `RecordsBrowser` renders
`RecordDeleteDialog` for a file or a folder outside the overlay, so its keys
never reach the viewer, and `MediaOverlay` leaves Escape to a dialog opened
over it. The dialog is the shared two-step `DeleteReviewDialog` from
`components/delete-review`, which work detail's
`ConfirmMediaBatchDeleteDialog` also words; it shows only the path inside the
record root. Once the item is in the trash, the tracks of the files removed
leave the global player queue, an open viewer steps to the next sibling, or
the previous one, or closes, and the folder and Continue watching list load
again.

Navigation and browse state that pages and features share lives in `lib`:
circle and voice route helpers, Library browse state, and Library search
clauses. Work detail and the pages depend on those modules instead of on each
other, so no feature imports from `pages`. The circle and voice actor lists
render through one `pages/creator/CreatorListPage`, and the creator detail pages
and the Library remote source panel record remote Fetch and Fork runs through
`pages/useRemoteWorkActions`.

The circle and voice actor detail pages compose one summary and works toolbar
from `components/creator`: `CreatorDetailHeader` lays out the frameless
summary, `CatalogStatStrip` the one-line counts, `CreatorDetailActions` the
action row, the quiet Favorite control, the catalog refresh button, and the
More menu (the shared `ActionMenu`), `CatalogWorkToolbar` the search, order,
filter, and View row, `CreatorWorkViewMenu` the View popover or phone sheet
around the shared display options, and `CreatorWorkResults` the toolbar's
result caption. Each page decides the More entries, the refresh button, and
the sync and failed-source marks from the viewer's permissions and passes
nothing for one the viewer may not use, so those components never check
permissions themselves. The subscribe button takes the same quiet look.

The Workflows page (`pages/WorkflowsPage`, at `/workflows`) holds the
operation cards, the run lists, and the open run, and keeps the trigger
dialog's state. The operation model and cards (`features/workflows/operations`),
the trigger dialog and Next list (`features/workflows/triggers`), the run
lists (`features/workflows/runs`, described in
[Run Lists](workflows.md#run-lists)), run forms, run detail, candidate review,
the catalog sync dialog that the circle and voice actor pages compose
(`features/workflows/catalog-sync`), a remote source's library work check that
the System Libraries list composes (`features/workflows/source-presence`), and
the Availability Watch configuration
and pool that the Discover page composes live in `features/workflows`.
`features/workflows/workflowLinks` builds the addresses other pages use to
open Workflows or a run (`workflowsPath`, `workflowRunPath`), and
`features/workflows/useWorkflowsLocation` reads the open run, tab, and filters
from the address. The legacy `/activity`, `/runs`, and `/workflows?activity=1`
addresses redirect into Workflows (`legacyRunLogPath`).

The Discover page (`/discover`, rendered by `pages/SubscriptionsPage`) is
where to find what to listen to next. A `/subscriptions` address redirects to
it with its query, and `?view=for-you` redirects to the For you page. It
switches between three views, the release feed, Rankings (`?view=rankings`), and Watch
(`?view=watch`, for accounts that can run workflows; any other account sees
the release feed), as `SubNavTabs` along the top of the page with the page
toolbar at the end of the same row (below the tabs on a phone), and composes its
settings as a dialog of one fixed height on every tab, and as a sheet on
phones; closing the dialog returns focus to the settings icon. The page
toolbar always holds
the actions menu, the display options, and the settings icon, in that order.

The three views and For you compose the same card parts from shared code.
Their cards follow one display choice (`DISCOVER_LAYOUT_STORE` and
`discoverCardLayout`, in `components/work-collection/WorkCollectionLayout`),
kept apart from the Library's, offering every card mode and starting with
simple cards, in the shared work collection grid. Each card is a `WorkCardContextItem`: a
fixed-height `WorkCardContextStrip` above `LayoutWorkCard`, with the strip's
`WorkCardStatusBadge` and `WorkCardUnreadDot` as its status vocabulary
(`components/work-card/WorkCardContext`), and `WorkCardActionFooter` orders
the actions and saves a rating or Quick mark. `WorkSectionHeading`
(`components/work-collection`) heads the day groups, For you columns, Watch
groups, and the dropped-out list. Each view adapts its records to
`WorkCardViewModel` itself, so the feature folders do not import one another.

The release feed and Rankings offer the same actions on the works they show
(`components/work-collection/ShownWorksActions` and
`hooks/useShownWorksActions`): the page's actions menu syncs their metadata or
checks their sources, a status line in the view follows the queued run with a
link to it, the view reloads when the run ends, and the source check's answers
for codes without a work last for the visit. Rankings names the recorded
order the menu acts on to the page. The release feed draws each day's families
under a section heading.
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

Watch shows the Availability Watch pool: a summary with Add codes, whose
preview `parseWatchCodes` extracts from pasted codes, DLsite links, or mixed
text; a search, sort, and Select row; then the targets in the groups
`watchTargetGroup` assigns (available, in progress, waiting, failed checks,
already in library). A target need not be a work, so `watchTargetCardView`
gives the shared card only its code, title, and cover; the context line holds
its state and, for a started Track or Fetch, View run, and the footer keeps
the shared order with Track and Fetch (`WatchTrackFetchButtons`, also on New
releases' "Now available" cards), Check now, and Remove with its second-press
confirmation. Waiting and in-library targets fold to whole rows of the grid's
measured tracks unless a search is active. `useWatchTargetActions` holds
Track, Fetch, Check now, Remove, and Clean up for the page: the page's Actions
menu (`WatchPoolActionMenu`), the selection bar, the cards, and the family
dialog share it, and Fetch always passes through `WatchFetchConfirmDialog`,
which keeps the last extension exclusion in local storage. Selection reuses
`WorkSelectionBar`, whose actions count what each applies to.
`?target=<id>` opens a target's family dialog and `?dialog=ready` scrolls to
the available targets; with `&run=<id>` the page reads that run's newly
available codes and selects them. The page hands these to the view and
removes them from the address.
`?panel=watch` without a view names the Watch view, so a query the page writes
with the Availability Watch settings open always names its view.

The settings hold the subscription list with the refresh schedule, the ranking
settings, and the Availability Watch source setting, which they take from the
workflows feature. The Watch view and that setting read one
`useAvailabilityWatch` state, which loads when either is first shown and polls
while either is shown and the page is visible.
Each of the four Discover workflows (the two ranking pulls, the subscription
refresh, and Availability Watch) shows its latest run as one `LatestRunStatus`
line at the top of its panel: the run's state, when it ended, and a link to it
in Workflows. `useLatestRun` supplies it from the run list by workflow code,
which includes every trigger, reading again every 4 seconds while a run is
active and every 20 seconds otherwise, and merges it with the run the panel's
endpoint reports (`mergeLatestRun` keeps the higher run id), so a run just
requested shows before the list does. An account without `workflows:run` has
no run list: its line shows the endpoint's status and no link. The panels take
the permissions they need separately: `SubscriptionManager` enables the
schedule and **Refresh now** on `metadata:sync` alone, and the subscriptions on
`favorites:write`; Demo disables both. A manual run's notice carries the run
it queued (`useRankingQueuedNotice` for the ranking pulls).
`?panel=subscriptions`, `?panel=rankings`, or `?panel=watch` opens the
settings, and the settings button opens the tab of the current view. `?page=`
names the feed page. The feed, subscription list, schedule panel,
and the subscribe button that circle, series, and voice actor pages render
live in `features/subscriptions`; the Rankings view, its settings, and the
shared ranking state live in `features/rankings`; and the Watch view, the
watch configuration, and their shared state live in
`features/workflows/availability-watch`.

The For you page (`/for-you`, rendered by `pages/ForYouPage`, for accounts
with `library:read`) composes `features/for-you`, which holds the draws and
their reason sentences, with Discover's display choice; the display options
and the settings icon sit at the end of the temperature button's row. It shows its
three columns side by side on a wide screen with row cards, and one after
another with full, simple, or mini cards, and a labelled random sample in the
demo. Below the three-column width, tabs choose the one column shown and
replace its heading, with that column's shuffle button beside them. Its
settings are a dialog, a sheet on phones, of one scrolling panel: the
recommendation tuning of `features/preferences` (`?panel=tuning`) followed
by `RecommendationActivity`, which `?panel=activity` scrolls to.
`/settings?tab=recommendation` and
`/maintenance?tab=recommendation` redirect to `/for-you?panel=tuning`. The
page draws every column on the first open, after a temperature change, and
after saved user preferences, and one column, without the other columns'
works, on its shuffle button. Every draw records its works as shown, so the
settled draw is kept in server-and-user-scoped session storage, with memory
as the fallback, and opening For you again in the same tab shows it without
drawing; saved user preferences clear it.

The Favorites page keeps data loading, browse state, and history restoration.
The shelf list, shelf header, controls, card and list views, and list
management live in `features/favorites`. Followed circles and voice actors are
the Favorite filter of their own list pages. List icons come from a
shared catalog in `components/favorite-list`, so the work card's list menu and
Favorites draw the same icon for a stored key.

The Library page is the list's route controller: it keeps the active source
tab and scope and the browse controls with their history and storage
restoration. The rest lives in `pages/library`. `libraryRoutes` and
`libraryBrowseModel` are the pure route and browse-state models.
`useLocalLibraryWorks` and `useRemoteSourceWorks` load the local and remote
result pages for the controls they are given. `useLibraryRecommendations` owns
the recommendation session, the score badge preference, list telemetry, and the
explanation state. The toolbars, source tabs, search clause editor, local and
remote result panels, and work cards are components there. The two toolbars
hold the source switcher, the search field, and the controls the page hands
them: `LibrarySortButton` (the toolbar variant, with its reshuffle beside it),
`LibraryMarkFilter` on local and tracked works, `RecentlyPlayedPicker`, and
`LibraryViewMenu`. The wide source tabs (`LibraryPrimaryTabs`) lead with the
shared `SourceVisibilityPicker`; the phone source menu lists every source.
`LibraryViewMenu` is the View entry and its panel, a popover on wide layouts
and a sheet on phones: it composes the shared `WorkCollectionDisplayOptions`,
the recommendation score switch, and Select works on a remote source. The
sort button and the mark filter button each name their own setting, so no
other surface restates it. Each result panel shows its top page bar only when
the results span more than one page and `LibraryResultCount` otherwise. `WorkDetailPage`
uses the same folder's work-route helpers, and `useLibraryWorkDetail` loads
the work its route selects. The local and remote
loaders share one set of browse controls, so tab, search, sort, and page state
stay with the page instead of being divided between them.

Work detail metadata editing exposes its public entry from
`features/work-detail/metadata`. Its modal owns interaction and save actions,
suggestion hooks own asynchronous lookup, and a pure model maps editor state
to metadata overrides. Work detail and the Metadata page compose that entry
instead of owning its internals.

The global player keeps its public track and state types in `playerTypes` so
media-tree and queue models do not depend on the React provider. `playerPersistence`
owns browser preference access and queue parsing; it discards obsolete stored
queue and progress keys and reads the older sleep-timer shape.
`PlayerProvider` builds the player contexts from focused hooks: playback engine
and source loading, progress saving, recovery, sleep timer, queue actions and
storage, seeking, system media controls, and keyboard shortcuts. It uses
account-scoped storage keys and remains mounted across navigation. System media
controls (Media Session and the Android notification) stay registered and read
the latest actions through a ref, so they never act on a stale queue or mode.
`playerTrackAudioSource` picks each track's delivery: the original file, an
HLS playlist when the server converts the track and the browser plays HLS
(`audioHlsPlayback`), or a complete MP3 conversion otherwise. A Record track
uses its own stream or the audio profile of its Record HLS playlist, and the
file itself without HLS playback; its progress goes to the Record progress
route through `RecordTrackProgressSaver` instead of the playback report
scheduler, when the listener has `library:write`. Source loading
attaches an HLS playlist natively on iOS and iPadOS and through a lazily
loaded hls.js elsewhere (`audioHlsSource`); hls.js starts loading at the
pending start position, asks the element to play again once it has attached
its source, and reports fatal errors to playback recovery, which checks the
playlist URL rather than the element's `blob:` source. Source loading also
warms the next auto-advance track (`useNextTrackPreload`): a file or MP3
conversion in one detached audio element, so the player element can reuse the
buffered bytes for the identical URL, and an HLS playlist by requesting its
first segment; `nextTrackPreload` widens the window for an MP3 conversion.
The element volume is the product of the sleep timer's
fade and the loudness normalization cut (`applyElementVolume`).
`useLoudnessNormalization` measures the current track, then the next one, and
moves a level that changes mid-track gradually. In full normalization it routes
a same-origin element through a Web Audio gain node (`loudnessBoost`) only
while the page is visible and the element's context already runs; user
gestures and play requests start and resume that context, and until it runs
the element keeps its own output and the cut uses element volume. A routed
element cannot leave Web Audio, so while one may exist the provider renders
an empty standby `<audio>` element that each gesture prepares, and
`replaceAudioElement` moves the playback instance to it at the same position
and play intent. That happens when a routed element plays for a moment while
its context cannot run, and after leaving full normalization once the routed
element pauses or the next track starts. Element-bound effects depend on
`audioElementKey`, and media event handlers ignore a replaced element. The dock UI
lives in `player/dock`: `PlayerDock` owns the Mini, Compact, and full surfaces,
while queue reordering math and formatting stay in pure modules. Timed-lyrics
parsing lives in `lib/timedLyrics`, so the player and the work detail file
viewer read LRC, WebVTT, SRT, and ASS files the same way. `usePlayerLyrics`
moves parsed lines by the listener's lyrics offset, so the active line, line
seeking, and screen lyrics share one timeline.

The work detail file viewer (`FilePreviewDialog`) shows images and text, and
opens a video in `WorkVideoPlayer` (`features/work-detail/media`), which
steps through the folder's videos. It and Record's `RecordMediaPlayer` play
outside the global player with one layout: `MediaOverlay`
(`components/media-overlay`), the full-screen dark modal that Record's photo
viewer also uses; `VideoPlayerHeader` with close, the title and the item's
place in its list, previous and next, the caller's own actions (Record's audio
only, the work's audio track menu), and outside the phone layout
`VideoShortcutsButton`, which lists the shortcuts through
`VideoShortcutList` and `VIDEO_SHORTCUT_GUIDE`; `VideoPlayerStatus` for the
failure with Retry, the preparing spinner, and the question whether to
continue from a saved position; and `VideoStage` (`player/video`). The
overlay passes key presses to the stage, so its shortcuts work while focus
rests on the player. A video starts playing once its start is chosen, and on
the phone layout the stage requests fullscreen then, within the tap that
opened or started it, while `watchVideoFullscreenOrientation` turns a wide
video to landscape. The stage owns the `<video>` element, its controls,
shortcuts, subtitle tracks, playback rate, and fullscreen, and the source that
playback info chose, which it attaches through `attachPlaybackSource`: an HLS
playlist natively on iOS and iPadOS (`prefersNativeVideoHls`) and through a
lazily loaded hls.js elsewhere. It starts the first source at the caller's
start position and play state, and a failed, recovered, or changed source
starts the next one where the last stopped, in the same play state. It reports
why a source failed, so the caller can prepare a direct file or a remux again
as a transcode, and reports the positions the viewer reaches, so each caller
keeps its own resume store: `WorkVideoPlayer` in browser storage,
`RecordMediaPlayer` on the server. The video fits both dimensions of the space
the stage is given, with the caller's overlays over it. The `<video>` element
has no native controls;
`VideoControls` lays its own over it, reading the element through
`useVideoElementState` and keeping tap zones, double-tap streaks, the hide
rule, and seeking in the pure `videoControlsModel`. It reuses the player's
control primitives and seek steps through `player/mediaControls`. Keyboard
shortcuts, which `handleVideoStageKeyDown` applies on the stage, buttons, and
double taps all seek through `seekVideoTo`.
`videoFullscreen` makes the stage element fullscreen, so the controls stay,
except on iOS and iPadOS (`appleMobileWebKit`), whose fullscreen is the system
player; the stage leaves fullscreen when it unmounts. Its menus pass the stage
to `AnchoredPopover` as `container` while it is fullscreen, because a popover
in `document.body` is not shown over a fullscreen element. Subtitle menu
choices set each `<track>` element's `track.mode`. `useVideoSubtitleTracks` renders its `<track>`
elements: same-name WebVTT, SRT, ASS, and SSA files from the video's lyrics
matches (`sidecarSubtitleChoices`) load at once, with SRT and ASS rewritten as
WebVTT through `lib/timedLyrics`, and the embedded streams that playback info
lists follow, each fetched only once its track is selected. Every track loads
through the API transport as an object URL, so native shells need no subtitle
asset route. `videoSubtitles` labels the tracks and picks the one that shows
first. `videoResume` keeps resume
positions in account-scoped browser storage, keyed by location id and holding
only positions; the stage reports a position only after its start position
applies, so a still-loading element never replaces it.

## Major Surfaces

- Library.
- Work detail.
- Favorites.
- Circles.
- Voice actors.
- Settings (`/settings`): the signed-in account's own settings as one page of
  sections: Account, with the profile row (whose edit button opens the
  display-name and password dialog); time zone; Playback with the playback
  preferences after it; and **Your data**. The time zone section holds the
  account's time zone:
  automatic, which follows the device, or one of the IANA zones the browser
  knows plus the zone in use. **Your data** opens dialogs for personal JSON
  export and previewed import from a Kikoto or Kikoeru file, a Kikoeru account,
  or an open-source Kikoeru database.
- System (`/system`): the instance settings as `SubNavTabs` with an icon and
  a name: Library,
  Cache & Fetch, Proxy, ASR & LLM, and Users.
- Cleanup (`/cleanup`): Works, Cache, and Database as the same tabs, each
  shown to an account that may act on it: Works and Cache need
  `downloads:manage`, Database `sources:write`. A tab scans its caches or
  database the first time it opens. `pages/settingsLocation` keeps the open tab
  of these pages in the `tab` query parameter and scrolls to a section a link
  names.
- Settings and System, tabs included, are the content column of
  `components/ui/page-width` (`contentPageClassName`), which every page but
  the browse destinations shares; the page sets it, never a feature inside the
  page. A
  `SettingsSection` is a plain
  heading over a hairline followed by
  its fields as rows divided by hairlines. It has no card or border of its own
  and pages set sections apart with whitespace, so a field never sits in a
  container inside a container; only a repeated object such as a source, a
  proxy, a folder rule, or a user may be a card or table row. Section
  headings are plain text, and a switch or number field stays beside its label
  even on a phone.
  Fields save as the [design contract](../development/design.md) describes;
  `components/settings/AutosaveStatus` holds the section save state, and a
  typed number field reports a finished edit through `SettingsNumberInput`'s
  `onCommit`. Runtime settings save one change at a time and send only the
  changed fields.
- Tags (`/tags`): the account-owned work, circle, and voice tags, with rename,
  merge, and delete.
- Insights (`/insights`): the listening dashboard, composed by
  `pages/InsightsPage` from `features/listening-history`. The page opens
  with a year as a calendar, whose own year menu chooses the past year or a
  calendar year the report lists; a calendar year adds its highlights below
  it. A range switcher beside the summary heading (30 days, 12 months, all
  time) drives the report of totals, activity, ranked most listened works,
  weekly rhythm with listening by hour of day, a taste profile, and tags,
  voices, and circles ranked by preference or listening time, with the full
  per-work history collapsed until opened beside the clear action and the link
  to Your data. A monthly or yearly report reads its rhythm from the past
  year's calendar whatever year the calendar shows.
  The taste profile draws its preferred tags as an SVG radar with an
  equivalent list for assistive technology. Report requests name the device's time zone, and the foot of the page
  names the zone its days follow with a link to the Account setting. The calendar, the report, the profile, and the rankings load independently, so one
  failed request leaves the others on screen. The app shell composes each
  work, tag, voice, and circle link. Demo shows a notice above the dashboard
  that its listening history is simulated.
- Translation (`/translation`, `library:write`): `TranslationPage` composes
  `TranslationRunList` (`features/translation`) for running and queued
  Translate with AI runs by work and language, the shared
  `TranslationReviewList` (`components/translation`) for stopped items, the
  items translations wrote (history) and, while items wait for review, the
  review inbox, and the Metadata feature's `TranslationCoverage` for coverage
  and batch requests. `visibleTranslationCenterViews` shows `review` only
  while auto-accept is off or items wait; `?view=` selects `review`,
  `running`, `attention`, `history` or `coverage`, and
  `/metadata?view=translation` links redirect to coverage. The page polls
  while a run is queued or running, and offers cancellation according to each
  run's server-supplied `canCancel` flag through the dedicated translation
  cancellation endpoint described in [Run Lists](workflows.md#run-lists).
- Metadata: a Works group for DLsite works and Custom works,
  and an Entries group for Tags, Circles, and Voice actors. DLsite works holds
  the catalog and attention categories behind `WorkReasonFilter`, a
  `FloatingSelect` in the page header's toolbar whose options are the `reason` values `catalog`
  and `all`, so `?reason=` links select the tab and the filter together; `metadata`,
  `no_source`, and the run-scoped `?reason=metadata&metadataRun=<id>` select `all`. Each entry view owns a
  searchable table and management dialog. Tag and circle edits require
  `library:write`; voice aliases retain `metadata:sync`. The URLs
  `?view=custom`, `?view=tags`, `?view=circles`, and
  `?view=aliases&voice=<id>` select those views. `SubNavTabs` along the top of
  the page holds the views, a divider setting the Works group apart from the
  Entries group, and each tab's accessible description names its group. The row scrolls
  sideways on a phone and keeps the open tab in view, and the header below it
  holds the search without a view title, since the open tab names the view. The DLsite works and Custom works tabs and the filter
  options carry counts from `/api/maintenance/works/counts`, read as
  descriptions so the tab and filter names stay the labels; the page reloads
  them after the work table reports a change. `WorkMaintenance` keeps
  selection actions in the shared `WorkSelectionBar`, which replaces the upper
  pagination while works are selected, and opens `WorkInspector` for a
  pressed row from the loaded row alone: an `aside` beside the table from
  1280px, where the rows fold their status under the title, and a sheet
  below it. The row's inspect button is visually hidden until keyboard focus.
  The page has no settings control; `MetadataIssueDetails` links a failed
  DLsite update to System → Proxy for source managers. The Tags table is
  keyed and ordered by shared tag ID, so its rows never depend on a
  language setting. The ID cell carries the DLsite genre id and, only for a
  hidden or merged tag, its status; there is no separate status column. The
  Name column shows the interface language's name through
  `metadataTagNameIn`, muted when it falls back to another name, followed by
  Works, with the Manage column pinned to the right edge.

- Workflows: operation cards for Scan, Metadata, and Index above the run
  lists, with the run lists as `SubNavTabs` (Now and History), the workflow
  filter and search at the end of the row, and run details beside the list from
  1280px, also reachable through notifications. See
  [Run Lists](workflows.md#run-lists).
- Global player dock.

The work metadata editor freezes its initial normalized values and sends only
changed scalar fields. Selecting a cover alone does not create title, circle,
series, or voice overrides. Its separate tag section loads effective tags,
inherited DLsite tags, and the saved override draft. It searches shared
concepts, stages custom names and additions/removals, and can restore
DLsite tags. Exact names in any known language reuse an existing concept after
trimming and ignoring case. Custom names stay local until Save creates and
attaches them in the same request; Cancel leaves no shared entry. Only a changed
tag draft is saved. The tags render as a list under the add field, one row per
tag with its other names from `metadataTagAlternateNames`. A row's language
button opens `MetadataTagNamesPanel` inside that row, which loads the
shared tag once and edits its per-language manual names; Save patches renamed
shared tags before the membership request, and new tags send their language
names with it. A tag-section load failure
retains the other metadata fields. Demo shows these controls disabled.

Tag completion requests `resolveMerged=true`, collapses merged matches into
their final target, and retains source names for exact-match reuse. Management
lists still show the original entries for undo. A name resolving to a
hidden final target is labelled and disabled, with an explanation that it must
be unhidden in Metadata first. Creation conflicts returned by the server retain
the draft and show the same explanation. The tag manager explains the shared
locale precedence: language-specific manual name, all-language manual name,
provider name. This also governs default names and detail language switches.
Hide/merge/undo commit immediately and show the instance-wide remaining work
count while background projection runs. The tag list refresh action reads the
current count; the work list and player remain usable during repair.

`lib/metadataTagModel` holds draft comparison and language labels; the shared
suggestion hook owns cancellation and debounce. The maintenance tag and circle
dialogs keep transport separate from the work editor and preserve their loaded
state and drafts on request failure.

Personal tags are the Tags page at `/tags`. Settings opens at `/settings`;
`?tab=time-zone`, `?tab=playback`, and `?tab=data` scroll to the time zone,
Playback, and Your data sections, and `?tab=recommendation` redirects to
`/for-you?panel=tuning`. `/user-data` redirects to `/settings?tab=data`,
`/settings?tab=tags` to `/tags`, and `/history` and `/settings?tab=history`
to `/insights`. System opens Library at `/system` and its other tabs at
`?tab=cache`, `proxy`, `llm`, and `users`; `metadata` opens
Library, and `asr` and `services` open ASR & LLM. Cleanup opens its first
available tab at `/cleanup` and the others at `?tab=works`, `cache`, and
`database`. A `/settings` link that names a System tab, `/users`, and the
`/maintenance` tabs redirect to the matching System tab, Settings section, or For you settings, and
`/settings?tab=cleanup` and `/system?tab=cleanup` to `/cleanup`, keeping the
rest of the query.
Insights, Tags, For you, and the Your data section require `library:read`, and each
page loads its own chunk independently of the global player. System appears
only for administrators and Demo, and Cleanup for an account with
`downloads:manage` or `sources:write` and for Demo; Demo sees every tab of both
read-only.
The player records cumulative listening time under an account/server scope;
history clearing invalidates older reports using a server generation. Sleep
rewind preferences share that scope and update the resume cursor only when the
timer stops playback. Android and iOS output-disconnect events pause the media
element and player intent, including pending play requests. Every start of the
media element passes the engine's start guard; in the native apps,
`useSpeakerPlaybackGuard` holds starts through the device speaker until the
in-app confirmation, so notification, lock screen, Control Center, and media
key controls cannot bypass it. The device privacy settings (`lib/nativePrivacy`)
are one contract that both native shells implement through their
`KikotoPrivacy` plugin, and they live in native storage rather than
account-scoped browser storage, because the recent apps or app switcher cover,
the capture cover, the app lock, and the media notification apply them without
the web view. The plugin's status declares whether the shell offers the app
lock; only Android does. The app lock is native: it covers the window and authenticates through the system
biometric or device credential prompt, storing no secret of its own; the web
app only supplies its localized prompt labels. When the asset transport
session is removed or replaced, or the server changes, the Android shell
clears the WebView HTTP cache.

On Android 13 and later, the recent apps choice uses the task-preview API and
does not affect other capture paths. On Android 12 and earlier, it protects the
activity window with `FLAG_SECURE`, so it also blocks screenshots, screen
recording, and casting, including in split-screen and freeform windows. The
floating lyrics window follows `screenSecure` independently.

## Playback Reports

`ListeningClock` measures advancing wall time, independently of media position
and playback rate. Pause, waiting, seeking and ended stop its clock. A gap over
60 seconds, or a wall-clock discontinuity inconsistent with the monotonic clock,
is excluded rather than credited as device sleep. It partitions measured time
by the calendar date of the account's time zone, under one stable session id.
The zone arrives with the history generation from `GET /api/listening-sessions`:
a name is the zone the account fixed, `null` is the device's own zone, and a
response that names nothing counts UTC dates. A saved Account time zone
replaces it at once; a zone the runtime does not know counts UTC dates. For a server whose generation lookup
says it counts hours, each date also carries its listening per hour of the day.
A session rolls over after 86,400 measured seconds, 32
distinct dates, 48 distinct hours, or a changed zone. Midnight alone does not add a listen count;
the count belongs to the activation's first listening date.

`usePlaybackProgress` retains the applied-start and listener-intent guards for
the canonical work cursor. Events update local checkpoints; `timeupdate` never
sends HTTP. `PlaybackReportScheduler` is the sole sender and batches both models
in `POST /api/playback-reports` every 30 seconds during uninterrupted playback
(about two periodic writes per minute). Pause, end, seek and track change request
one coalesced event checkpoint. Hide/pagehide attempt a bounded keepalive batch.
There is one request in flight per scheduler; a newer event waits for it. Empty
and unchanged reports generate no write request. Navigation keeps this hook and
the media element mounted in the global player.

`playbackReportOutbox` uses atomic IndexedDB transactions keyed by normalized
server identity and account id. It merges session cumulative totals and retains
the latest work cursor. A cursor's order is `max(Date.now(), previousOrder+1)`,
persisted across reloads and shared between tabs, with a stable report id as the
tie-breaker. The server uses this order, including backward seeks, rather than
the largest media position. Across devices it uses occurrence wall clocks;
large clock skew can affect precedence. Legacy cursor writes establish a current
receipt-time order, so an older offline checkpoint cannot undo a later legacy
save. Browser storage contains no credential, title, source URL or file path.

Each scope retains at most 64 sessions and 32 work cursors, within 256 KiB.
Capacity never evicts an unconfirmed record: existing entries can merge while
new distinct entries are refused, with a sanitized console diagnostic. A batch
stays below 48 KiB for fetch keepalive. Accepted/stale acknowledgements remove
only the exact sent cursor or the acknowledged cumulative time; newer pending
data survives an older response.

Resume-cache events associate acknowledgements by `reportId`, reconcile the
unified owner with the submitted and played work identities, and learn the
whole batch's ownership before comparing confirmations. Recorded and stale
responses include persisted edition membership, so a previously unacknowledged
translation can still be recognized as belonging to the same unified work.
Only a newer, non-quarantined checkpoint of that work prevents an older cursor
event. A newer stale acknowledgement suppresses older recorded candidates for
that owner, regardless of response order. Unknown identities are never assumed
to belong to every work. Responses without the additive identity field still
use cursor and previously learned ownership, without guessing unseen relations.

Terminal item failures (`invalid`, `not_found`, `conflict`, or
`history_cleared` for progress) remain quarantined, count against the existing
capacity limits, and neither invalidate nor defer other cursor confirmations.
A new cursor observation can replace its quarantined
entry. Nonretryable HTTP failures quarantine the affected batch. Network errors,
408, 429, database busy and retryable server errors retain data and use persistent
exponential backoff from five seconds to five minutes, without an attempt-based
discard. Online events request a retry within that backoff.

Restoration verifies the server's history generation before replaying history.
A cached generation can measure offline, but its data is replayed only after
verification. A changed generation discards old intervals and opens a fresh
session; an in-flight pre-clear acknowledgement cannot establish its generation
again. Progress can still send when generation lookup fails. Identity changes
cancel in-flight transport and prevent staged writes from draining under new
credentials; the old scope remains available when its owner signs in again.

Local measurement and cursor persistence are sampled about once per second,
independent of the 30-second network cadence. With working browser storage,
crash loss is normally the last sample plus any uncommitted IndexedDB write;
unconfirmed earlier checkpoints recover on reload. Browser timer suspension,
storage eviction, a full queue, a first launch without a known generation, or
storage failure can lose more. If IndexedDB cannot open, reports continue in a
volatile queue with a diagnostic and a normal network loss window of up to
30 seconds. Browser keepalive is an attempt, not a delivery acknowledgement.

## Interaction Principles

- Render known local state first.
- Load slower source availability and remote trees separately.
- Keep source failures local to the affected source.
- Keep work-summary and directory states independent. A media-stage failure
  must not discard an already rendered detail shell.
- Prefer icons for compact controls and reserve text buttons for clear commands.
- Give secondary navigation one of two forms, both from `components/ui/sub-nav`:
  `SubNavTabs` along the top of a page for its views (Discover, Metadata,
  Workflows, Settings, and System), and a list beside the page for an
  open-ended set of destinations (the Favorites shelf list composes
  `SubNavColumn` and `subNavItemClassName` around its own entries). Tabs
  that all carry an icon show it beside the name; `SubNavTabs` measures the
  named row and, where the row is too narrow for it, folds the tabs to icons
  that name only the open one before it scrolls sideways. Both forms keep
  every destination's label as its accessible name, move and select with the
  arrow keys, Home, and End, and keep the open destination in view. They offer
  no options for their own placement or labels, and read no stored
  preference.
- Keep playback global so navigation does not interrupt the current queue.
- Keep high-frequency playback position out of bridge and notification rebuild
  paths. Browser time rendering is sampled, Android bridge updates are
  coalesced and periodically calibrated, and the Android build does not register
  a second browser Media Session. Native media controls exist only on Android;
  the iOS shell keeps the WebView Media Session. Screen lyrics use a native
  surface in both shells, chosen by registered capability
  (`lib/nativeLyricsOverlay`): the Android overlay, or on iOS an app-local
  Picture-in-Picture plugin that draws the current line into an
  `AVSampleBufferDisplayLayer`, because WKWebView reports no web
  Picture-in-Picture and rejects `requestPictureInPicture`. Both receive the
  timed track once plus playback corrections and advance lines on their own
  clock, so they stay in sync while the web view is in the background. The
  Picture-in-Picture window's play and pause go back to the web player rather
  than to a second media session. When the track length is known, the iOS
  window drives its layer timebase from the playback position, so the system
  shows progress and skip buttons; a skip moves the lines at once and reports
  the new absolute position to the web player's `seekTo`. iOS chooses the skip
  interval, and without a known length the window stays live with play and
  pause only. The Android overlay payload carries no duration. iOS composites Picture-in-Picture frames as
  opaque video, so the window cannot be transparent; it uses a wide 4:1 frame
  to cover less of the screen and draws a gradient from the active theme's
  background, foreground, and primary tokens, which the web side resolves to
  `#rrggbb` when it opens the window. Missing or malformed colors fall back to
  the dark default.
- Native shells attach the session credential to media and image requests on
  the configured server, limited to fixed cover, manual, media, and HLS routes.
  Android intercepts those WebView requests. WKWebView cannot intercept its own
  http(s) requests, so `assetURL` rewrites the same routes to the app-owned
  `kikoto-asset://asset` scheme on iOS, and the native handler re-validates
  each route and redirect hop before streaming from the configured origin.
- Native shells hold the bearer session in memory and in a native credential
  store, never in WebView storage (`lib/nativeSessionCredential`): the iOS
  Keychain with after-first-unlock, this-device-only access, or Android's
  private app preferences. iOS hydration moves a session found in app
  preferences into the Keychain, and removes a Keychain session when no server
  is configured, because Keychain items outlive app removal.
- The Android media notification redacts itself natively while the device is
  locked. The iOS lock screen and Control Center read the page's Media
  Session, which cannot tell a locked device, so on iOS the Media Session
  takes its text and artwork from `systemMediaDetails` with the device's
  media controls choice at all times. A browser Media Session shows
  everything.
- The iOS privacy plugin covers the scene with a blur window while it is
  inactive (the recent apps choice) and while its scene capture state is
  active (the screen capture choice). iOS cannot block a screenshot and gives
  no warning before one, so the window's root controller hosts the bridge
  inside the text canvas of a secure text field, the view the system leaves
  out of captures, and the screen capture choice switches that field's secure
  entry: a screenshot shows the root background in place of the page. The
  plugin's status declares whether the canvas exists; without it the choice
  only covers captures, and Settings names it accordingly.
  A capture that begins also closes the Picture-in-Picture lyrics window. The
  same plugin pauses page media when the audio route loses its output device,
  as Android does on `ACTION_AUDIO_BECOMING_NOISY`, and reports whether the
  device speaker is the output.
- Treat bottom navigation, safe areas, Compact player placement, page clearance,
  and update notices as one fixed-surface layout contract.
- Size mobile search and modal layers against the visual viewport. The frontend
  hides bottom navigation and player surfaces during text entry so focused
  controls and scrollable results remain visible without relying on Android
  activity resize behavior.
- Treat each mobile bottom-navigation destination as a resumable workspace.
  Switching destinations restores that destination's last stable list or detail
  route, history state, back stack, and scroll position for the current server
  and user; dialogs, pending mutations, and other transient overlays are not
  resumed.
- The native shells navigate like a tabbed app rather than a browser
  (`enableInAppBackStack` in `lib/browserHistory`). The WebView keeps a single
  history entry, and that entry's state carries an in-app back stack of bounded
  entries. A push stacks the entry it leaves and replaces the current one; a
  change of tab, scope, filter, or page within one browse list replaces the list
  entry without stacking it (`replacesWorkspaceList` in
  `app/workspaceNavigation`); a destination switch resumes the destination's own
  stack and is never a Back step; a push that opens a page of another browse
  workspace, such as a circle link in a Library work, starts that workspace
  with no stack and no return to the entry it leaves (`changesWorkspace`), so
  Back never restores another workspace's entry over its saved place.
  Returning to a stacked entry restores its state and scroll and dispatches
  `popstate`, so pages restore it the way they restore browser Back. Browsers
  keep browser history, whose Back button the app cannot remove.
- Retain every visited primary browse workspace (Library, Favorites, Circles,
  and Voice Actors) on both layouts so returning to a destination never reloads
  its rendered list. Each workspace has its own loading boundary, and the other
  route pages share one apart from them, so a route page that suspends never
  hides a retained workspace. The current location's page chunk starts loading
  with the app; the other workspaces, the command palette, and every route page
  the navigation offers load when the shell is idle (`app/routePageChunks`). A
  loaded chunk renders without suspending: React holds a shown Suspense fallback
  for at least 300ms, which would otherwise delay the page and the requests its
  effects start. An inactive workspace is hidden, cancels unfinished
  detail/list work, and pauses polling.
- A page owns its loading placeholder, because only the page knows its layout.
  The shell draws no placeholder shape while a page chunk loads; a slow chunk
  shows the shared refresh indicator. A page's first-data placeholder has the
  footprint of what it is about to show: a work collection uses its grid, card
  mode, and columns (`WorkCollectionLoadingState`), and a settings tab uses the
  shape of its sections. A fast answer replaces the blank directly
  (`useDeferredBusy`), and an empty result is shown only once the first page
  has answered.
- Retain a visited list when opening a detail route from it: a circle, a voice
  actor, or a work opened from any page. Detail URLs do not reinitialize list
  controls or fetch a replacement collection. Returning reveals the loaded
  cards and restores the originating history entry's filters and page before
  list effects may write or fetch.
- A work detail entry belongs to the page it was opened from. The work URL
  stays the canonical `/<primary_code>`; the history entry records its owner
  when it is created (`historyStateForNavigation` in `app/appRoutes`), a work
  opened from another work inherits that work's owner, and a direct link
  belongs to Library. The owner decides which navigation item is current, which
  list Back falls back to, and which destination resumes the entry.
- A queued track records the page it was queued from and, when that was a work
  detail, its location, because a track of another edition carries that
  edition's code rather than the work the listener opened. On the
  bottom-navigation layout the Full player's cover leads back there
  (`app/playingWorkNavigation`): the origin destination resumes its own entry
  when it still shows the work and otherwise opens the work as its own. In a
  browser Back returns to where the cover was tapped; with an in-app back
  stack the work starts its destination's stack, so Back goes up to that
  destination's list. On wide layouts, and for a track with no recorded
  origin, the work opens in the current page.
- Keep destination switches proportional to the workspaces that change. A
  workspace that stays hidden skips shell-driven renders, and browse list items
  are memoized with stable item handlers (`useStableCallback`) so a page render
  does not re-render unchanged cards.
- Browse workspaces share the window scroll position. When a retained workspace
  becomes active, the shell applies that history entry's scroll offset before the
  first paint; a resumed workspace does not replay its own stored list offset.
- Tapping the active destination from a detail route, including a work opened
  from it, returns to that workspace's last list state. Each destination
  resumes only the entries it owns, so a work opened from Favorites, Circles,
  or Voice Actors resumes under that destination and never replaces Library's
  saved destination.
- Distinguish native client-old, server-old, and network-disconnected states;
  version actions open signed GitHub Releases and never imply silent install.
  The client kind shown in the account panel, version messages, and copied
  diagnostics comes from the running shell (`Capacitor.getPlatform()`), so the
  iOS shell reports `ios` and Android keeps `android`. Every shell runs the same
  bundle version, so `minAndroidClientVersion` (falling back to
  `minClientVersion`) remains the shared minimum.
- Use the shared work-collection layout and work-card view model whenever a
  surface presents works. Page-specific filters and statistics may differ, but
  grid behavior and responsive column choices should remain aligned.
- Detail-page Back returns to the entry that opened the detail on both layouts,
  including Favorites and nested creator routes. A resumed mobile detail uses
  its captured return entry; a direct link falls back to its workspace list.
  With an in-app back stack, Back with nothing stacked replaces the detail with
  that return rather than adding an entry. Tapping the active bottom-navigation
  destination remains workspace Up, which pops the destination's back stack to
  its nearest list entry, or replaces the detail with the list and clears the
  stack when none is stacked.
- The Android back button and the iOS left-edge swipe share one back order
  (`app/nativeBack`): command palette, sign-in, the topmost dialog, sheet, or
  popover, the player's own panels and full view, then the in-app back stack.
  With nothing stacked, a detail goes up to its destination's list. At any other
  destination's root the Android button opens Library, and at the Library root
  it asks for a second press before leaving the app; the iOS swipe stops at a
  destination's root and never leaves it or the app. The swipe comes
  from an app-local native edge recognizer, offered only where that plugin is
  registered, and yields when it starts on the Compact or Mini player, a
  slider, or a horizontally scrollable region. While the Android WebView shows
  an element fullscreen, the back button leaves fullscreen before this order.
- A fullscreen video wider than it is tall locks the screen to landscape until
  fullscreen ends (`player/video/videoFullscreenOrientation`),
  however fullscreen was entered. Browsers use the Screen Orientation API, and
  a rejected lock leaves the screen as it is. The Android WebView rejects that
  API, so the shell shows WebView fullscreen itself, over the content frame and
  below the app lock cover with the system bars hidden, and its app-local
  `KikotoVideoFullscreen` plugin holds the landscape lock while that view is
  shown. iOS plays fullscreen video in the system player.
- Keep provider tags to two measured card rows with an overflow popover. Card
  summaries use Circle / Series, DL sales, segmented rating, known available
  alternate-language state, and a compact playback-history indicator when a
  persisted cursor exists.
- The simple card is the `simple` layout of `CompactWorkCardShell`
  (`components/work-card/CompactWorkCard`), which every surface with a card
  mode reaches through `workCardLayout`. Its details, including the footer a
  surface passes, mount on the card's first pointer or focus event, so a page
  of resting cards measures no tags and holds no action controls. The
  `.work-card-simple` rules in `styles.css` decide when mounted details show:
  on hover for a fine pointer, while a control inside the card reports
  `aria-expanded="true"`, or while the card sets `data-details-open`, which it
  does for its toggle and for keyboard focus inside it. Keyboard focus is card
  state because a control that a `:focus-visible` rule hides while focus moves
  cannot take the focus. A control that opens a popover from a card footer
  sets `aria-expanded`. A view model's `mark` puts the quick mark on
  the simple card's cover.
- Persist work-collection column settings as one shared browser preference,
  rather than separate page-local selections.
- Scope account-bearing browser state by the configured server identity and
  current user (or anonymous principal). This includes player queue/progress,
  Library and Favorites browse restoration, workflow selection, and in-memory
  work media. Pure display preferences such as theme and player Dock mode stay
  shared on the device. Demo mode may change those local display preferences
  even though server-backed account and administration state remains read-only.
- Keep the recommendation client-session id in server-and-user-scoped session
  storage. Navigation and reloads in one browser tab reuse it; a newly opened
  tab or native-app cold launch creates a new id and stable recommendation seed.
  Manual reshuffle changes the browse seed without replacing the session id.
- Pass the list's opaque `recommendationContext` with its session when opening
  an explanation. Query ordering adjustments appear only for an applicable
  context; ordinary badges and candidate-tail explanations still show actual
  frozen affinity. `recommendation_context_expired` (HTTP 410) retries the
  explanation with the original session and without the context, then omits
  ordering adjustments. Identity, generation, and other failures remain visible.
  Demo explanations label their score as randomly generated and omit preference
  contributions and ranking adjustments. Optional badge failure has an inline
  retry and preserves the cards. A failed recommendation-sort preparation keeps
  the last loaded cards alongside its retry state. The global player remains
  mounted throughout.
- A Library page, page-size, sort, filter, or search change returns to the start
  of the new results once they render. Compact layouts jump to the page top
  after any scroll still running from the user's gesture settles, because
  WebKit abandons a long programmatic smooth scroll when the list is replaced
  or touch momentum continues; desktop smoothly brings the results anchor into
  view. The shared `collectionResultsScroll` owns this rule.
- Keep scroll state per history entry and per in-app back stack entry. A push
  navigation starts at the top, while browser back/forward or an in-app Back
  restores the originating entry after its content has rendered. The shell observes content height for up to ten seconds
  for deep restoration and cancels all pending frames and observers on user
  scroll intent or navigation. Scroll writes belong to a unique history entry;
  delayed writes and page-level cleanup must not overwrite another entry's
  saved position, even when both entries share a URL.
- For collection-to-detail navigation, keep only shareable semantic filters in
  the URL. Store complete browse state plus selection/focus anchors in the
  originating history entry and use session state as a refresh/new-entry
  fallback. Continue to parse legacy explicit browse parameters.
- Reserve a directory-shaped skeleton with stable height while media is being
  indexed or loaded, then replace it in place without a separate loading card.
- Build Tree rows and playback queues from one folder-first natural ordering.
  Every list of file and folder names sorts with `naturalNameCompare`
  (`lib/naturalNameOrder.ts`), which compares digit runs by value and reads a
  kanji numeral after 第 as its number.
- Apply a persisted position only through Resume or the restored current queue
  item. After a reload, that item continues the work cursor when it still points
  at the same media item and is unfinished, unless the listener has already
  played or sought in it. Ordinary track selection starts at zero, while an
  active source fallback (only when the account enabled it) carries the current in-memory time, or a start position
  still waiting for metadata, to the replacement location.
- A playback instance writes the work cursor only after its start position is
  applied and the listener has played or sought in it. Page hide, pause, track
  switches, and the sleep timer must not replace the cursor with the position
  of an idle or still-loading element.

## Design and Semantic Contracts

- Consume semantic theme roles instead of hard-coded palette steps. Availability
  and feedback use success, warning, info, and error roles; destructive styling
  is reserved for destructive actions.
- Source color communicates health or availability, not source identity.
- Every reusable control defines hover, pressed, keyboard-focus, disabled,
  loading, and selected states as applicable. Touch actions keep a large target
  and never depend on hover feedback.
- Use surface and border changes for static hierarchy. Noticeable shadows belong
  to floating overlays and the player rather than every card.
- Accessible roles, names, and labels are the primary browser-test contract. An
  authored semantic marker may scope a complex app-owned surface, but utility
  classes and incidental DOM ancestry are not stable APIs.

## Failure Boundaries

The global player and app shell are continuity infrastructure. Route and domain
error boundaries should sit inside them so a render failure in Library,
Settings, or a remote panel does not stop playback or discard navigation.

Fallbacks must use sanitized copy and offer a relevant recovery action. Raw
stacks, upstream bodies, private endpoints, and local paths are diagnostic data,
not anonymous UI. A page that already has useful local data should keep it
visible while the failed remote or media stage renders an inline Retry state.

Shared API reads, including plain-text previews, belong to a server and session
generation. Account, session, credential, and server changes reject their old
results and errors, including response bodies still being decoded. Each caller
can cancel independently.
Writes fence reuse both when they start and when their response body settles;
progress and other personal writes leave current directory reads running.
A local-directory refresh or source untracking can interrupt that work's shared
read. A still-current caller waits for the write to settle and automatically
retries, at most twice, preserving the detail shell and global player. Session
changes, caller cancellation, and ordinary network or API failures do not
trigger this recovery. Background workflow completion uses the explicit refresh
paths; in-flight sharing does not cache settled responses.

Retained workflow run snapshots and event streams belong to the same session
generation. A session change clears the snapshots immediately, stops their
streams and polling, rejects pending run-settlement waits, and rebinds mounted
views to the current session. An authentication, permission, or not-found
response clears the run, events, and review candidates; a temporary failure
within the same session keeps the last known snapshot for retry.

## Multilingual title presentation

`WorkTitleEditor` lists per-language titles in a single column, then the
fallback row for the universal manual title, with independent drafts.
The declared original language carries an `origin` badge and the selected metadata
language a `current` badge; one row can carry both. The detail editor follows the
detail page's temporary selection, while Metadata uses the default variant.
An undeclared original language stays unmarked.
The fallback row's hint says that every language without a manual title of its
own shows it in place of the provider title, without changing the selected
edition or description.
A row's own manual title is editable text; provider and inherited values are grey
hints. `MetadataEditorField` keeps a field's status badge, the source of an
inherited value, and its Revert action on one label line. Source labels
distinguish scope-specific and universal manual titles.
`titleEditorModel` compares only touched scopes with
manual values so unchanged provider text never freezes. Clearing an owned
manual title, or its row's Revert, removes it on Save; clearing an inherited
hint changes nothing.

`WorkDescriptionEditor` is the Description tab. Like the titles, it lists a
row per language in the selected scope and a Fallback row for the universal
manual description. A language row starts from its manual description or the
introduction its title choice shows, and the Fallback row from the universal
description or the original introduction. `changedDescriptions` applies the
title draft rules: an unchanged or cleared inherited introduction stays out of
the PATCH, and clearing an owned description sends `null` for that language
in `descriptions`.

`WorkMetadataEditorModal` splits the editor into Title, Description, Cover,
Tags, Credits, Age rating, and Links tabs, each marked while it holds unsaved
changes. The footer keeps the caller's refresh control visible
and puts Fetch for edit and Translate with AI in the shared `ActionMenu`
overflow menu; Translate with AI closes the editor, opens
`TranslateWithAIDialog` from work detail, and stays unavailable while drafts
exist. The Title and Description tabs list accepted LLM values per language
with Revoke and their history with Restore (`LLMTranslationHistoryPanel`).

`TranslateWithAIDialog` (`features/work-detail/translation`) reads the
server's plan for the chosen languages, which counts what each category
lacks, and builds the lyrics request from the work's local tracks:
`translateWithAIModel` selects every missing track and language and reads
each track from its default source file; a track without lyrics links to
Manage lyrics → Transcribe. `LyricsTranslationMatrix` edits that selection. The dialog's Results tab reuses `TranslationReviewList`
with `LyricsPreview` for lyrics: items waiting for review when auto-accept is
off, then running, stopped and applied items. Every
change is a draft until Save: credit reverts become explicit `null` or empty
PATCH fields (`MetadataEditorReverts`), a cover revert deletes the cover
override, and a staged metadata link and purchase bonus link are written last,
so the refresh they queue reaches `onLinkChanged`. The Links tab holds
`MetadataEditorSourceSection` for the metadata link,
`MetadataEditorPurchaseBonusSection` for the parent of a purchase bonus, and
`MetadataEditorBundleSection` and `MetadataEditorFamilySection` for bundle and
edition-family membership. Work
detail renders the relation with `DetailPurchaseBonusLine`: Bonus for on a
bonus, and Bonuses on a work whose family has linked bonuses in the library. A failure after a partial save reloads the caller and
keeps the editor open. Cancel with drafts asks before discarding them. Credit
and tag inputs share `SuggestionCombobox`, an in-flow listbox with arrow-key and
Enter selection. The work detail's metadata-unavailable notice opens the editor
on its Links tab.

The metadata language label of an original edition whose language was never
declared reads only Original; other editions keep their language or the
unknown-language label.

`MetadataLanguageScopeTabs` is the language strip of the metadata editor's
Title, Description and Tags tabs, the only values saved per language, drawn with
the shared segmented control: All languages, a fixed tab for each language titles and tag names are saved in,
Fallback for the universal manual title and description and all-language tag names, and
a More tab whose menu lists the work's editions in other languages, including
an original edition with no declared language. Choosing one selects More and
names that language on the tab; the menu says so when the work has no such
edition. `metadataLanguageScope` builds the scopes and maps provider language
spellings onto the supported tokens, so an edition's raw language and a
metadata variant's language match the same scope. An original edition never
implies a language.

`WorkMetadataTagTable` shows the work's tags with a column per language and a
Fallback column for All languages, and only the selected column for one
language or Fallback; names come from `metadataTagNameIn` with unsaved name
drafts applied, and a name a language inherits is muted. A supported scope
shows its own title and description rows, and `MetadataTagNamesPanel` lists
only that language's name and the fallback name. The scope of another edition
shows its provider title and introduction read-only and the tags' fallback
names in one column. Tag membership, cover, credits, age rating, and links
remain work-wide.

Effective titles and descriptions arrive together in metadata variants. Detail
language selection updates both; descriptions render stored plain text verbatim
through React escaping, preserving brackets, ampersands and line breaks. Local,
remote-preview and resume queues take the current
display title while retaining their media identity and directory edition.
Existing global playback remains outside page boundaries. Cards and search
results use the same backend display policy; the frontend does not strip authored
titles or rewrite provider values.

## Remote metadata fallback presentation

Metadata sync and its trigger editor share Run options: scope, product codes,
metadata source, refresh mode, and DLsite-only fallback and bonus detection.
The source selector uses the public capability list and appears only with an
enabled metadata-capable remote source. The fallback starts off and offers
checkboxes plus earlier/later controls for this run's source order. Saving a
trigger stores all options; running sends them as run input without PATCHing
settings. Manual and DLsite precedence remain unchanged. The remote source dialog has a
Provides work metadata switch that writes the `metadata` capability;
`lib/remoteSourceCapabilities` holds the shared capability rule.

The work detail notice shows `remote_fallback` as an informational state that
names the filling source and, per source, which values it filled; a not-synced
work with remote values shows the same per-source lines. The title editor names
a remote title's source. Metadata issue rows say a DLsite-unavailable work was
filled by a named remote source instead of showing a bare unavailable status.
An edition with an unavailable outcome offers a dismiss action beside its
retry, and the selection bar dismisses the selected works' unavailable
editions. A DLsite issue also offers a fetch action per enabled source with
declared metadata capability, read through `hooks/useMetadataSyncSources`, and
the selection bar offers one per source for the retryable selection; Needs attention on Workflows offers **Mark reviewed** for a run once its pending
metadata has no retryable failure (`pendingFailedMetadata`).

The metadata editor's **Fetch for edit** action opens a three-column comparison
of current, fetched, and expected values. Choosing a fetched value keeps it as
provider metadata; changing the expected value records a manual override. The
preview is private, expires, and is rejected when the work changed while it
was open.

Tags offer an explicit merge action that preserves current concepts as manual
additions to the fetched provider set. A DLsite family has its own accept
action; the normal field save does not materialize sibling editions.

Learn tag names (`metadata_genre_names`) is a system workflow nobody starts
by hand: Workflows does not list it, and its runs, progress and failures
appear in the run lists.

## Related Docs

- [Frontend guidelines](../development/frontend-guidelines.md)
- [Testing](../development/testing.md)
- [Secure development](../development/security.md)
