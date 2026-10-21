# Unreleased

<details>
<summary><strong>Interface</strong></summary>

- On touch screens, About's License link no longer takes taps and scrolls
  across the page, so it stops highlighting during a scroll and the reference
  project links open their own pages. The library sort button keeps its
  touch area on the button the same way.
- The phone Favorites shelf strip and the circle and voice filter chips follow
  the theme style's corner radius instead of always drawing pills.
- The Android and iOS apps navigate like a tabbed app. Each bottom tab keeps
  its own back stack, so switching tabs is no longer a Back step and Back no
  longer jumps into another tab's pages. Changing a list's tab, filter, or page
  is not a Back step either, and returning from a resumed detail no longer
  leaves an extra entry behind. The Android back button goes from another
  tab's root to Library, then asks for a second press before leaving the app.

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
