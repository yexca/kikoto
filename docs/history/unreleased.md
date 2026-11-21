# Unreleased

> [!NOTE]
> Record reads its library from a separate `/record` mount and is off until an
> administrator turns it on in **System → Library**. The bundled Compose files
> mount `./record`; add the same mount to a custom Compose file to use Record.

> [!NOTE]
> Lyrics of a language and their track bindings come in only through **Lyrics
> files**. An **Edit files** run or a Fetch follow-up queued before the
> upgrade still adds its files, but a lyrics file a Fetch follow-up chose with
> a language is added at its own path, and the track bindings chosen with
> either are not stored. Activity names each such run; bind those lyrics again
> in **Lyrics files**.

> [!IMPORTANT]
> A folder whose name carries a work code inside another such folder, such as
> a bonus or disc folder named after its own product, is part of the outer
> folder's work. If your library has such nested folders, the first scan after
> the upgrade makes the outer folder the work: the inner folder's files are
> indexed as files of the outer work, and the work the inner folder held reads
> missing, keeping its metadata, marks, and progress. To keep the inner folder
> a work of its own, move it beside the outer folder before scanning.

<details>
<summary><strong>Record</strong></summary>

- Record is a separate library for personal videos, photos, and audio files
  in the sidebar. An administrator turns it on and initializes its root under
  **Record** in **System → Library**; it reads its own `/record` mount and
  never adds files to the audio Library or to a work. Initializing another
  disk mounted there starts the library afresh.
- Record browses one folder at a time under a path bar that leads back to every
  parent, with **Continue watching** and **Scan** on the right, and the address
  keeps the open folder for Back, Forward, and reload. Items are ordered
  naturally by name, the folder's other files are listed under **Files** with
  their type and size, and **Continue watching** opens
  from any folder to resume videos and audio files you stopped part way
  through.
- Videos play in the full-screen player that work videos use, which fits
  the screen, lists its shortcuts behind a keyboard button on a computer,
  switches to landscape fullscreen when a video starts on a phone, steps
  through the folder, offers to continue
  where you stopped, saves the position per account, and pauses the global
  audio player. A video the browser cannot play as it is, such as an MPEG-TS
  recording, is repackaged or converted like the Library's videos. A `.vtt` or
  UTF-8 `.srt` file named like a video, or a text subtitle inside it, plays as
  its subtitles. **Play as audio** at the top right of the video player
  continues its sound in the global audio player, and beside a video tile's
  name plays it from where you stopped. Photos open full screen with arrow keys
  and swipes, and zoom like the work image viewer.
- Audio files play in the global audio player with the folder's other audio
  files queued, continue where you stopped, and save their position like
  videos. The player shows a file's own cover art, or no picture without one,
  and its cover leads back to the Record folder. Record audio has no lyrics and
  stays out of listening history and the restored queue.
- A scan reads each video's and audio file's length and size, and whether an
  audio file carries cover art. Video tiles show a frame from the video, audio
  rows their cover art, and photos small thumbnails, all made the first time a
  folder shows them; folder artwork images stay out of the photos.
- Record thumbnails are kept in the transcode cache and count against its
  limit in **System → Cache & Fetch**. The least recently viewed are removed
  first when the cache is full, **Clear transcode cache** in **Cleanup →
  Cache** removes them with the rest of the cache, and a complete Record scan
  removes the thumbnails of files that are gone. A removed thumbnail is made
  again the next time a folder shows it.
- Record scans are listed in Workflows as **Scan Record**, and History narrowed
  to them links to the Record page, where **Scan** starts them.
- When the record directory is there but its marker is gone, Record keeps its
  library: it is browsed and played as usual, a scan adds new files without
  marking any missing, and nothing can be deleted. **Restore marker** under
  **Record** in **System → Library** brings the library back once the disk
  that holds it is mounted, and **Start a new catalog** starts afresh only
  after a confirmation. Another disk mounted there is offline and keeps the
  library until **Start a new catalog**.
- A Record position saved late, such as one sent after a later save, never
  replaces the later position, and a device whose clock runs ahead cannot hold
  a file's position.
