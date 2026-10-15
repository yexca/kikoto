# Unreleased

> [!IMPORTANT]
> Migration 078 turns each enabled Follow a circle, series, or voice actor
> trigger into subscriptions of the account that configured it and deletes the
> follow triggers; their tag templates, release ranges, and work limits are not
> kept. A catalog that was already pulled becomes the subscription's baseline,
> so its existing works are not reported as new. Availability Watch loses its
> own schedule: the new subscription refresh takes over its interval (24 hours
> when it had none) and checks the watch after each refresh unless the watch
> was configured with its schedule off. Review **Refresh schedule** on the
> Subscriptions page after upgrading.

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
- **Check rating** in **Transcribe** and **Translate** shows the content
  safety class of the chosen track or lyrics file without sending anything,
  and marks the services that may not receive it. The check runs only when
  pressed.
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
- Settings -> LLM & ASR lists the configured LLM providers and ASR services
  above the content safety policy that governs both. Each service is added or
  edited in a dialog; adding one lists the presets on the left and the chosen
  preset's form on the right. A service's switch turns it on or off from the
  list, and deleting one asks for confirmation. The content safety policy edits
  tag rules as removable chips with per-tag actions and keyword rules as compact rows, and
  decides which works' text and audio may be sent.
- ASR and LLM share General, Sensitive and High sensitivity content levels.
  Each service declares its receive maximum separately from its data boundary.
  Tag and keyword rules can mark high-sensitivity content, while
  blocking rules refuse every service. High-sensitivity and blocking rules
  apply to all-ages works too; prechecks show matched rules and the chosen
  service's receive maximum. Existing settings retain their receive scope,
  and no service gains high-sensitivity permission automatically.
- The LLM & ASR tab stays behind an external service notice until an
  administrator accepts it: external services may forbid the content sent to
  them, the content safety checks are advisory, and Kikoto is not responsible
  for suspended accounts. The server refuses LLM and ASR configuration until
  then; services that are already configured keep working.
- ASR services are OpenAI-compatible speech recognition services: OpenAI, a
  local deployment, or a custom service. A local deployment on the server's
  own machine is reached through the host gateway, so only its port is
  entered.
- An LLM provider sets its request timeout, 10 minutes by default, so a local
  model has time to finish a translation. An Ollama provider can also set its
  context length and turn off thinking, which is on for a new Ollama provider.
  Kikoto constrains Ollama's output to the sent fields with one entry per tag
  or lyrics line, so a small local model cannot drop or merge lines.
- An LLM provider or ASR service offers several models from one connection,
  one of them the default. Translating and transcribing choose a provider and
  model, and the task keeps the model it started with, so changing the default
  or adding a model leaves queued work untouched. Model discovery for OpenAI
  speech recognition suggests only Whisper models.
- Kikoto Helper is an ASR service and an LLM provider preset. It reaches a
  Kikoto Helper on the server's machine through the host gateway, on ports
  17656 and 17657 by default, or on another machine by origin, with the API
  token the helper shows. Translation sends whole fields to the helper, which
  formats prompts and keeps line counts for its model. Fetching models from a
  helper without an installed model, a model that cannot translate between
  the chosen languages, and a model that is not installed or started each
  name their cause.
- The ellipsis between the page numbers below a list opens a field that goes
  to a typed page number.

</details>

<details>
<summary><strong>Demo</strong></summary>

- Insights in Demo shows a simulated listening history over the admitted
  works, with a notice that it is simulated. Demo records no listening, so the
  dashboard was empty there.
- Subscriptions in Demo shows a fixed sample feed and subscription list with
  fictional names, read-only.
</details>

<details>
<summary><strong>Subscriptions</strong></summary>

- A new **Subscriptions** page collects new works from the circles, series,
  and voice actors you subscribe to with the bell beside **Favorite** on their
  pages. Subscribing is separate from Favorite. A subscription starts from the
  catalog as it is, so existing works never flood the feed; a catalog that was
  not pulled recently is pulled first, now or at the next refresh.
- **New releases** lists one entry per work family, newest first, as a new
  release, a new language edition, or a work that Availability Watch found
  available. The navigation counts entries added since you last opened it, and
  a refresh that adds any sends one notification instead of one per work.
- A circle subscription includes its series: a series of a subscribed circle
  cannot be subscribed separately, and subscribing to the circle replaces its
  series subscriptions after a confirmation.
- One shared **Refresh schedule** (every 24 hours by default) pulls each
  subscribed catalog once, syncs the metadata of new works, and then checks
  Availability Watch. A subscription can also add its new works to
  Availability Watch.
- Availability Watch's configuration and pool move to the Subscriptions page;
  Workflows keeps its run history and links there.
- The Follow presets are renamed **Sync a circle catalog**, **Sync a series
  catalog**, and **Sync a voice actor catalog**, under a **Catalog sync**
  category, and run on demand only. Their triggers section links to
  Subscriptions, and the circle and voice actor **More** menus read **Sync this
  circle's catalog…** and **Sync this voice actor's catalog…**.

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
