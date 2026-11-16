# Unreleased

> [!NOTE]
> Record reads its library from a separate `/record` mount and is off until an
> administrator turns it on in **System → Library**. The bundled Compose files
> mount `./record`; add the same mount to a custom Compose file to use Record.

<details>
<summary><strong>Record</strong></summary>

- Record is a separate library for personal videos and photos in the
  sidebar. An administrator turns it on and initializes its root under
  **Record** in **System → Library**; it reads its own `/record` mount and
  never adds files to the audio Library or to a work.
- Record browses one folder at a time under a path bar that leads back to every
  parent, with **Continue watching** and **Scan** on the right, and the address
  keeps the open folder for Back, Forward, and reload. Items are ordered
  naturally by name, and **Continue watching** opens from any folder to resume
  videos you stopped part way through.
- Videos play in a full-screen player that steps through the folder, offers to
  continue where you stopped, saves the position per account, and pauses the
  global audio player. A `.vtt` or UTF-8 `.srt` file named like a video plays
  as its subtitles. Photos open full screen with arrow keys and swipes, and
  zoom like the work image viewer.
- A scan reads each video's length and size. Video tiles show a frame from the
  video and photos show small thumbnails, both made the first time a folder
  shows them; folder artwork images stay out of the photos.
- Record thumbnails are kept in the transcode cache and count against its
  limit in **System → Cache & Fetch**. The least recently viewed are removed
  first when the cache is full, **Clear transcode cache** in **Cleanup →
  Cache** removes them with the rest of the cache, and a complete Record scan
  removes the thumbnails of files that are gone. A removed thumbnail is made
  again the next time a folder shows it.
- Record scans are listed in Workflows as **Scan Record**, and History narrowed
  to them links to the Record page, where **Scan** starts them.

</details>

<details>
<summary><strong>Interface</strong></summary>

- The desktop sidebar shows the listening destinations and folds the rest
  into two groups: **Personal** holds Insights, Tags, and Settings, and
  **Manage** holds Workflows, Metadata, Translation, Cleanup, and System. A
  group stays collapsed until you open it, remembers that choice on the device,
  and opens on its own while one of its pages is shown.
- Settings holds only your own account, playback, and recommendation
  settings. The instance settings (Library, Cache & Fetch, Proxy, ASR & LLM,
  and Users) are the new **System** page for administrators, and cleanup is
  the new **Cleanup** page in the **Manage** group, with **Works**, **Cache**,
  and **Database** tabs. Existing links to those Settings tabs open them.
- Personal tags are a page of their own, **Tags** (`/tags`), instead of a
  Settings tab.
- **About** closes the sidebar below a divider. **Language** opens from the
  menu behind your avatar, which marks the page you are on. On a wide screen
  the menu also holds Discover, Insights, and Tags as shortcuts under your
  profile, repeating their sidebar entries; without the sidebar it lists the
  pages the bottom navigation does not carry, About included.
- The page header shows only the page title. Its tray keeps Quick actions,
  Notifications, and Appearance, and the avatar no longer shows your role
  beside it.
- Phones show Notifications, Appearance, and the avatar in the header. Quick
  actions, Discover, Record, the Personal pages, and a **Manage** entry for
  the administration pages open from the avatar menu.
- Secondary navigation has two forms. Discover, Metadata, Workflows, Settings,
  and System show their views as tabs along the top, Settings and System with
  an icon beside each name; Favorites lists its shelves by name beside the
  page. A tab row too narrow to name every tab shows icons and names only the
  open one. The options that moved Settings and
  Metadata tabs between a row and a column, that hid tab names in Settings,
  Favorites, and Workflows, and that collapsed the workflow list to icons are
  removed, and a choice already stored in the browser is ignored.
- Settings sections are a heading over a thin line followed by their fields,
  without a card around them. Sources, proxies, users, and other repeated
  items keep their rows.
- Pages use one of two widths. Library, Favorites, Record, Circles, Voice
  Actors, and Discover use the full width; the Personal and Manage pages and
  About share one centered column, with their tab rows spanning that column,
  instead of each picking its own width and alignment.
- Insights, Settings, Workflows, Metadata, Translation, and System drop the
  descriptions that restated a heading or a field's name. A description stays
  where it warns of a hard-to-undo or privacy-relevant effect, and an
  entry's allowed range shows when a value is rejected. Workflow cards show
  each operation's name, state, automatic starts, and **Run**.
- Insights filters its calendar and its report separately. The listening
  calendar chooses **Past year** or a calendar year from its own menu, and a
  calendar year shows its highlights below it; the 30 days, 12 months, and
  All time switcher sits beside **Listening summary** and sets the report and
  everything below it.
- Pages open without a generic loading placeholder: every page in the
  navigation loads ahead while the app is idle, and a page still loading its
  data shows placeholders in its own shape. The Library shows its card grid in
  the current card mode instead of an empty-library message before the first
  page arrives, and the Libraries settings tab shows its source cards.