- An account with file management access deletes a Record file or folder
  from a **More actions** menu, at the top right of the video player, in the
  photo viewer, on a row under **Files**, or beside a video's or folder's
  name, after a two-step review that names its path in the record root. It moves to
  `.kikoto-trash/records` in the record root, which Kikoto never empties, a
  folder with everything in it, and the progress, thumbnails, and playback
  cache of the files removed go with it.

</details>

<details>
<summary><strong>Interface</strong></summary>

- The desktop sidebar shows the listening destinations and folds the rest
  into two groups: **Personal** holds Insights, Tags, and Settings, and
  **Manage** holds Workflows, Metadata, Translation, Cleanup, and System. A
  group stays collapsed until you open it, remembers that choice on the device,
  and opens on its own while one of its pages is shown.
- Settings is one page of your own account and playback settings, without
  tabs: Account, Time zone, Playback, and Your data. Links to its former
  Playback tab open that section. The instance settings (Library, Cache & Fetch, Proxy, ASR & LLM,
  and Users) are the new **System** page for administrators, and cleanup is
  the new **Cleanup** page in the **Manage** group, with **Works**, **Cache**,
  and **Database** tabs. Existing links to those Settings tabs open them.
- Personal tags are a page of their own, **Tags** (`/tags`), instead of a
  Settings tab.
- **About** closes the sidebar below a divider. **Language** opens from the
  menu behind your avatar, which marks the page you are on. The menu holds
  For you, Discover, and Insights as one row of tiles under your profile and
  lists Tags and Settings, repeating their sidebar entries on a wide screen;
  without the sidebar it also lists the pages the bottom navigation does not
  carry, About included.
- The page header shows only the page title. Its tray keeps Quick actions,
  Notifications, and Appearance, and the avatar no longer shows your role
  beside it.
- Phones show Notifications and the avatar in the header. The avatar menu
  opens with a compact profile and the same row of tiles, then lists Quick
  actions, Tags, Settings, the other pages the bottom navigation does not
  carry, a
  **Manage** entry for the administration pages, **Appearance**, and
  **Language**, and closes with About and Sign out on one row. In the app, the
  server connection is one entry that opens its details.
- The bottom navigation on a phone shows icons only, each named for screen
  readers, and Record is its second tab while Record is turned on.
- Secondary navigation has two forms. Discover, Metadata, Workflows, and
  System show their views as tabs along the top, System with an icon beside
  each name; Favorites lists its shelves by name beside the
  page. A tab row too narrow to name every tab shows icons and names only the
  open one. The options that moved Settings and
  Metadata tabs between a row and a column, that hid tab names in Settings,
  Favorites, and Workflows, and that collapsed the workflow list to icons are
  removed, and a choice already stored in the browser is ignored.
- Settings sections are a heading over a thin line followed by their fields,
  without a card around them. On a wide screen the heading sits in a narrow
  column beside the fields, so Settings, System, and Cleanup no longer stretch
  each label and its control across the page. Sources, proxies, users, and
  other repeated items keep their rows.
- System's **Libraries** shows the local library as one card, with each
  storage pool as a row of it instead of a card of its own. The card opens one
  dialog for the library mode, pools, Fetch pool, **Scan depth**, and
  **Lyrics of the work folder**, saved together; the **Library storage**
  button and the separate **Local library** section are gone. **Add source**
  sits on the **Remote** heading.
- System drops descriptions that repeated a label or explained an ordinary
  control, and renames fields whose names needed one: **Mark Attention after
  no refresh for**, **Keep failed Fetch staging for**, and **Browse and play
  without an account**.
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
  menu, and drops its description line.
- Each Appearance style offers the accent colors its design source
  publishes beside Original: Anthropic adds the brand Blue and Green; OpenAI
  the Apps SDK Blue, Purple, and Orange; Apple the system Purple, Pink, and
  Orange; and Google MD Material 3 Green, Purple, and Orange. Apple's and
  Google MD's Original blue follow the same sources: Apple's current system
  blue with white text, and Google MD's Material 3 primary tones. The styles'
  colors replace the shared Graphite, Cobalt, and Iris palettes: a stored Iris
  becomes Purple, Cobalt becomes Blue where the style offers it, and Graphite
  returns to Original. Swatches show the color for the current light or dark
  mode.
