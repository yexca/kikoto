# Unreleased

> [!NOTE]
> LLM translation previews still waiting for review are discarded during the
> upgrade. Translate those works again with **Translate with AI**, whose
> results take effect as soon as they finish.

> [!IMPORTANT]
> The popular collections become Rankings. Each Remote popular and DLsite
> popular trigger is turned into a ranking in **Subscriptions → Rankings**
> with its period, year, or source, its interval, and whether it ran on its
> own; the triggers themselves are removed. Collections no longer add tags,
> sync metadata, Track, or Fetch, and collection runs still queued or running
> when the upgrade starts are stopped. Tags they added earlier stay with their
> works.

<details>
<summary><strong>Library and work detail</strong></summary>

- Library and Favorites cards show your rating beside the Quick mark and rate
  a work, or clear its rating, without opening it.
- The work detail stat strip shows your rating beside the DLsite rating, also
  for custom works.
- A desktop page about as tall as the window, such as a short last Library
  page with the player open, no longer shakes endlessly as the scrollbar
  appears and disappears.
- Remote source cards for works already in the library show the Local,
  Tracked, or Cached marks and the personal tags of their Library card, so
  **Always** cover source marks no longer show only the remote source.

</details>

<details>
<summary><strong>Subscriptions</strong></summary>

- Subscriptions gains a **Rankings** view beside **New releases**. It follows
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
- On a wide screen the subscription settings open in a panel beside the feed
  or the rankings, which narrow to make room and stay usable; narrower screens
  keep the drawer, and phones the sheet.

</details>

<details>
<summary><strong>Sources and remote fetch</strong></summary>

- Fetch rejects linked staging, target, and backup directories during copying,
  publication, recovery, and cleanup, and keeps filesystem operations within
  the data root when a directory changes after validation.

</details>

<details>
<summary><strong>Metadata and scans</strong></summary>

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
- Lyrics written by speech recognition or translation start with a line naming
  the models, in the lyrics' language, and the player marks them as AI-made.
  **Settings → ASR & LLM → AI lyrics** turns the line off.
- Settings → **LLM & ASR** is renamed **ASR & LLM** and lists speech services
  before LLM providers.
- Notifications about translation and transcription runs open the Translation
  page or the work instead of Activity.

</details>

<details>
<summary><strong>Development and docs</strong></summary>

- CI validation finishes sooner: planned jobs start without waiting for Style,
  the backend race suite runs as six slices balanced by recorded test
  durations (`make backend-race-durations` refreshes them), and each browser
  test shard runs three workers.

</details>
