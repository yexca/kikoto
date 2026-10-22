# Unreleased

> [!NOTE]
> Personal ratings, including those imported from Kikoeru, now shape
> recommendations, and a stored rating of 0 becomes unrated. Existing
> recommendation sessions are renewed on the next visit.

<details>
<summary><strong>Library and work detail</strong></summary>

- Work detail shows your rating beside its Quick mark as a star with its
  number, which opens a popover to rate the work from one to five stars or
  clear the rating.
- On a phone, work detail shows Resume as its icon, so the Resume, Mark,
  rating, and List actions stay on one row.
- Recommendations take your rating as the main taste evidence: four and five
  stars count as liking a work, one and two stars as disliking it, and three
  stars as neutral. Quick marks count only for unrated works and weigh less:
  Relisten counts half a favorite, and Shelved counts lightly against similar
  works. One disliked work is enough to lower similar works.
- Recommendation settings set how much evidence each rating and unrated
  Favorite, Relisten, or Shelved work carries. The Avoid shelved preset is
  now Avoid dislikes, and the shelved penalty now applies to disliked
  similarity.
- The work directory, playback order, and the fetch, folder edit, delete,
  display name, and lyrics lists order names numbered with kanji after 第 by
  their number, so 第二話 comes before 第十話 in every interface language.

</details>

<details>
<summary><strong>Metadata and scans</strong></summary>

- Metadata's work tables split the status column into **Metadata** and
  **Source**. Healthy states read as quiet text: **Complete** replaces OK,
  and **Source** shows **Local** or **Remote**. A work DLsite was never asked
  about shows **Not synced**, appears under Needs attention and Metadata
  issues, and **Retry metadata** queues its first sync. **No available
  source** takes the attention color.
- On wide screens Metadata's views start as a row above the list, so the
  tables keep the full width; **Show tabs beside** returns them to the
  column, and Metadata remembers the choice.
- Metadata's rail shows how many works each works view lists, with the
  attention views in the attention color, and a line under the header says
  what the current view lists. Rows show the title first with the code and
  circle below it.
- Pressing a Metadata work row opens a work inspector beside the table, or in
  a sheet on smaller screens, with the work's metadata and source state, its
  recovery actions, release date, age rating, series, voice actors, rating,
  sales, and tags, and buttons to edit the metadata or open the work.
- Selected Metadata works get a selection bar with **Retry metadata**,
  **Check sources**, and **Delete local information** and their counts,
  instead of count buttons in the header.
- A work DLsite does not have and a remote source filled shows **Metadata
  from** its source and no longer counts as a metadata issue, in Metadata,
  run results, or Activity's Needs attention.

</details>

<details>
<summary><strong>Workflows</strong></summary>

- Activity and run details name what a run acts on, so a failed circle,
  series, or voice actor catalog sync shows which one failed, such as
  `Sync a circle catalog · RG00000000`. Runs for one work, a circle- or
  voice-scoped metadata sync, and runs for one remote source show it the same
  way, workflow run lists show it beside the run number, and Activity search
  finds runs by it.

</details>

<details>
<summary><strong>Interface</strong></summary>

- On wide screens Settings starts with its tabs as a row above the settings,
  as Metadata does; **Show tabs beside** returns them to the column, and
  Settings remembers the choice.
- On touch screens, About's License link no longer takes taps and scrolls
  across the page, so it stops highlighting during a scroll and the reference
  project links open their own pages. The library sort button keeps its
  touch area on the button the same way.
- The phone Favorites shelf strip and the circle and voice filter chips follow
  the theme style's corner radius instead of always drawing pills.
- On a phone, Favorites reaches its works sooner and reads like the Library:
  the shelf header fits on one row with the finished share as a percentage,
  search gets its own row, the sort button names the current order, the
  listening-status filters scroll as one chip row instead of being cut off,
  and a caption with the result count and page replaces the top page bar.
- The account menu behind the avatar drops its **Your data** shortcut;
  **Your data** stays at the end of **Settings → Account** and in Quick
  actions.
- On a phone, work detail is tidier: the metadata language chip shows only
  the language code, such as `JA`, without the original marker; an arrow on
  the selected Directory tab opens source tab visibility with **Check
  sources** below it, so the source tab row holds only the sources; and long
  file and folder names stop at two lines until **Full names** shows them in
  full.
- The Android and iOS apps navigate like a tabbed app. Each bottom tab keeps
  its own back stack, so switching tabs is no longer a Back step and Back no
  longer jumps into another tab's pages. Changing a list's tab, filter, or page
  is not a Back step either, and returning from a resumed detail no longer
  leaves an extra entry behind. The Android back button goes from another
  tab's root to Library, then asks for a second press before leaving the app.
- Changing the page on the circle and voice actor lists and on circle and
  voice actor detail returns to the top of the new results, as the Library
  does, instead of staying at the bottom of the page.

</details>

<details>
<summary><strong>Playback</strong></summary>

- Compatibility playback and audio formats the browser cannot play, such as
  `.wma`, stream as HLS segments that one continuous encode produces from
  where playback starts or seeks to, instead of waiting for the whole file to
  be converted to MP3. A multi-hour file starts within about a second, a file
  too long for the four-minute MP3 preparation limit plays, and segment
  boundaries stay seamless. Browsers without HLS playback keep the complete
  MP3 conversion.

</details>

<details>
<summary><strong>Development and docs</strong></summary>

- About lists mozilla-firefox/firefox under **Engineering & CI**, as a
  reference for agent guidance that loads area docs only when relevant, tool and
  verification pitfalls recorded in the repository, and the AI-assisted
  contribution policy.
- The agent guide keeps a short always-read core and maps each area to the
  docs to read before changing it. It also forbids invented issue numbers,
  versions, migration numbers, release tags, and catalog codes, and requires
  the user's approval before pushing, opening or updating a pull request, or
  posting on issues, discussions, or reviews.
- Testing docs list local pitfalls: Playwright reusing a server already on
  port 3100, `npm ci` in frontend make targets beside a running Vite server,
  `npx` without `node_modules`, line endings for Prettier and `gofmt` in a
  CRLF checkout, the hard-coded UI copy and sensitive-key checks, e2e specs
  that locate elements by UI copy, and argument binding in multi-statement
  SQLite `Exec` calls.
- Agent skills in `.claude/skills/` cover release preparation, GitHub issue
  reply drafts, and doc translation sync, with an admission rule that keeps
  only repository-wide workflows.
- Contributing describes the AI-assisted contribution policy.
- A daily `Dependency Audit` workflow runs `govulncheck`, `npm audit`, and
  `npm audit signatures` against `main` through the new
  `make dependency-audit` target.
- The build toolchain is updated to Node.js 24.22.1 with npm 11.19.1, which
  carry the October Node.js security fixes and distrust a compromised
  intermediate certificate authority.

</details>
