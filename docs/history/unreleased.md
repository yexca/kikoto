# Unreleased

<details>
<summary><strong>Library and work detail</strong></summary>

- A loading placeholder appears only once a load takes longer than 200ms, so
  a page, list, panel, or dialog that answers quickly shows its content
  without a placeholder flashing first.

</details>

<details>
<summary><strong>Header and Workflows</strong></summary>

- Quick actions and its Ctrl K / ⌘K shortcut are gone. Pages open from the
  sidebar, the bottom navigation, and the account menu; scans and Metadata
  start from their cards on Workflows; a work opens by its address.
- **Recover stale runs** sits beside the tabs on Workflows → **Needs
  attention** and reports how many runs it requeued or marked failed.
- Every page with views switches them through one icon tab row: Translation
  and Tags take it in place of their pills, and Discover, Metadata, and
  Workflows tabs gain icons. On a narrow row the tabs fold to icons and name
  only the open one, and a tab's count is read after its name. The Tags
  search sits at the end of the tab row.

</details>

<details>
<summary><strong>Playback</strong></summary>

- The player scrolls only the title or artist line that does not fit; when
  both overflow they start each cycle together. The full player's title and
  artist scroll instead of ending in an ellipsis, and a queue row scrolls its
  artist as well as its title while it plays, is pointed at, or has focus.

</details>

<details>
<summary><strong>Demo</strong></summary>

- Demo shows Record over a library it generates on start: short
  test-pattern videos, one with a subtitle sidecar and one with embedded
  subtitles, photos, and tone audio files with cover art. The Demo account
  has two samples under Continue watching, the Workflows page shows Record
  scan and Media details examples, and System → Library shows the record
  root as online. Demo ignores `KIKOTO_RECORD_ROOT` and never reads a
  `/record` mount.
- The Translation page in Demo lists sample runs and items over a few of its
  works, marked as samples and read-only, instead of only Coverage.
- Workflows in Demo also shows examples of Translate with AI, file editing,
  database backup and optimization, and subscription refresh; Updates lists a
  finished and a failed example Fetch and a subscription release; and
  System → Users lists sample accounts of each role.

</details>

<details>
<summary><strong>Sources and remote fetch</strong></summary>

- The file types a Fetch from the availability watch leaves out are kept for
  each server. Every server starts from the choice made before the upgrade.

</details>
