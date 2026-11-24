# Unreleased

<details>
<summary><strong>Record</strong></summary>

- **Scan** finishes as soon as it has walked the Record folder, so new files
  can be browsed right away, and its status shows how many files it has found.
- The length of new or changed videos and audio files, and whether an audio
  file carries cover art, is read afterwards by **Read Record media details**,
  a workflow of its own whose progress shows beside **Scan**. It reads only
  each file's header, skips photos, and pauses between files whenever other
  work is waiting. A video whose thumbnail a folder shows, and a file you
  play, is read then if the run has not reached it yet.
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
- Sort and the library's Quick mark filter show the chosen item by its
  highlight alone.
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

</details>