- Metadata's **DLsite works** chooses **All** or **Needs attention** from a
  filter in the header beside search instead of a row of buttons above the
  list. **Metadata issues** and **No available source** are folded into
  **Needs attention**, whose rows name what each work needs, and links to
  them open it; works without a source are deleted from there. The filter
  shows each view's count, turns primary while it narrows the list, and on
  **All** marks works that need attention with a dot.
- Metadata work rows name only what a work needs under the title, in place
  of the **Metadata** and **Source** columns, and show nothing for a healthy
  work; the inspector keeps the complete states. Metadata's tables drop their
  card frame and shaded header, and their pagination shows only when a list
  has more than one page. Pressing a row opens the
  inspector, and its inspect button shows only on keyboard focus.
- The **Metadata settings** gear is removed. Its DLsite proxy switch and
  catalog freshness link are in **System**, where links to the settings open,
  and a failed DLsite update offers **Proxy settings** in its details.
- Metadata **Tags** shows one **Name** column in the interface language, muted
  when a tag has no name of its own in it, in place of a column per language
  and **Other names**; **Manage** holds every language's names.
- **About** opens with its one-line summary instead of a software overview.
  **Built with AI** shows the current models, with the earlier release
  ranges behind **Show history**; the technology credits name the main
  projects only; and ComfyUI is credited as a design reference for the
  workflow system. The sleeve adds **Report an issue**, and a button beside
  the version copies the client, server, and browser versions for a bug
  report.

</details>

<details>
<summary><strong>Discover</strong></summary>

- New releases uses a rolling 30-day release window and requires a valid
  release date, so late catalog discoveries do not promote old discounted
  works as new. DLsite catalog pulls select release order, read past known
  works on the same page, and exclude recommendations outside the result list.
- Discover offers **Simple** cards and starts with them: the cover, title,
  and credits, with the other facts and the actions on demand, as in the
  Library. A choice made before in **Display options** is kept.
- The line above a New releases card labels only an event that is more than a
  new release, and names a subscription only when the card's credit line
  does not already show it.
- **For you** is a page of its own in the sidebar instead of a Discover view,
  and links to the view open it. Its settings icon opens recommendation
  tuning and your recommendation activity, which leave Settings; links to the
  Settings Recommendations tab open them. Saving the tuning draws For you
  anew.
- For you's column headings and Watch's summary drop their descriptions. For
  you's temperature is a step from 1 to 5 instead of Safe, Balanced, and
  Adventurous, with the five steps in a row after its name. A saved
  Safe, Balanced, or Adventurous becomes 1, 3, or 5, which draw as before.
- For you drops the note shown before you have rated anything and the counts
  in its column headings, and **Draw again** is a shuffle button beside each
  heading. On a narrow window or a phone, the column tabs take the place of
  the column heading, with the shown column's shuffle button beside them.
  The tabs scroll sideways without a scrollbar when they do not fit.
- Each For you column draws about six works instead of ten.
- For you's settings are one wider panel without tabs: the tuning, followed by
  your recommendation activity.
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
- The calendar button on each card, lit while a trigger is on, lists that
  operation's triggers and adds one, so Scan, Metadata, or Index runs at
  startup or every 1, 6, or 12 hours, 1 day, or 7 days, in full or not. The
  per-operation Options
  panel, its run forms, and the trigger editor's free interval in minutes are
  removed; a manual metadata sync runs every work from DLsite, and a trigger
  keeps the scope, source, and fallback it already stores.
- **Metadata options** on the Metadata card set the remote metadata fallback
  and purchase bonus linking for its runs and new Metadata triggers, saved in
  the browser.
- **Library** folds the cards away; it folds while a run is open.
- **Check works on a source** runs from each remote source in System →
  Library: the source shows its latest check and next scheduled one, and
  **Check library works…** runs it and turns that source's own startup and
  interval checks on and off with one set of options. Deleting a source
  deletes its checks.
- Adding a source that is on, switching a source on, or changing its API URL
  queues one check of the library that Workflows shows as **Source change**,
  in place of an unrecorded background check after every source edit.
