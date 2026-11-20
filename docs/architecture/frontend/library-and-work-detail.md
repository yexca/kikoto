# Library and Work Detail

How the Library page loads and arranges its results, and how work detail is
mounted, laid out, and opens its file workspaces.

## Library

Explicit local Library routes restore their saved filters, sort and page before
starting the list read, while source configuration loads independently. Source
routes wait for configuration to identify their target. After work-code
resolution, summary and media-directory reads start together. The summary can
render first; a directory error preserves it. Edition redirects cancel the
speculative directory before loading the canonical work. Both reads preserve
principal-scoped media caching and reject cancelled or obsolete responses.

The Library page is the list's route controller: it keeps the active source
tab and scope and the browse controls with their history and storage
restoration, and the rest lives in `pages/library`. The local and remote
loaders share that one set of browse controls, so tab, search, sort, and page
state stay with the page instead of being divided between them.

The two toolbars hold the source switcher, the search field, and the controls
the page hands them: the sort button with its reshuffle beside it, the mark
filter on local and tracked works, the recently played picker, and View. The
wide source tabs lead with the shared source visibility picker; the phone
source menu, which the phone toolbar renders with the result caption in the
app header title slot from `app/pageHeader`, lists every source. View is a popover on wide layouts and a sheet
on phones, holding the shared work collection display options, the
recommendation score switch, and Select works on a remote source. The sort
button and the mark filter button each name their own setting, so no other
surface restates it. Each result panel shows its top page bar only when the
results span more than one page and the result count otherwise.

## Work Detail

Work detail lives in `features/work-detail` and loads as its own chunk
through the feature's single lazy entry. It is a page of its own rather than a
Library route: the shell mounts one detail page, which loads the work the
location names and renders it over the page the work was opened from. That
page stays mounted and hidden, so only one detail loads, checks sources, or
follows playback however many destinations have a work open. The browse lists
learn what a detail changed from `app/workDetailEvents` (a changed listening
status, a play, a changed set of works) instead of sharing state with it. The
app shell recognizes a direct work link and starts the detail chunk with the
session request; an idle Library also preloads it, so opening a work normally
renders without suspending.

The persisted and remote-only details are composed from the same parts: the
Hero, the Directory, and the Source info panel, which lists the selected
source's actions at every width. The Hero's one primary action
(`heroPlaybackModel`) follows from the shown directory, the folder routing
rules, and the saved playback cursor: Resume, Play for the folder the
Directory opens on (the tracks that folder queues when played from its first
track), loading, or the reason nothing can play. Beside it sit the quiet Mark,
rating, and List controls and the Metadata button. The source action list ends
with the work's local files entries (Manage files, Manage lyrics, Edit display
names, Translate with AI) while a local source is selected. The List control
on a work card and on work detail is one shared control; it names lists in the
order the server's `memberOrder` sets on each list holding the work. The
detail controllers decide each management entry and source action from the
viewer's permissions and pass nothing for one the viewer may not use, so the
parts never check permissions themselves.

## Fetch and File Workspaces

Library, circle, voice actor, and work detail surfaces load the remote Fetch
workspace dialog on demand, mounting it only while a draft is open, and close
the draft with a toast if its chunk fails to load.

The persisted work detail's `folder-edit` feature owns the **Manage files**
workspace of a local folder and the Fetch into a new folder. Both render the
same columns; Manage files on a workspace at least 1280 pixels wide shows file
manager panes instead, with the final folder as a draggable tree and a
deletions view. Pure models over the layout derive the request and the final
folder, move, place, and number its files and folders, name what each place
may do, and derive everything the edit deletes. The identical-file check
suggests the copy each repeated set keeps, and its review becomes selection
changes. Each resource's files load when a column or pane first shows it. A
merge has its own review, and the detail reloads once the queued run ends.
Manage files opens this workspace for a manager of the selected local folder,
and a list of files to delete for a tracked source's cache and every other
viewer.
