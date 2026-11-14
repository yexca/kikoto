# Unreleased

> [!NOTE]
> Record reads its library from a separate `/record` mount. The bundled Compose
> files mount `./record`; add the same mount to a custom Compose file to use
> Record.

<details>
<summary><strong>Record</strong></summary>

- Record is a separate library for personal videos and photos in the
  sidebar. It reads its own `/record` mount, starts after an administrator
  initializes the root, and never adds files to the audio Library or to a
  work.
- Record browses one folder at a time under a path that leads back to every
  parent, and the address keeps the open folder for Back, Forward, and reload.
  Folders with artwork open with a poster and backdrop banner and **Play** or
  **Continue from**; videos, photos, and subfolders can be filtered and
  sorted.
- Videos play in a full-screen player that steps through the folder, offers to
  continue where you stopped, saves the position per account, and pauses the
  global audio player. Photos open full screen with arrow keys and swipes.
- A scan reads each video's length and size. Video tiles show a frame from the
  video and photos show small thumbnails, both made the first time a folder
  shows them; folder artwork images stay out of the photos.
- Record thumbnails are kept in the transcode cache and count against its
  limit in **System → Cache & Fetch**. The least recently viewed are removed
  first when the cache is full, **Clear transcode cache** in **System →
  Cleanup** removes them with the rest of the cache, and a complete Record scan
  removes the thumbnails of files that are gone. A removed thumbnail is made
  again the next time a folder shows it.
- **Continue watching** at the top of Record lists the videos you stopped part
  way through and resumes them. A `.vtt` or UTF-8 `.srt` file named like a
  video plays as its subtitles.

</details>

<details>
<summary><strong>Interface</strong></summary>

- The desktop sidebar shows the listening destinations and folds the rest
  into two groups: **Personal** holds Insights, Tags, and Settings, and
  **Manage** holds Workflows, Activity, Metadata, Translation, and System. A
  group stays collapsed until you open it, remembers that choice on the device,
  and opens on its own while one of its pages is shown.
- Settings holds only your own account, playback, and recommendation
  settings. The instance settings (Library, Cache & Fetch, Proxy, ASR & LLM,
  Cleanup, and Users) are the new **System** page for administrators, and
  existing links to those Settings tabs open it.
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
- Secondary navigation has two forms. Discover, Metadata, Activity, Settings,
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

</details>

<details>
<summary><strong>Workflows and Activity</strong></summary>

- **Workflows** is one list of what you start by hand, grouped
  into Library, Catalogs, and Remote sources. Each operation is a row with its
  name, one sentence, its state, and a run control, on phones as well, where
  the page no longer starts with a list to choose a workflow from.
- **Run** starts an operation with its default options and the row shows the
  run at once. The local scan and local work files cannot be started again
  until their run ends; Fetch, metadata sync, works on a source, and the
  catalog syncs can queue another target while one runs, and the row counts
  the runs it is not showing. A run started by a schedule, at startup, or in
  another browser shows on its operation the same way. A failure stays on the operation and opens its run in Activity.
- **Options** opens an operation's Run options, triggers, and run history
  below its row. Operations that need an input, such as Fetch and the catalog
  syncs, open their options from **Run…**.
- The status strip, the workflow list, and the **Latest run** card with its
  stage list and streaming log are removed. A run's steps and log are in its
  details in Activity.
- The ranking pulls, Availability Watch, the subscription refresh, and Learn
  tag names are no longer listed; they are run from Discover or on their own,
  and Activity keeps their runs.
- Each of those Discover workflows (the DLsite and remote source ranking
  pulls, the subscription refresh, and Availability Watch) shows its latest
  run in its settings: **Running**, **Succeeded**, or **Failed** with when it
  ended, opening that run in Activity. This shows to everyone who can open the
  settings, and the Watch's line includes checks a subscription refresh
  queued. The notice after **Refresh all**, **Pull now**, **Refresh now**, or
  a Watch check has a link to the run it queued.
- **Refresh now** for the subscription refresh needs only the permission to
  sync metadata, not the permission to change subscriptions.
- **Activity** is a page of its own in the **Manage** group. It lists every
  run under **All**, **Running**, **Needs attention**, **Failed**, and
  **History**, narrows to one workflow, and searches runs. Links to Activity
  inside Workflows, and `?workflow=` links to a workflow that is no longer
  listed, open the Activity page.

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
- Circle and voice actor pages open with a summary like the work detail Hero:
  no frame, catalog counts with a short availability bar under a thin line,
  and quiet **Favorite**, **Subscribe**, and **More** controls. Voice actor
  pages show the same counts as circles.
- **First pull**, **Refresh**, and **Retry metadata** move into **More** and
  show only to users allowed to refresh a catalog. A catalog that was never
  pulled says so under the counts with a **Pull the full catalog** link for
  those users; sync state and failed sources show only to them.
- The circle and voice actor works toolbar is the search field, the order, the
  availability filter, and one **View** button holding the display options
  and **Select works**; on a phone the search field stays on show and **View**
  opens as a sheet. Works that fit one page show their count without a page
  bar.

</details>

<details>
<summary><strong>Operations and reliability</strong></summary>

- The Go toolchain is updated to 1.26.11, which fixes an HTTP/1 server crash
  caused by a race on request headers when a request body is size-limited
  (GO-2026-6859).

</details>