- Fetch is no longer on Workflows; it starts from a work's page, and Quick
  actions opens any work by its code. The catalog syncs open from their
  circle, series, or voice actor: **Sync catalog…** and **Sync series
  catalog…** in **More** open the run options in a dialog with the target
  filled in, and
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
- One bad interval trigger no longer holds back the others: it waits five
  minutes, and an occurrence a stop interrupted stays due. A run cancelled
  before its job finishes stays cancelled, except a Fetch that has started
  publishing, which finishes; a retried preset run keeps the
  steps that already finished, and an administrator can retry any preset run.
  A second complete scan request returns the one already queued, the run
  event stream sends a run's last events before it closes, and a ranking pull
  that fails before it starts keeps your **Pull now** request and retries in
  five minutes. A queued run of a workflow step that no longer exists fails at
  startup.
- A Fetch or Track that succeeds on retry notifies you again, even after you
  dismissed its failure.
- A file deletion or cache cleanup whose request ends before it finishes, as
  when the page closes, returns to the queue and runs in the background.

</details>

<details>
<summary><strong>Library and work detail</strong></summary>

- The work detail Hero leads with one primary action: **Resume** when the
  work has saved playback, otherwise **Play**, which plays the folder the
  Directory opens on. When nothing can play, its place says why instead of
  showing a disabled button. On a phone the actions sit right below the title,
  so Play is on the first screen.
- Mark, your rating, and List are quieter controls beside it, followed by
  **Metadata**, and List has no border in or out of a list. Source info lists
  the selected source's actions at every width, and for the local source
  **Manage files**, **Manage lyrics**, **Edit display names**, and **Translate
  with AI** after them.
- Source info is headed by the source's name and lists its playable, file,
  and size counts on one line. It shows the source's status only when the
  source is not available, leaves the duration to the stat strip, and marks a
  size measured from only some files as approximate.
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
- **Manage files**, **Manage lyrics**, and **Display names** open without a
  description under their title. The metadata editor's Cover and Links
  sections open on their fields, and its other sections keep one sentence on
  what an edit changes. The editor, **Manage lyrics**, and **Display names**
  show a footer status only while there are unsaved changes, and in **Manage
  files** only This folder keeps a line under its name; the other places'
  Copy, Merge, and Read-only marks say what their files do.
- Lyrics of a language come in only through **Manage lyrics** → **Lyrics
  files**. **Manage files** and the Fetch into a new folder add a lyrics file
  from another place like any other file, at its own path, and no longer offer
  a language under its name, **Selected lyrics files**, or **Assign added
  lyrics to matching tracks**. The note in **Manage files** that counts the
  folder's other lyrics files still opens **Lyrics files** on them.
- **Assign added lyrics to matching tracks** pairs the files when the edit
  applies and never replaces lyrics a track already has in that language,
  including lyrics another manager assigned while the edit was open.
- The folder edit and Fetch follow-up requests no longer take a lyrics
  `language` on an addition or `assignments`, and the folder edit plan no
  longer counts `lyrics`; a request that still sends them adds the file at its
  own path. A file that keeps its path inside another folder's
  `lyrics_kikoto`, as a merge copies it, goes only into a lyrics folder Kikoto
  created and marked.
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
- The sort control in the Library, Favorites, and the circle and voice actor
  works names the order and opens a narrow menu of the orders alone. The
  button beside it flips the direction, or reshuffles Random and refreshes
  Recommended, so the menu no longer repeats the reshuffle. Recommended always
  lists the best match first. Changing the Library order, its direction, or
  reshuffling no longer scrolls the page to the results.
- Library results that fit one page show their count without a page bar.
- The Library and Favorites sort by **Your rating**: works you rated by
  their stars, equal ratings by the public rating, and unrated works last.
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
- A smart list's rule, its new-works count, which toggles **Only new**, and
  icon buttons for **Mark all as seen** and **Edit rule** share one line under
  the shelf header that fits a phone screen. **Convert to regular list** moves
  into the list's editor.
- On a phone, a smart list with new works further along the shelf row no
  longer widens Favorites, which pushed the bottom navigation below the screen
  and could hide it while searching.
- On a phone, Library, Circles, Voice Actors, and the works of a circle or
  voice actor open search from a **Search** icon, as Favorites does, so the
  search field no longer takes a row of its own. The field stays open while it
  holds a search, and closing it clears the search.
- On a phone, Library moves its source button and the result count and page
  into the header beside the app icon, so the order,
  **Mark filter**, **Search**, **Recently played**, and **View** share one
  toolbar row.
