# Unreleased

<details>
<summary><strong>Interface</strong></summary>

- On touch screens, About's License link no longer takes taps and scrolls
  across the page, so it stops highlighting during a scroll and the reference
  project links open their own pages. The library sort button keeps its
  touch area on the button the same way.
- The phone Favorites shelf strip and the circle and voice filter chips follow
  the theme style's corner radius instead of always drawing pills.
- The account menu behind the avatar drops its **Your data** shortcut;
  **Your data** stays at the end of **Settings → Account** and in Quick
  actions.
- On a phone, work detail is tidier: the metadata language chip shows only
  the language code, such as `JA`, without the original marker; an arrow on
  the selected Directory tab opens source tab visibility with **Check
  sources** below it, so the source tab row holds only the sources; and long
  file and folder names stop at two lines until **Full names** shows them in
  full.

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

</details>