- Appearance chooses Light, Dark, or System from a row of tabs instead of a
  menu.

</details>

<details>
<summary><strong>Discover</strong></summary>

- Discover offers **Simple** cards and starts with them: the cover, title,
  and credits, with the other facts and the actions on demand, as in the
  Library. A choice made before in **Display options** is kept.
- The line above a New releases card labels only an event that is more than a
  new release, and names a subscription only when the card's credit line
  does not already show it.
- For you's column headings and Watch's summary drop their descriptions; the
  temperature choices explain themselves in their tooltips.
- **Watch** on a card is an eye icon like the lists and Quick mark beside it,
  lit on a work already in the watch pool.
- **Subscription settings** open in a dialog, or a sheet on a phone, instead
  of a panel beside the view or a drawer.

</details>

<details>
<summary><strong>Workflows</strong></summary>

- **Workflows** is one page for the library maintenance you start by hand
  and every run. At the top, three cards: **Scan**, **Metadata**, and
  **Index** (refresh local work files), each with its state, what starts it
  on its own (such as at startup or every 6 hours, with the next scheduled
  run), and **Run**. Phones stack the cards, and the page no longer starts
  with a list to choose a workflow from.
- **Run** starts an operation at once, and the card shows the run. Metadata
  and Index run incrementally; **Full** beside Run refreshes every work's
  metadata or re-indexes every local work for that one run. Scan always
  checks every folder. Scan and Index cannot be started again until their run
  ends; Metadata can queue another scope while one runs, and the card counts
  the runs it is not showing. A run started by a schedule, at startup, or in
  another browser shows on its card the same way. A failure stays on the card
  and opens its run.
- **Add trigger** makes Scan, Metadata, or Index run at startup or every 1, 6,
  or 12 hours, 1 day, or 7 days, in full or not. The per-operation Options
  panel, its run forms, and the trigger editor's free interval in minutes are
  removed; a manual metadata sync runs every work from DLsite, and a trigger
  keeps the scope, source, and fallback it already stores.
- **Metadata options** on the Metadata card set the remote metadata fallback
  and purchase bonus linking for its runs and new Metadata triggers, saved in
  the browser.
- **Library** folds the cards away; it folds while a run is open.
- **Check works on a source** runs from each remote source in System →
  Library: the source shows its latest check and next scheduled one, and
  **Check library works…** runs it and turns its startup and interval checks
  on and off with one set of options. Deleting a source deletes its checks.
- Adding a source that is on, switching a source on, or changing its API URL
  queues one check of the library that Workflows shows as **Source change**,
  in place of an unrecorded background check after every source edit.
- Fetch is no longer on Workflows; it starts from a work's page, and Quick
  actions opens any work by its code. The catalog syncs open from their
  circle, series, or voice actor: **Sync this circle's catalog…**, **Sync
  this series' catalog…**, and **Sync this voice actor's catalog…** in
  **More** open the run options in a dialog with the target filled in, and
  an unknown circle's **Try fetching** opens the circle's.
- The status strip, the workflow list, the run duration chart, and the
  **Latest run** card with its stage list and streaming log are removed. A run's steps and log are in its
  details.
- The ranking pulls, Availability Watch, the subscription refresh, and Learn
  tag names are no longer listed; they are run from Discover or on their own,
  and Workflows keeps their runs.
- Each of those Discover workflows (the DLsite and remote source ranking
  pulls, the subscription refresh, and Availability Watch) shows its latest
  run in its settings: **Running**, **Succeeded**, or **Failed** with when it
  ended, opening that run. This shows to everyone who can open the
  settings, and the Watch's line includes checks a subscription refresh
  queued. The notice after **Refresh all**, **Pull now**, **Refresh now**, or
  a Watch check has a link to the run it queued.
- **Refresh now** for the subscription refresh needs only the permission to
  sync metadata, not the permission to change subscriptions.
- Below the cards, every run is in two lists. **Now** shows what is running,
  the runs that need attention, and **Next**, what every trigger runs next,
  where the operations' triggers are paused, edited, or deleted and another
  workflow's triggers link to where they are set up. **History** lists the
  runs that ended, narrows to failed runs or one workflow, and searches runs.
  A run opens on the page, and earlier Activity links open it there.

</details>

<details>
<summary><strong>Library and work detail</strong></summary>

- The work detail Hero leads with one primary action: **Resume** when the
  work has saved playback, otherwise **Play**, which plays the folder the
  Directory opens on. When nothing can play, its place says why instead of
  showing a disabled button. On a phone the actions sit right below the title,
  so Play is on the first screen.
- Mark, your rating, and List are quieter controls beside it, and List has no
  border in or out of a list. **Edit metadata**, **Manage files**, **Manage
  lyrics**, **Edit display names**, and **Translate with AI** move into one
  **Manage** menu. Source info lists the
  selected source's actions at every width.
- Management entries and source actions show only to users allowed to use
  them; a listener sees none.
