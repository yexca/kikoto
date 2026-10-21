# Unreleased

<details>
<summary><strong>Library and work detail</strong></summary>

- The work detail directory shows local files and folders by display names in your metadata language. A user with library write access sets them from the local source's **Edit display names**, one language at a time, typing them or pasting a list; files and folders on disk keep their names. A **Display names** button at the top right of Directory is highlighted while they show, says in its tooltip that they are not the real file names, and switches back to the real names on that device. The player, its queue, screen lyrics, and the system media controls name a track the same way, and queued tracks take new names when you change your metadata language or names are saved, without interrupting playback. The real names still decide the order, track numbers, and lyrics matching.
- On a phone, the Library header takes two rows: a source button beside the search field names the current source and opens every source, including disabled ones, in a menu, and a **Mark filter** button beside sort shows or hides the Quick mark chips, which start hidden. While a mark filter is set, the button shows that mark. **Continue listening** moves into the sort row as a button that opens the strip of recently played covers on any page and source; it starts closed. As on wide screens, the phone sort button carries the refresh for the Recommended and Random orders, so a random order reshuffles in one tap.
- On a phone, work detail shows at most three lines of a long title, and tapping it shows the rest. A button at the end of the work code row hides the title, circle, credits, tags, and stats so the actions sit right below the cover; the device remembers the choice for every work.

</details>

<details>
<summary><strong>Metadata and scans</strong></summary>

- **Custom works** in Metadata lists the custom works themselves, with search, editing, and status like the other work tables, and deletes the local information of one whose folder is missing. **Create from folder** in its header opens the folder list that creates a custom work. All, Needs attention, Metadata issues, and No available source list only works with a catalog code.

</details>

<details>
<summary><strong>Operations and reliability</strong></summary>

- The Docker image is published for `linux/arm64` as well as `linux/amd64` under the same tags, so Kikoto runs on ARM NAS devices and 64-bit Raspberry Pi OS with the usual `docker compose up -d`.

</details>

<details>
<summary><strong>Development and docs</strong></summary>

- The release workflow builds a tag only after `Full` has passed on the same
  commit and no longer repeats its validation. Every release job has a time
  limit.

</details>
