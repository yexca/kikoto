# Unreleased

<details>
<summary><strong>Library and work detail</strong></summary>

- The List button on a work's detail page names the list that holds the work.
  When several do, it names the first and counts the rest, and its tooltip
  names them all.
- **Manage lyrics** keeps one lyrics file per track and language. A language
  strip switches between the lyrics for every language and Japanese,
  Simplified Chinese, Traditional Chinese, English, and Korean. Assignments
  saved by earlier versions apply to every language.
- **Manage lyrics** puts its sections in a tab bar under the title and the
  language strip, folder alignment, and reset in one toolbar. Each folder of
  tracks counts the tracks that have lyrics, a mark on every row shows whether
  the track has lyrics, and the lyrics preview lists line times in their own
  column. **Transcribe** and **Translate** keep the request form beside the
  results on wide screens.
- **Lyrics files** in **Manage lyrics** replaces **From remote**. Like **Edit
  files**, it edits in three columns the lyrics Kikoto manages in a folder
  named after their language, such as `lyrics_zh_hans`, inside the work
  folder. It moves lyrics of the work folder there, copies them from the
  work's other local folders and other editions in the library, downloads them
  from remote editions, and deletes them. You choose the language; Kikoto does
  not guess the language of the work's own files. A different file with the
  same name is resolved in the preview by keeping, replacing, keeping both, or
  renaming, without deleting it first. Added lyrics can be assigned to the
  tracks they match.
- **Manage files** has **Manage as lyrics**, which opens **Lyrics files** with
  the selected lyrics files. It hides the lyrics in those folders unless **Show
  in the list** is on.
- **Transcribe** in **Manage lyrics** turns a local track's speech into timed
  lyrics with a configured speech recognition service. The transcription runs
  as an Activity workflow in parts of at most five minutes, cut in quiet
  moments, and gives the queue to other waiting work between parts. The result
  waits for review; **Add to lyrics** saves it as a WebVTT file in the
  language's lyrics folder and assigns it to the track.
- **Translate** in **Manage lyrics** translates a lyrics file of the work with
  a configured LLM provider for a chosen track and language. The translation
  runs as an Activity workflow, keeps the file's timing, and waits for review;
  **Add to lyrics** saves it in the target language's lyrics folder under the
  track's path and assigns it to the track.
- **Manage files** keeps the folder choice, **Quick select**, and **Edit
  files** in one toolbar above the list. **Quick select** holds the selections
  by location and format. The head of the list selects the whole folder, a
  file names its copies only when it has more than one, and **Manage as
  lyrics** and forgetting the work appear once the selection allows them.
- **Quick select** in **Manage files** has **Find identical files**, which
  compares the local files of every edition and folder of the work by content,
  marks the files that have an identical copy, and can select the copies that
  also exist in another folder or are repeated in the listed one.
- **Manage files** has **Edit files**, a three-column edit of one local
  folder: the work's local folders and remote editions on the left, the files
  of the chosen place in the middle, and the final folder on the right. It
  copies files from the work's other local folders, downloads files from
  remote editions, and removes the files cleared in the folder, as one
  Activity workflow. **Fetch** on the detail page of a work that has a local
  folder opens it.
- A work whose files lie in several local folders shows each folder in its
  directory, lists one folder at a time in **Manage files**, and tells a
  library manager how to bring the copies into one. The same notice appears
  when another edition of the work is in the library.
- The Library and Favorites offer 24, 48, or 96 works per page on every tab.
  Remote sources drop the 12-per-page choice, and a device that had chosen it
  shows 24. Favorites gains 96.

</details>

<details>
<summary><strong>Metadata and scans</strong></summary>

- A local scan keeps every folder in which it finds a work's code as a folder
  of that work and indexes all of them. It no longer raises duplicate folders
  for review in Activity.
- A local scan no longer takes a lyrics folder that **From remote** created
  inside a work folder, such as
  `Lyrics - CHI_HANS - RJ00000001 - 20261008-153012`, for a separate work.
  When such a folder lay within the scan depth, the scan attached it to the
  edition it names and lost the work folder that holds it. The next scan
  restores that work folder.
- Protected LLM translation includes explicit endpoint content boundaries,
  structured tag and keyword rules, preview invalidation, shared tag candidates,
  and background jobs for selected existing works.
- Accepted translations carry LLM provenance in language choices and cards,
  participate in search and sorting, and preserve manual/provider priority and
  field-specific fallback.

</details>

<details>
<summary><strong>Playback</strong></summary>

- Lyrics follow your metadata languages: a track uses the first of them that
  has lyrics, then the lyrics for every language, then another language, and
  the lyrics list names each file's language.

</details>

<details>
<summary><strong>Settings and interface</strong></summary>

- About lists its reference projects as compact credits, one line of project
  names per area. **Show details** adds what each project informed.
- Settings -> LLM lists the configured providers and adds or edits each one in
  a dialog. A provider's switch turns it on or off from the list, and deleting
  one asks for confirmation. The content safety policy edits sensitive tags as
  removable chips and keyword rules as compact rows.
- Settings -> Speech recognition configures OpenAI-compatible transcription
  services: OpenAI, a local deployment, or a custom service. A local
  deployment on the server's own machine is reached through the host gateway,
  so only its port is entered. The LLM content safety policy also decides
  which works' audio may be sent.
- The ellipsis between the page numbers below a list opens a field that goes
  to a typed page number.

</details>

<details>
<summary><strong>Demo</strong></summary>

- Insights in Demo shows a simulated listening history over the admitted
  works, with a notice that it is simulated. Demo records no listening, so the
  dashboard was empty there.
</details>

<details>
<summary><strong>Circles and voice actors</strong></summary>

- A voice actor's works are paged on the server. The search, the availability
  filter, and the chosen order apply across all of the voice actor's works
  before a page is returned, and selection covers the page on screen. The
  search matches like a plain Library search, including titles in other
  languages and voice actor names, and every edition of a work counts as one
  work.
- **Change cover…** in the **More** menu of a circle or voice actor's detail
  page chooses one of their works as their cover, on the tile and the detail
  summary. **Latest work** in the same dialog restores the cover that follows
  each new release. Each account keeps its own choice.
</details>

<details>
<summary><strong>Development and docs</strong></summary>

- Translation regression coverage includes protocol, policy, credential,
  preview, persistence, file publication and browser workflows; sensitive scans
  distinguish state references and exact credential-control copy from literals.

</details>