- Circle and voice actor pages open with a compact summary like the work
  detail Hero: no frame, the catalog counts on one line above the name after
  a circle's code (zero counts left out, and a circle's size left to its
  **Works** tab), the personal tags under the name, and quiet **Favorite**,
  **Subscribe**, refresh, and **More** controls; wide layouts set those
  controls at the top right, so the summary stays about as tall as the
  portrait. Voice actor pages show the same counts as circles and no
  internal id.
- **More** menus keep their button's size while open, and opening one with a
  click no longer highlights its first entry.
- One button before **More** reads **First pull** until a catalog was pulled
  once and **Refresh** after that, and follows a running refresh to its run;
  **Retry metadata** moves into **More**. These show only to users allowed to
  refresh a catalog, and so do sync state and failed sources.
- A circle's **Retry metadata** and its count cover every catalog work still
  lacking metadata, so a later works page or a filter no longer hides it or
  lowers its count.
- The circle and voice actor works toolbar is the search field, the order, the
  availability filter, and one **View** button holding the display options
  and **Select works**; on a phone **View** opens as a sheet. A caption before the order states the matching works and
  the page; only the bottom page bar turns pages.
- A work video opens in the full-screen player that Record uses: its header
  shows the video's place among the folder's videos, the **Audio track** menu,
  and previous and next; the video starts playing at once, asks whether to
  continue when you stopped part way through, and switches to fullscreen when
  it starts on a phone. The arrow keys seek instead of stepping to another
  video.
- The file viewer and the Directory no longer offer files as downloads, and a
  file Kikoto cannot preview no longer opens a download.
- The image viewer zooms to any size up to eight times actual size with the
  mouse wheel, a trackpad or two-finger pinch, and the `+`, `-`, and `0`
  keys, keeping the point under the pointer or fingers in place. A click
  still switches between fit and actual size.
- **Cleanup → Works** holds **Local works by rating**, which lists your
  low-rated local works largest first and deletes their local folders in one
  run. It can also clear your rating and Quick mark of them and forget the
  works, and asks again before deleting works rated 3 stars or more. A work
  whose folder holds anything else, such as a recycle bin with files in it,
  or whose folder the system will not let go of keeps all its files and is
  reported for a retry.
- Deleting a work's local folder also removes the system files a NAS or
  operating system keeps beside its files, such as `Thumbs.db`, `.DS_Store`,
  and `@eaDir`, which used to keep the folder from being deleted.
- A work fetched from a remote source lists each local file once after a
  scan and after its source is synced again, and **Find identical files** no
  longer reports a file as a copy of itself. The upgrade merges the second
  records earlier scans made, keeping each file's listening progress, lyrics,
  and display names.
- A Fetch archives for review only the folders whose files you copied into it
  in the Fetch dialog, and **After Fetch** lists them before you start it. A
  Fetch of remote files alone, including a bulk, Availability Watch, or
  **Manage files** Fetch, leaves every other folder of the work in place, and
  files left unselected keep their cache and remote streams. Untracking a
  source during a Fetch keeps the cache files that Fetch still needs.
- A source check reports a work as not on the source only when the source
  answers so; a timeout or a failed lookup keeps what the source last said.
- A scan marks the files of a vanished folder missing when the work has
  another folder, and an incremental scan leaves works outside its folders
  alone. A pool registered as a link reads as offline, so a scan never marks
  its works missing, and a data root reached through a link is scanned and
  watched, its folders can become custom works, and files below it can be
  deleted and cleaned up.
- Merging voice actors keeps manual voice actor lists naming the merged
  person, and Undo restores them. A metadata refresh whose rating and price
  request fails keeps the stored rating, sales, and prices; a linked work no
  longer takes the linked product's bundles; an older refresh finishing late
  leaves the newer title and description; and the metadata preview of a
  translated edition reads the edition's own language.
- A queued file deletion or cleanup skips a file that a folder edit moved
  since, instead of deleting what is now at its old path.
- A Fetch into an existing folder places only its own files, one at a time:
  every other file keeps its content, date, and links, a change made to the
  folder while the Fetch runs is kept, and a linked subfolder no longer stops
  the Fetch. A file it replaces stays in the Fetch's backup on the same disk
  until the Fetch completes, and a Fetch that fails while placing its files
  puts back what it placed.
