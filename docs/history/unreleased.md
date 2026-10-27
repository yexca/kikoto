# Unreleased

> [!NOTE]
> LLM translation previews still waiting for review are discarded during the
> upgrade. Translate those works again with **Translate with AI**, whose
> results take effect as soon as they finish.

> [!NOTE]
> A metadata sync schedule that uses **Selected works** switches itself off
> the next time it is due, with a message on the trigger. Edit it to another
> scope, or run the selected works from **Workflows** instead.

> [!IMPORTANT]
> The popular collections become Rankings. Each Remote popular and DLsite
> popular trigger is turned into a ranking in **Discover → Rankings**
> with its period, year, or source, its interval, and whether it ran on its
> own; the triggers themselves are removed. Collections no longer add tags,
> sync metadata, Track, or Fetch, and collection runs still queued or running
> when the upgrade starts are stopped. Tags they added earlier stay with their
> works.

<details>
<summary><strong>Library and work detail</strong></summary>

- **Edit files** recovers a file published just before a service interruption
  without copying or downloading it again, and preserves a target that changed
  after publication.
- Switching accounts clears retained workflow details, logs, and review items;
  a permission denial also clears protected data already displayed in Activity.
- Library and Favorites cards show your rating beside the Quick mark and rate
  a work, or clear its rating, without opening it.
- The list button on Library, Favorites, Discover, and Rankings cards names
  the list that holds the work, as on work detail, when the card footer has
  room for the name; a narrower card keeps the lit list icon alone.
- The work detail stat strip shows your rating beside the DLsite rating, also
  for custom works.
- Work detail labels the unrated star **Rate**, so it no longer reads as a
  favorite toggle. The list button of a work in no list shows a list icon with
  a plus, labeled **List** on work detail. On phones, the work detail actions
  stay on one row that scrolls sideways instead of wrapping.
- A desktop page about as tall as the window, such as a short last Library
  page with the player open, no longer shakes endlessly as the scrollbar
  appears and disappears.
- Remote source cards for works already in the library show the Local,
  Tracked, or Cached marks and the personal tags of their Library card, so
  **Always** cover source marks no longer show only the remote source.

</details>

<details>
<summary><strong>Discover</strong></summary>

- Subscriptions becomes **Discover**, the way in to works from outside the
  library: new works from your subscriptions, rankings, and the works
  Availability Watch waits for. Its address is `/discover`, links to
  `/subscriptions` open it, and its navigation icon is a compass; the bell
  stays on the subscribe buttons. Subscribing and the subscription settings
  keep their names.
- Discover gains a **Rankings** view beside **New releases**. It follows
  the DLsite voice rankings for 24 hours, 7 days, and 30 days, the annual
  ranking of each year, and the all-time ranking, and remote sources' popular
  lists, in a fixed order of chips. A DLsite ranking is shown by
  **Popularity** or **Sales**, and the 24-hour, 7-day, and 30-day rankings
  also only for works **Released within 30 days**; each of these orders keeps
  its own updates, history, and seen state, and the address and Back keep the
  choice. The view marks what entered, returned, moved, or dropped out since
  your last visit, the previous update, or another time. A pull records each
  order and never adds works to the library, syncs metadata, tags, Tracks, or
  Fetches.
- **History** shows a ranking as it was on a chosen day and update, in your
  time zone, says when no pull confirmed that order, and does not mark the
  ranking as seen.
- The **Rankings** tab of the subscription settings has a row for every
  DLsite ranking, the annual ranking of the year in progress and of added
  earlier years, and each compatible remote source, in the order of the
  chips. Each ranking is shown, pulled automatically in all of its orders, and
  given its interval and depth on its own; the default interval follows how
  often DLsite updates that ranking. The annual ranking is finalized from 3
  January in Japan once both of its orders are pulled, and can continue with
  the next year. The annual rankings share one chip with a year choice, and a
  finished year reads as its final order.
- Ranking history keeps every change for 30 days and then one order per day
  for a year by default, both set in the Rankings settings. The database
  cleanup applies the same rule.
- Workflows lists **Pull DLsite rankings** and **Pull remote source rankings**
  under Collect with their run history, configured from the Rankings settings.
- Refresh requests made during a ranking pull stay queued for the next run.
  Cancelling a pull or recovering an interrupted one preserves the automatic
  schedule without immediately repeating the cancelled pull.
- On a wide screen the subscription settings open in a panel beside the feed
  or the rankings, which narrow to make room and stay usable; narrower screens
  keep the drawer, and phones the sheet.
- Rankings keeps its ranking, order, filter, and update controls in a compact
  toolbar that stays in reach while scrolling, states beside each work's card
  only the facts worth stating, and opens History and the comparison from the
  toolbar. The Rankings settings show one line per ranking
  with relative pull times and expand a row in place to edit it, and deleting
  a ranking with its history asks first.
- New releases and Rankings have an **Actions** menu for the works the page
  shows. **Sync metadata** syncs DLsite metadata for the works without fresh
  metadata, adding the works Kikoto does not know yet with their title, cover,
  rating, and tags, and **Check sources** asks the remote sources about the
  works not known to be available. Both take only the works that still need
  them, run in the background with a status line, and reload the page when
  they end; a ranking pull still only records the order.
- **In library** and **Not in library** on Rankings follow whether the library
  has files for a work, and **On a source** keeps the works a remote source is
  known to have.
- New releases and Rankings cards label the Availability Watch action
  **Watch** and show **Watching** for a work already in the watch pool.
