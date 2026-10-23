# Unreleased

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

</details>

<details>
<summary><strong>Development and docs</strong></summary>

- CI validation finishes sooner: planned jobs start without waiting for Style,
  the backend race suite runs as six slices balanced by recorded test
  durations (`make backend-race-durations` refreshes them), and each browser
  test shard runs three workers.

</details>