- A folder edit keeps the files it takes out until it succeeds, and puts them
  back when it fails or is cancelled, apart from a file whose place a file the
  edit added has taken.
- A remote file of unknown size is no longer taken as already present from an
  existing file of another size. An existing cache file is downloaded again,
  and an existing file in the target folder is a conflict for you to keep or
  replace.
- The outermost folder whose name carries a work code is the work, and a code
  needs a word of its own in a folder name, so `XRJ00000001` names no work.
- A work folder cannot be registered as a storage pool.
- Marks, ratings, notes, personal tags, list membership, Resume, and listening
  history set through an edition belong to its family's canonical work, and state an
  edition already holds moves there when the family's canonical work changes
  and at startup. Lists, circles, voice actors, and workflow filters show an
  edition with its family's tags and ratings, and a cleared mark or rating
  stays cleared.
- Metadata sync runs past a work that times out or fails, finishing partial,
  and stops only when DLsite keeps rate limiting it, on any of the sites it
  asks, so a retry later resumes.
- Two voice actors may share a name: a voice actor id seen for the first time
  gets its own person under the plain name when a person of that name already
  carries another id of the same source, and a credit without an id never
  goes to a namesake a source id identifies. A person made for a name several
  identified voice actors share never takes over one of their ids or credits,
  and a work's link for that name opens none of them.
- A DLsite answer without edition information keeps an edition in its family,
  and a work that credits a real voice actor no longer also credits the
  unknown voice actor.

</details>

<details>
<summary><strong>Playback</strong></summary>

- The player, its queue, and the lock screen name a work's voice actors under
  the track title, and its circle only when it credits no voice actor.
- Lyrics read more files as they are written: WebVTT and SRT cues with a
  bracketed time in the text stay cues, cue markup and character references
  are cleaned, LRC keeps bracketed lyric text, and WebVTT times of 100 hours
  and more are read.
- Choosing the source already playing does nothing, and removing a queue item
  moves the current track only once.
- Audio whose file runs longer than its sound plays to the end instead of
  failing on the last part, and a file a folder edit moved plays its new file
  at once.
- A legacy progress write no longer replaces a later checkpoint.
- A file whose library or storage pool goes offline while it plays pauses with
  a notice that says so, instead of moving to another source.
- A restored queue plays each item from its local copy unless you picked
  another source for it in the player; an item you have already started keeps
  playing from where it is.
- A restored queue refreshes in one request however long it is, takes each
  track's current lyrics, and orders each track's sources by the same rule as
  Resume and the work page. A changed metadata language renames the queued
  tracks without reloading every queued work.
- A Resume position whose file location vanished is saved without it, and
  positions that cannot be saved no longer fill the waiting list.
- An LRC file's `[offset:]` tag applies under your own lyrics offset, and a
  `.cue` sheet is never taken for lyrics.
- A work card's lyrics mark, the directory, and the player match lyrics files
  to tracks by one rule, so they always agree on which lyrics a track has.
- Removing the playing item when it is last in the queue stops playback and
  keeps the player showing the items that remain.
- The server decides whether a track plays as the file, an HLS playlist, or a
  complete MP3 conversion, from what is inside the file and what your browser
  decodes rather than from the file name. A FLAC file named `.mp3` converts
  when the browser cannot play FLAC, and an MP3 under an unusual extension
  plays as it is. The sound of a Record video plays as it is when the browser
  decodes it.

</details>

<details>
<summary><strong>Operations and reliability</strong></summary>

- The Go toolchain is updated to 1.26.11, which fixes an HTTP/1 server crash
  caused by a race on request headers when a request body is size-limited
  (GO-2026-6859).
- Disabling an account signs it out everywhere, a deleted account's id is
  never given to a new account, and Demo lists works by their effective age
  rating.
- Repeated failed sign-ins lock out only the client address that makes them.
  A username is never locked, so no one can lock its owner out; failures for
  it from anywhere only delay the next attempts on it by up to eight seconds,
  and attempts on it take turns, so parallel attempts cannot share one delay.
- Visitors without an account see only works with a local folder and play
  only local files. **Browse remote sources without an account**, off by
  default, offered while **Browse and play without an account** is on, and
  turned off with it, also lets them browse and play remote sources, cached copies, and works
  without a local folder, since those reads can reveal your remote source
  configuration.

</details>
