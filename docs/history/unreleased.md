# Unreleased

<details>
<summary><strong>Record</strong></summary>

- A Record scan finishes as soon as it has walked the Record folder, so new
  files can be browsed right away, and its status shows how many files it has
  found.
- The Record page's path bar holds **Continue watching** and **Refresh**:
  scans run from the **Record scan** card on Workflows, its triggers, or
  **Scan Record library** in the command palette, and the empty page offers
  **Scan** before the first one. Selecting the status of a running scan or
  media details run opens that run on Workflows.
- The length of new or changed videos and audio files, and whether an audio
  file carries cover art, is read when you open its folder, and appears a few
  seconds later; a file you play, or whose thumbnail a folder shows, is read
  then too. Each read covers only the file's header and skips photos, and
  nothing is read while the Record folder is not mounted.
- **Read Record media details** reads every file still waiting at once, by
  hand, on a schedule, or after a Record scan finds new files, as a workflow of its
  own whose progress shows on the Record page. It pauses between files whenever
  other work is waiting.
- The Record page keeps following a scan or a media details run until it
  ends, including one started elsewhere, and a failed scan says so.

</details>

<details>
<summary><strong>Workflows</strong></summary>

- What is running sits at the top of the page, above three tabs:
  **Operations**, **Needs attention**, and **History**. Operations holds the
  cards and **Next**; Needs attention lists every run that waits for a
  decision, and its tab counts them.
- **Next** lists only the triggers that will run: a paused trigger stays in
  its card's trigger list, and a ranking pull shows only while one of its
  rankings has a pull planned, with when it is due.
- Operations adds a **Record** section while Record is on: **Record scan**
  and **Media details**, which reads every file still waiting, including
  files an earlier run gave up on after a timeout.
- Triggers follow what each operation works on. **Scan** and **Record scan**
  run at startup or on a schedule. **Metadata**, **Index**, and **Media
  details** no longer run at startup: they run on a schedule, or after the
  scan they follow has finished and found something for them, as **After a
  scan adds works**, **After a scan finds new folders**, and **After a Record
  scan finds new files**. A new install runs nothing on its own until library
  setup or you turn a trigger on.
- A scan run by hand takes no **Follow-up run**: give Metadata its **After a
  scan adds works** trigger instead.
- A card's triggers are one switch for each way the operation can start, and
  every change saves at once; **Add trigger** is gone. Turning a switch off
  pauses that trigger and keeps its interval and mode, and a Metadata or Index
  schedule and the folder watcher choose **Incremental** or **Full** beside it.
- Metadata's triggers run with the card's **Metadata options**: saving the
  options updates them too.
- Links and Quick actions that open the runs needing attention open the
  Needs attention tab.
- A run opens beside its list only from Needs attention or History, stays in
  view while the list scrolls, and closes with **Close run**, Escape, its row,
  or another tab or filter. A run opened from Running, a card, or a link takes
  the page, and Back returns to the list it was opened from.

</details>

<details>
<summary><strong>Work Detail</strong></summary>

- On a phone, a directory track shows its duration on the line under its name,
  beside its size, so the name gets the width the trailing duration column took.
- On a phone, the work code and DLsite link move into the app header after the
  section name. The title is smaller and starts with any metadata-language
  chip, so wrapped lines keep the full width; the work details toggle follows
  it, the circle and voice actors sit close below it, and hiding the work
  details keeps the title on one line. The directory edition joins the source
  in the Directory row. The tag row is one line that scrolls sideways, with
  personal tags first, the tag editor pinned at its end, and **No tags** when
  the work has none. The ratings and other figures follow close below it,
  without a line above them.

</details>

<details>
<summary><strong>For You</strong></summary>

- The reason above each card starts with an icon in the accent color for what
  it rests on, such as a circle, voice, tag, rating, or past play, and reads in
  darker text, so it stands out on a phone.
- The chosen temperature step is shown in the accent color.
- On a narrow window or a phone, For you opens on the column you chose last on
  that device.

</details>

<details>
<summary><strong>Circles and voice actors</strong></summary>

- The works toolbar of a circle or voice actor leaves the work count to the
  circle's **Works** tab or the voice actor summary's **Works** count; its
  caption shows only the page, from tablet width, when the works span more
  than one.

</details>

<details>
<summary><strong>Cleanup</strong></summary>

- **Local works** on the Works tab searches only when you press **Search**,
  and keeps its result and selection while you visit other pages. Its filters
  sit on one row and are highlighted while they narrow the search: rating
  (any, up to a number of stars, or unrated only), Quick mark, smallest size,
  and storage pool. A search orders works by size or rating in either
  direction and keeps at most a chosen number of works, 50 unless you choose
  more, shown 20 to a page.

</details>

<details>
<summary><strong>Menus and popovers</strong></summary>

- Menus that list choices or actions are as wide as their longest item.
- A menu or popover opens along the left edge of its button and moves to the
  right edge when it would run off the screen.
- Sort, the collection filter, and the library's Quick mark filter show the
  chosen item by its highlight alone, and the sort and filter menus are
  narrower.
- The sort button shows the order's name without an icon before it, so the
  direction button beside it is the only arrow.
- **View** on a circle or voice actor page is an icon button.
- **Add to list** is narrower, and a smart list that holds the work by its
  rule reads **Auto-matched**.

</details>

<details>
<summary><strong>Player</strong></summary>

- The full player has a button in its top-right corner that clears the whole
  queue and closes the player. It and **Clear** in the queue view both ask for
  a second press; pressing anywhere else, pressing Escape, or waiting four
  seconds cancels it.

</details>

<details>
<summary><strong>Operations and reliability</strong></summary>

- Upgrading removes database tables, columns, and duplicate indexes that
  nothing reads: the previews, lyrics, and tag-name candidates of the
  per-work LLM translation that Translate with AI replaced, and the
  per-track progress that Resume replaced. Translate with AI history, Resume
  positions, and listening history stay.
- Upgrading moves automatic runs onto the new triggers: a scan trigger that
  asked for a follow-up metadata sync becomes Metadata's **After a scan adds
  works**, and an Index startup trigger becomes its after-scan trigger, each
  staying on or off as it was.

</details>
