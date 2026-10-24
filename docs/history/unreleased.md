# Unreleased

<details>
<summary><strong>Library and work detail</strong></summary>

- Library and Favorites cards show your rating beside the Quick mark and rate
  a work, or clear its rating, without opening it.
- The work detail stat strip shows your rating beside the DLsite rating, also
  for custom works.
- A desktop page about as tall as the window, such as a short last Library
  page with the player open, no longer shakes endlessly as the scrollbar
  appears and disappears.

</details>

<details>
<summary><strong>Subscriptions</strong></summary>

- Subscriptions gains a **Rankings** view beside **New releases**. It follows
  DLsite voice rankings (24 hours, 7 days, or 30 days, optionally only new
  releases) and remote sources' popular lists, and marks what entered,
  returned, moved, or dropped out since your last visit, the previous update,
  or a chosen earlier update. Rankings are added and scheduled in the new
  **Rankings** tab of the subscription settings; a refresh records each
  ranking's order and never adds works to the library. Ranking history older
  than 90 days is removed with the database cleanup.

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
  **Translate with LLM** under **More**.
- A work's description can be written for each language, like its title. The
  editor's **Description** section lists every language and a **Fallback**
  description, which is the former all-language description. A language with
  only its own description gets a choice in the metadata language menu, and
  Metadata → Translation counts it as **Manual**.
- **Translate with LLM** labels its original and translated text in the
  interface language.
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
<summary><strong>Development and docs</strong></summary>

- CI validation finishes sooner: planned jobs start without waiting for Style,
  the backend race suite runs as six slices balanced by recorded test
  durations (`make backend-race-durations` refreshes them), and each browser
  test shard runs three workers.

</details>
