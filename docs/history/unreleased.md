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

</details>

<details>
<summary><strong>Interface</strong></summary>

- On touch screens, About's License link no longer takes taps and scrolls
  across the page, so it stops highlighting during a scroll and the reference
  project links open their own pages. The library sort button keeps its
  touch area on the button the same way.
- The phone Favorites shelf strip and the circle and voice filter chips follow
  the theme style's corner radius instead of always drawing pills.

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

</details>