- The Availability Watch pool becomes the **Watch** view of Discover,
  after New releases and Rankings and in the same card grid and display
  options. **Available** comes first and shows every available work; **Not
  available** follows with failed checks first and folds to whole rows.
  **Clear completed** removes every work whose Track or Fetch has started in
  one step. The **Availability Watch** settings tab moves after **Rankings**
  and keeps the configuration and **Run**, and the settings open on the tab
  of the current view. Availability notifications, Workflows, and the way back
  from a watched work open the Watch view, and existing links to the pool in
  the settings open it too.

</details>

<details>
<summary><strong>Sources and remote fetch</strong></summary>

- Fetch rejects linked staging, target, and backup directories during copying,
  publication, recovery, and cleanup, and keeps filesystem operations within
  the data root when a directory changes after validation.

</details>

<details>
<summary><strong>Metadata and scans</strong></summary>

- Full local scans reconcile changes made inside indexed work folders while the
  server is stopped, including added, removed, and replaced files, while keeping
  folders outside the visible scan scope unchanged.
- Metadata groups All, Needs attention, Metadata issues, and No available
  source as filters under one **DLsite works** tab. Existing links, including
  metadata sync **Open metadata issues** links, open the matching filter.
- The metadata editor is larger and easier to scan. **Description** and **Age
  rating** have their own sections, and **Metadata source** is renamed
  **Links**. The universal title is the **Fallback** row of the Title section,
  shown in every language without a manual title of its own. Tags form a table
  with a column for each language and the fallback name. The **Metadata
  language** strip appears only in the Title, Description, and Tags sections,
  where its **Fallback** option and each language show only that title,
  description, and tag name column. Each field shows its status, current source, and Revert on one line.
  The footer keeps **Refresh metadata** and moves **Fetch for edit** and
  **Translate with AI** under **More**.
- A work's description can be written for each language, like its title. The
  editor's **Description** section lists every language and a **Fallback**
  description, which is the former all-language description. A language with
  only its own description gets a choice in the metadata language menu, and
  translation coverage counts it as **Manual**.
- A product DLsite reports unavailable, such as a delisted work, can be
  dismissed from Metadata issues: **Dismiss** on the affected edition, or
  **Dismiss unavailable** for selected works. It then leaves the issue list
  and the metadata run's Needs attention notice until a later sync fails.
- Activity offers **Mark reviewed** for a run whose remaining metadata issues
  are only unavailable products, instead of keeping it in Needs attention.
- Metadata issues offer **Fetch from** each enabled remote source that
  provides metadata, for an affected edition or the selected works, without
  turning on automatic remote fallback.
- Metadata view counts load faster on large libraries.
- Metadata sync **Selected works** accepts codes the library does not have
  yet: with DLsite it adds those works and their language editions, and counts
  a code DLsite does not list as unavailable. A remote metadata source still
  refreshes only works in the library. Selected works runs only on demand, so
  schedules no longer offer it.

</details>

<details>
<summary><strong>Translation</strong></summary>

- Transcription and translation text previews carry the signed-in session on
  mobile and cross-origin web clients, and discard results after the session
  changes or the caller cancels.
- **Translate with AI** replaces Translate with LLM and the lyrics manager's
  Translate tab. One dialog translates a work's title, description, shared tag
  names, file and folder display names, and lyrics into several languages at
  once, and sends only what each language lacks. Each result takes effect as
  soon as it finishes, after its source, the content policy, the requester's
  permission and the provider are checked again. Tag names show how many works
  they affect. Lyrics of tracks without any are transcribed first, once per
  track, and every language is translated from that transcription; a speech
  model that writes the one chosen language directly writes it without an LLM
  step.
- Display names of local files and folders can be translated with AI. Names in
  the original language and names without words, such as `Track01`, are left
  as they are.
- A new **Translation** page in the sidebar follows running and queued
  translations by work and language, resends stopped ones, lists what each
  translation wrote with a link to its work, and holds the translation
  coverage that was under Metadata. Everyone who can translate sees every
  account's translations.
- Translation recovers completed transcriptions and their dependent items
  after interruption. Resending a speech request with an unknown result
  requires confirmation, including when resending a dependent translation.
- Accounts with library write permission can cancel their own translations
  from the Translation page; workflow administrators can cancel other
  accounts' runs. Shared tag translations apply without stalling the queue
  on a single database connection.
- Lyrics written by speech recognition or translation start with a line naming
  the models, in the lyrics' language, and the player marks them as AI-made.
  **Settings → ASR & LLM → AI lyrics** turns the line off.
- Settings → **LLM & ASR** is renamed **ASR & LLM** and lists speech services
  before LLM providers.
- Notifications about translation and transcription runs open the Translation
  page or the work instead of Activity.

</details>

<details>
<summary><strong>Operations and reliability</strong></summary>

- Playback, transcription, loudness analysis, cover selection, and media
  probing accept files when the data or cache root, or one of its parent
  directories, is a symbolic link. A link inside the root that leaves it is
  still refused.

</details>

<details>
<summary><strong>Development and docs</strong></summary>

- CI validation finishes sooner: planned jobs start without waiting for Style,
  the backend race suite runs as six slices balanced by test durations
  recorded in CI (`make RACE_RUN=<run id> backend-race-durations` refreshes
  them), each browser test shard runs three workers in the pinned Playwright
  image, and no browser job installs system packages.

</details>