- The stat strip and the Hero draw no frame of their own, the stat strip is
  only as wide as its figures, and the metadata language and edition chips
  show only when there is another choice.
- On wide screens the Directory leads the main column, with the
  description, Credits, and Source info beside it, in that order; the phone
  Info tab uses the same order.
- The List button on work detail and on work cards names the list the work
  was added to most recently, in place of the first in list order, with `+N`
  for the others.
- The Directory opens directly on its sources, without a heading, summary, or
  description line, and a folder has no **Play all**: opening its first track
  plays the whole folder. A folder whose first track is a video, which opens
  in the viewer, shows a quiet **Play folder** instead.
- Work cards have a new **Simple** mode, offered after **Full**: the cover,
  the title, and one line with the circle and voice actors, with source marks,
  listening progress, and your Quick mark as quiet status on the cover. The
  code, age rating, series, tags, rating and sales, price, recommendation
  score, and the action row appear when the pointer rests on a card or the
  card has keyboard focus; on a touch screen the arrow at the end of the
  credit line opens them. The Library and the circle and voice actor pages
  share the mode. **Full** stays the default.
- The Library toolbar keeps the sort button, a **Mark filter** button, and
  **Recently played** on both wide screens and phones, followed by one
  **View** button that holds the display options, the recommendation score
  switch, and **Select works** on a remote source; a phone opens it as a
  sheet. The Mark filter opens a list of marks and, while one is set, turns
  primary and shows that mark. On phones **Recently played** opens a sheet in
  place of the Continue listening strip, and the Mark filter opens its list
  in place of a row of chips.
- Library results that fit one page show their count without a page bar.
- A Favorites shelf opens with a one-line header, its name with the result
  count and page, in place of the cover mosaic, the listened share, and the
  top page bar. Search and the work controls sit beside it on a wide screen.
  The shelf list and the phone shelf row name the whole collection **All**.
- **Hide shelves** at the start of the Favorites header row hides the shelf
  list on a wide screen so the works fill the width, and this device remembers
  the choice.
- On phones the Quick mark chips stay below the controls, and search opens
  from an icon in the control row. The shelf row names the open shelf, so
  phones show no header line.
- One **Filters** button on Favorites holds the listening status, with each
  status's count, and the resource filter, in place of the row of status tabs
  and the separate resource button; **Clear filters** resets both. On phones
  it holds only the resource.
- The **Continue listening** strip on Favorites is removed.
- Marked is no longer a shelf of its own: the Filters status list starts with
  **Any mark**, which shows the same works on any shelf, and a link to the
  Marked list opens All Favorites with that filter. Edit lists no longer shows
  the fixed Marked row.
- Followed circles and voice actors leave Favorites: they are the **Favorite**
  view of the Circles and Voice Actors pages, and a link to the former
  Favorites creator shelves opens that view.
- A smart list's rule, new works, **Only new**, **Mark all as seen**, and
  **Edit rule** share one line under the shelf header. **Convert to regular
  list** moves into the list's editor.
- Circle and voice actor pages open with a compact summary like the work
  detail Hero: no frame, the catalog counts on one line (zero counts left
  out), and quiet **Favorite**, **Subscribe**, and **More** controls followed
  by the personal tags; wide layouts set those controls at the top right, so
  the summary stays about as tall as the portrait. Voice actor pages show the
  same counts as circles and no internal id.
- **More** menus keep their button's size while open, and opening one with a
  click no longer highlights its first entry.
- **First pull**, **Refresh**, and **Retry metadata** move into **More** and
  show only to users allowed to refresh a catalog. A catalog that was never
  pulled says so under the counts with a **Pull the full catalog** link for
  those users; sync state and failed sources show only to them.
- The circle and voice actor works toolbar is the search field, the order, the
  availability filter, and one **View** button holding the display options
  and **Select works**; on a phone the search field stays on show and **View**
  opens as a sheet. A caption before the order states the matching works and
  the page; only the bottom page bar turns pages.
- The image viewer zooms to any size up to eight times actual size with the
  mouse wheel, a trackpad or two-finger pinch, and the `+`, `-`, and `0`
  keys, keeping the point under the pointer or fingers in place. A click
  still switches between fit and actual size.
- **Cleanup → Works** holds **Local works by rating**, which lists your
  low-rated local works largest first and deletes their local folders in one
  run. It can also clear your rating and Quick mark of them and forget the
  works, and asks again before deleting works rated 3 stars or more.
- Deleting a work's local folder also removes the system files a NAS or
  operating system keeps beside its files, such as `Thumbs.db`, `.DS_Store`,
  and `@eaDir`, which used to keep the folder from being deleted.

</details>

<details>
<summary><strong>Operations and reliability</strong></summary>

- The Go toolchain is updated to 1.26.11, which fixes an HTTP/1 server crash
  caused by a race on request headers when a request body is size-limited
  (GO-2026-6859).

</details>
