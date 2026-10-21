# Work Detail
[English](../en/work-detail.md) · [简体中文](../zh-Hans/work-detail.md) · [繁體中文](../zh-Hant/work-detail.md) · [日本語](../ja/work-detail.md) · [한국어](../ko/work-detail.md)

Work detail presents metadata, editions, file trees, source availability, and
playback actions for one work.

## Multilingual titles

The editor's Title section lists Japanese, Simplified Chinese, Traditional Chinese, English, and Korean first, each in a full-width row. The original language has an `origin` badge, and the currently displayed metadata language has a `current` badge; both can appear on the same row. **Universal title** appears below them under **Advanced title options**, collapsed by default. Existing universal titles open those options automatically for editing or clearing. The hint explains that a universal title overrides provider titles in every language, while per-language manual titles take precedence; the edition and description stay the same. A row's own manual title is editable text; provider and inherited titles stay grey hints and are never saved unchanged. Each row names its current source and marks a manual or edited title. Save sends only changed fields and title languages; clearing an existing manual title, or choosing Revert on its row, removes that scope when you save, while clearing an inherited hint makes no change. The same editor opens from Metadata → Works.

The metadata language menu includes known editions, manual language titles and accepted translations marked **LLM**. An LLM choice changes metadata presentation on the same work; it does not add an official edition or media version. Original-language fallback preserves the declared origin language, including unknown origins. See [title and description precedence](../../architecture/data-model.md#manual-overrides-and-titles).

When DLsite has no record of a work and a remote source filled it, the detail notice says **Filled from a remote source** and lists which values each source filled. A remote title comes after DLsite in the title order and before the work's own title. It declares no language, so it adds no language choice and keeps its text unchanged; the title editor names its source.

For provider display, any non-original edition in the work family is a translation, including third-party translations. Only one leading DLsite language-edition label, such as `【简体中文版】` or `【ドイツ語版】`, is removed by its format. Labels such as `【ASMR】`, interior labels, and manual titles remain intact. Each edition entry keeps its own title, including unsupported languages. Raw provider titles and snapshots remain unchanged. Cards, detail, language choices, search results, and new playback queues share the display rule; all manual titles remain searchable. Introductions are rendered verbatim as plain text and follow the selected edition unless a manual description replaces them. A manual language without a matching edition uses the original introduction.

## LLM translation

Assessment follows the [content safety policy](settings.md#content-safety-policy).

Editors with metadata sync and library write permission open **Translate with LLM** from the metadata editor. Choose a provider and one of its models, a supported target language, and the fields to send. The target language starts as the interface language when the model translates into it from the work's original language, otherwise as a language the model supports; a language the model does not support is shown as unavailable. **Check content without sending** assesses this request using the configured policy mode. It displays the classification, matching field and rule identity without contacting the LLM. Configure rules and endpoint boundaries in [Settings → LLM](settings.md#llm-providers).

A synchronous preview lasts 15 minutes; a background preview lasts 24 hours. Reviews survive server restarts and belong to the initiating user and work. Accepting a preview rechecks source content, current permissions, policy version and provider configuration. A change invalidates it. Review lists expose proposed, accepted, rejected and expired previews. Confirmed title and description values retain LLM provenance separately from provider snapshots and manual overrides. Ordinary sync preserves them; a changed original field retires that field's translation. **Revoke** removes a translation from presentation, and **Restore** reuses a recorded value only while its source input still matches.

**Shared tag names** translates missing language names for existing shared tag concepts. Known manual, provider and reusable accepted names are skipped. Confirmation affects shared names across works, while tag IDs and work membership stay intact. Manual and provider names take precedence. Renaming, hiding or merging tags does not erase retained risk evidence.

Lyrics are translated from [Manage lyrics → Translate](#translate).

**Queue background translation** accepts 1–100 explicitly named existing works. Equivalent submissions reuse a durable task. If a completed task's preview has expired or has been reviewed, submitting again starts a new task and keeps the earlier Activity record. Activity exposes progress, cancellation, restart recovery and failures. Execution rechecks permissions, source input, policy and the selected endpoint. Completed chunks are retained. Definitive rejections and failures before sending support an explicit retry to the same configured endpoint. A request with an uncertain result stops without automatic resending; **Resend uncertain request** requires explicit acknowledgement that another charge may occur. A changed endpoint, model, policy or input prevents that resubmission. Results always wait for user review.

## Transcribe

**Manage lyrics → Transcribe** turns the speech of local tracks into timed lyrics with a configured [speech recognition service](settings.md#asr-services). The tab lists the work's local audio files with the languages each one has lyrics in, grouped by folder. The filter above the list shows the tracks with **No lyrics**, which it starts on, the tracks without lyrics in the work's original language, or **All tracks**. Select tracks, or every listed track from the head of the list, and the bar at the bottom chooses the **Audio language**, the **Lyrics language**, the service and model; **Transcribe** queues one transcription per selected track. The audio language is the language spoken in the audio. It starts as the work's original language and is sent to the service as a hint; **Detect automatically** lets the service decide. The lyrics language is the language the result is saved and assigned in. With **Same as audio language**, which starts on, it is the audio language, and detected speech is saved as fallback lyrics. A model that translates, such as Kikoto Helper's model that writes Simplified Chinese from Japanese speech, writes its own lyrics language instead: choosing it sets the audio language to its source, turns **Same as audio language** off, and sets the lyrics language to what it writes. Turning **Same as audio language** off lets you choose another lyrics language; **Transcribe** stays unavailable, with a note below the bar, while the chosen model does not write that language from the audio language. The shared [content safety policy](settings.md#content-safety-policy) checks the work's metadata against the service's receive maximum, without inspecting the audio itself. **Check rating** beside the filter shows the work's class without sending anything and marks the services that may not receive it; the check runs only when you press it. A track already being transcribed is not queued twice, and a track's row shows the state of its open transcription.

Transcription is an Activity workflow. Kikoto decodes the track itself and sends it in parts of at most five minutes of 16 kHz mono audio, each cut at the quietest moment of its last minute so a cut falls between words. Each finished part is kept, and the workflow hands the queue to other waiting work between parts, so a long track does not hold up scans or Fetch. Before every part, Kikoto checks again that the service settings, the content policy, your permissions and the audio file are unchanged. A request interrupted by a restart, or a part the service rejects, stops the transcription; **Retry** in Activity continues after the last finished part and sends the interrupted part again. Cancelling the run stops it.

The finished transcription waits in the list below the tracks. **Preview** shows its first lines with the same timing check as other lyrics. **Add to lyrics** saves it as a WebVTT file in the language's lyrics folder inside the track's work folder, under the track's own path, such as `lyrics_kikoto/ja/mp3/Track 01.vtt`, and assigns it to the track. A different file or a folder already at that name is kept, and the transcription is saved beside it with a numbered name. A file or folder Kikoto did not create where the lyrics folder, or a folder inside it, belongs stops **Add to lyrics** until you rename or move it; the transcription is kept. **Discard** drops a transcription that is not wanted. If adding to the lyrics does not finish, the result is kept and **Add to lyrics** tries again.

Demo shows this tab with sample transcriptions of the work's tracks and an example service. It sends no audio, **Preview** shows sample text, and **Check rating**, **Transcribe**, **Add to lyrics** and **Discard** are unavailable.

## Translate

**Manage lyrics → Translate** translates the lyrics of local tracks with a configured [LLM provider](settings.md#llm-providers). The tab is a table of the work's local tracks against the lyrics languages. A green cell has lyrics in that language and a red cell has none; the **Fallback** column shows a dash where a track has no fallback lyrics, since fallback lyrics are not a translation target. **Languages** at the top right chooses the columns shown. Click a red cell to create that language for the track, or a language's header to select every track that lacks it. Each selected track translates from its lyrics in the work's original language, then its fallback lyrics, then its first other language, and that cell is marked as the source; click another green cell in the row to translate from that file instead. A cell whose translation is running or waiting for review shows its state and cannot be selected again. The bar at the bottom chooses the provider and model, and **Translate** queues one translation per selected cell. A column the chosen model cannot translate into is marked, as in [LLM translation](#llm-translation), and its cells cannot be selected. The track must have a local file in a work folder, and that work folder receives the translation. A remote lyrics file that matches a track by name counts as its fallback lyrics and is marked with a cloud; translating it requires administrator opt-in and remote fetch permission. The content safety policy is the one [LLM translation](#llm-translation) uses, and it checks the complete lyrics before anything is sent. **Check rating** runs that check on every lyrics file in the shown columns without sending anything, marks each green cell with its class, counts the classes, and marks the providers that may not receive the selected sources; the check runs only when you press it.

Translation is an Activity workflow that sends the lyrics in bounded parts and keeps each finished part. LRC, WebVTT, SRT, standard ASS dialogue and plain text keep their timing and cue order; only the text of each line is translated. Input and output are limited to 128 KiB, 4,000 source lines and 4,096 bytes per text line. A part the provider rejects, or a work folder that is briefly unavailable, can be retried from Activity. A request interrupted by a restart has an unknown result; **Resend** sends it again after you acknowledge that another charge may occur. A change to the lyrics, the provider settings, the content policy or your permissions stops the translation, and it must be started again.

The finished translation waits in the list below the table for 24 hours and belongs to whoever started it. **Preview** shows its first lines with the same timing check as other lyrics. **Add to lyrics** checks the lyrics file, the policy and the provider again, then saves the translation in the target language's lyrics folder inside the track's work folder, under the track's own path with the original file's extension, such as `lyrics_kikoto/zh-hans/mp3/Track 01.lrc`, and assigns it to the track in that language. The original lyrics file is never changed. A different file or a folder already at that name is kept, and the translation is saved beside it with a numbered name. A file or folder Kikoto did not create where the lyrics folder, or a folder inside it, belongs stops **Add to lyrics** until you rename or move it; the translation is kept. **Discard** drops a translation that is not wanted. If adding to the lyrics does not finish, the result is kept and **Add to lyrics** tries again without contacting the provider.

Demo shows this tab with sample translations of the tracks that have lyrics and an example provider. It sends no lyrics, **Preview** shows sample text, and **Check rating**, **Translate**, **Add to lyrics**, **Discard** and **Resend** are unavailable.

## Editing metadata

The Hero **Metadata** button opens the editor directly. **Refresh metadata**
is at the bottom left and runs the usual DLsite refresh. When an enabled remote
source supports metadata, the adjacent arrow opens `From <source name>`
choices. Selecting one requests fresh metadata for this work from that source;
manual edits and DLsite values keep their precedence, and unsaved editor drafts
remain in place. This explicit refresh does not require automatic remote
fallback to be enabled.

**Fetch for edit** opens a private comparison for the current work with Current,
Fetched, and Expected save columns. The language scope offers All languages and
the actual available editions, marking the canonical edition as Original. Using
a fetched value accepts provider metadata and removes an older manual override;
changing the expected value saves that field as a manual override. The preview
expires and cannot be applied after the work changes.
Tags can be merged by stable metadata tag identity. Accepting a fetched DLsite
family is a separate action; saving ordinary fields does not add sibling
editions to the library.

Admin and super_admin can edit work metadata with `library:write`. Save sends only fields changed from the initial editor values; selecting a cover alone preserves automatic titles, circles, series, and voice credits. Clearing a field resets only its override. Existing frozen title overrides that exactly match a trimmed DLsite title in the same family are removed during upgrade; circle, series, and voice overrides are kept.

The editor groups fields into Title, Cover, Tags, Credits, and Metadata source sections; a dot marks each section with unsaved changes, and the footer lists them. Every change stays a draft until Save, including Revert on a manual circle, series, voice actor list, or cover and a new or removed metadata link, so switching sections never loses an edit. Cancel asks before discarding drafts. Circle, series, and voice actors offer suggestions that link a known entry; their identifiers stay visible beneath the name and remain editable under Edit IDs. Covers are picked from a thumbnail grid of the work's local images. Ctrl+Enter saves.

Below the language titles, the Title section has a **Description** field for the work's introduction in every language. It starts from the introduction the work currently shows and accepts several lines. Saving changed text stores a manual description that replaces provider and LLM introductions in every edition and survives metadata refreshes; keeping or clearing an inherited introduction saves nothing. Clearing a manual description, or choosing its Revert, restores the provider introduction when you save. The field does not need **Fetch for edit**, so a work without provider metadata can still have an introduction.

The Title section's **Age rating** chooses All ages, R15, or R18 and names the provider's rating. A manual rating fills in a rating the provider does not give, such as for a custom work or a product DLsite no longer lists, or makes the provider's rating stricter; ratings less strict than the provider's cannot be chosen. The work shows its manual rating, is found by it in the Library, and is assessed by it for [content safety](settings.md#content-safety-policy), unless the provider's rating is stricter. Revert removes the manual rating when you save.

The **Metadata language** strip above the sections chooses the language the editor shows: **All languages**, then Japanese, Simplified Chinese, Traditional Chinese, English, and Korean, whether or not the work has an edition in them. **More** opens the work's editions in other languages, including an original edition whose language is not declared; choosing one selects the tab and names it, such as `More - German`. Titles and tag names are saved only in the five listed languages, so an edition under More shows its provider title and each tag's default name. In one of the five languages, the Title section shows that language's row and the Tags section shows each tag by its name in that language; a tag with no name in that language is greyed and shows the name it falls back to, and its language button opens that language's name with the all-language name. The work family list shows the editions in the selected language. The tags on a work, its cover, and its credits are the same in every language.

The Tags section searches shared metadata tags, adds or removes them for this work, and can create a custom tag even when the work has no DLsite metadata. Restore DLsite tags clears the work’s tag additions/removals. Shared names follow your preferred metadata language, using manual names and learned genre names; a Japanese-only work can show a known Chinese tag name. After background updates complete, hidden tags remain absent everywhere. Personal “My tags” are separate account-owned tags. Demo shows the editor read-only.

The work's tags form a list below the Add tag field, one row per tag with its names in other languages beneath it; a tag added to this work is marked **Added**. Each tag's language button opens its names inside the row, with separate rows for its all-language name and each supported language: a manual name is editable text and a provider or learned name stays a grey hint. Tag names are shared, so a renamed tag changes on every work that has it; the panel shows how many works share it. A new custom tag keeps the typed name as its all-language name and can receive names for other languages before it is created. Name edits are drafts like every other change and are written when you save.

New custom names remain drafts until Save creates or reuses the shared tag and attaches it to this work in one transaction. Cancel leaves no shared entry. A name matching any known language after trimming and ignoring case reuses that tag, so repeated clicks and duplicate names do not create duplicate concepts.

Switching metadata language uses that version’s manual or dictionary tag names when available, then falls back to your preferred language. Every version shows the same tags, taken from the original edition, so switching renames tags without adding or dropping any. Additions, removals, final-target hiding, and merge mappings still apply. Snapshot-only tags stay visible until their own projection completes; removing every tag produces an intentionally empty display.

A Japanese-only work shows its tags in a preferred language once the background **Learn tag names** workflow has learned those names; until then a tag falls back to its Japanese name. Its title stays Japanese.

Completion shows merged names as their final tag. A hidden match, including a merge into a hidden target, is labelled and cannot be added; unhide it in Metadata first. Names follow the language precedence described in [Settings](settings.md).

Until a background update finishes, the work keeps its last saved tag set, including an empty set, even when metadata refreshes. The voice actor page’s list of remote works shows remote tags alongside manually added shared tags.

## Custom works

A [custom work](settings.md#metadata) has no provider metadata and no remote source. Its detail shows no DLsite link, rating, sales, or metadata notice, and offers no metadata refresh, remote source tabs, or source checks; the directory lists only its local folders. The metadata editor has no **Fetch for edit** and no Metadata source section, so a custom work takes no metadata link, purchase bonus parent, or bundle contents; its title, description, age rating, cover, tags, and credits are edited by hand. **Edit files** and the **Lyrics files** tab of **Manage lyrics** list only local folders and editions. When its folder is missing, the directory explains that a scan finds the work again once a folder's name carries its KT code in brackets, such as `[KT00000001]`. Its cover is one of its local images; resetting the cover shows the work code in its place.

## Purchase bonuses

A purchase bonus, such as an early purchase bonus (`【早期購入特典】`), is its own DLsite product with its own files, but DLsite does not say which work it belongs to. Metadata sync can link it to that parent work (see [purchase bonuses](settings.md#purchase-bonuses)), and a library editor can enter or remove the parent's code under **Purchase bonus** in the editor's Metadata source section. A linked bonus stays a separate work: it keeps its own title, cover, files, playback progress, and library card, and takes the tags, voice actors, and series it lacks from the parent. Its detail shows **Bonus for** with the parent work, or the parent code with a DLsite link when the parent is not in the library, and the parent's detail lists its **Bonuses** that are in the library, including bonuses linked to another edition of its family. The parent code never becomes a library work. Removing the link also stops automatic detection for that work, and the next refresh drops the inherited values.

## Bundles

An official bundle, such as a complete pack (`コンプリートパック`) or a set, is its own DLsite product that contains works also sold on their own. DLsite names the contents of only some bundles, and metadata sync lists those automatically. For the others, a library editor lists the works under **Bundle contents** in the editor's Metadata source section: enter a work code, or add one of the works from the bundle's DLsite series that the section suggests when the title looks like a bundle (**Show** reveals them otherwise). The changes apply on Save. A bundle's detail shows **Includes** with its works, and each work's detail shows **Included in** with the bundle; a code that is not in the library shows with a DLsite link. Searching the Library for a work's code or title also finds the bundles that include it. The bundle and each of its works stay separate works with their own files, playback progress, and library cards, and a work in a bundle never plays from the bundle's files. A work you remove is not listed again by metadata sync.

## Current Behavior

- Loads by work code and resolves translated DLsite-family routes.
- Shows cover, title, code, circle, tags, rating, voice metadata, and DLsite
  link.
- Shows known language editions for a logical work family.
- Keeps the metadata-language and directory-edition selectors as two separate
  compact chips beside the work code. Each chip names its current choice and
  opens its own list; an Origin directory edition reads `Origin · <language>`.
  On a phone the code and both chips stay on one line: a chip names a language
  by its code (`JA`, `EN`, `SC` for Simplified Chinese, `TC` for Traditional
  Chinese, `KO`), and an Origin directory edition reads `Origin`. The lists
  keep full language names.
  The metadata chip becomes a read-only label when there is only one variant.
  Metadata defaults to your preferred metadata language for local works; for
  remote-only works it defaults to the first of your languages the source
  describes, then to the source's fallback language. A temporary switch
  changes the displayed title and tag names without being persisted. The
  Origin variant is always listed first while the configured default remains
  selected.
- Treats directory editions as file availability, not metadata availability.
  In a persisted local context, the collapsed selector shows only editions with
  local folders or local media; the disclosure expands it to all known editions.
  A remote sibling is selectable only when that source reports it in its own
  database; a locally available sibling remains selectable through its local
  directory even when the selected remote source does not contain it. Remote
  contexts default to source-reported availability instead.
- Shows metadata-only, remote-only, and unavailable editions without implying
  local playback.
- Renders a card-provided or code-resolved preview first, then loads base detail
  and the media tree as separate stages.
- Retains a known work id in card/history previews so Favorites and other
  collection routes cannot race Library loading against a redundant code
  resolution.
- Uses one responsive page composer for persisted and remote-only identity
  controllers. Both share Back, Hero, mobile Info/Directory, desktop Directory,
  and modal placement without granting remote-only previews persisted state.
- Treats the mobile Back control as Up to the last server-and-user-scoped
  Library list location, while wide layouts retain the source-aware history
  return.
- Lazily indexes local media files only when the media stage needs a concrete
  tree. A completed empty scan is remembered until a library scan invalidates
  that state.
- Coalesces concurrent indexing of the same media-bearing work and reduces the
  first-index database statements per file. Slow collection and write phases
  are logged separately for diagnosis.
- Loads source availability through a backend aggregate check.
- Opens remote source trees lazily after availability is known. An explicit
  persisted remote-source route can load its identified source before an
  aggregate Check and marks a successful load available in the current detail.
- Wraps complete folder and file names in variable-height directory rows,
  including long names without spaces, without horizontal page overflow.
- Keeps the directory breadcrumb on one line. Mobile collapses intermediate
  ancestors into a menu while desktop bounds each visible segment and keeps the
  current folder scrolled into view; complete names remain available through
  rows, ancestor commands, titles, and accessible labels.
- Offers the selected source's actions in one place: inline in Source info on
  wide pages and in the Info tab on compact screens, and as a Source menu in
  the Hero action bar in between. The menu's icon changes for Local, Tracked,
  and remote contexts, its header names the selected source, and it closes on
  outside interaction, Escape, or a source change.
- Aggregates tracked presences into one Tracked tab. When a work is tracked by
  more than one file source, the tab exposes a dropdown that switches the
  active tracked directory without adding source names to the tab row.
- Uses the selected tracked source name in the Directory description and keeps
  the selection in the detail URL.
- Opens with a Hero whose background is tinted from the cover. Beside the
  cover it shows the work code with the DLsite link and language chips, the
  title, circle, and series, a CV credit line, one tag row, a compact stat
  strip (rating, age rating, sales, release date, and playable duration; one
  row on phones), any metadata notice, and bottom-aligned Hero actions. The
  tag row lists provider tags first and then the user's personal tags in a
  distinct accent style, ending with the add or edit icon; long provider tag
  lists collapse behind a `+N` control. Selecting a provider tag or a personal
  tag adds a `tag:` or `mytag:` clause to the library search the detail was
  opened from; a personal tag selected after opening the detail from another
  page starts a new local library search. The Directory fills the main column
  below. Source info and the metadata update time share one panel that stays
  beside the Directory on wide pages and follows it on narrower ones. Source
  info reports file/audio counts, size and duration coverage, and labels a
  metadata-duration fallback instead of silently replacing source duration.
  A Credits card below that panel lists the staff DLsite credits besides the
  voice actors: author, scenario, illustration, music, and other staff. It
  shows only the roles the work credits and is absent when DLsite names no
  staff. Selecting a name adds a `staff:` clause to the library search the
  detail was opened from, which finds the name in any staff role.
  On compact screens, the Hero keeps the same credit line, tag row, stat
  strip, and the labeled Resume, Mark, and List actions above the Info and
  Directory tabs. Info shows the source panel, which lists the selected
  source's actions and offers Edit metadata beside the metadata update time,
  and the Credits card. A phone shows at most three lines of the title; tapping a
  shortened title shows all of it. The button at the end of the work code row
  hides the work details and leaves the work code, any metadata notice, and
  the actions. The choice is remembered on that device and holds for every
  work opened there.
- Presents Directory as one panel: a header with the file summary and source
  checking, underline source tabs with status dots, and a folder explorer.
  When the directory is wide enough and the work has folders, a sticky folder
  column sits beside the selected folder's contents; otherwise a Folders button
  opens the same navigator as a bottom sheet on phones or a popover elsewhere.
  **Hide folder panel** in the column's header gives the contents the full
  width and leaves **Show folder panel** beside the Folders button; the choice
  is remembered on that device.
  The navigator lists naturally sorted folders with their playable or image
  counts, opens small trees completely and larger ones toward the selected,
  recommended, and playing folders, merges a folder that holds only one
  subfolder into a single row, and marks the recommended folder and the folder
  that is playing.
- Opens on the folder recommended by the folder routing rules. The contents
  toolbar shows an up control and breadcrumb, the folder's track count and
  duration, a Recommended badge (or a command that returns to the recommended
  folder), the folded-lyrics count, and a Play all command for the current
  folder's playable files.
- Groups a folder's contents into subfolder tiles, an album-style track list,
  an image gallery, documents, and other files, labelling the groups when more
  than one is present. Subfolder tiles summarize what they contain and offer a
  direct play command when they hold playable files. Tracks are numbered in
  folder playback order with the complete name above size and the work's
  resume position, and precise duration in a trailing column; they show a play
  cue on hover and mark the current track with an accent row and a live icon.
  The resume marker follows playback saves without reloading. Local and cached
  images show lazily loaded thumbnails; remote images load only when previewed.
- Folds matched same-folder lyrics sidecars out of the default directory rows
  while keeping unmatched text visible. Audio rows expose lyrics choice,
  preview, and reveal actions, and a directory control can show all folded
  lyrics. File management and Fetch selection do not fold lyrics.
- Shows a local file or folder by its display name in the first of your
  metadata languages that has one, and by its real name otherwise. While a
  directory has such names, a **Display names** button sits at the top right
  of Directory, highlighted while they show; its tooltip says that they are
  not the real file names, and turning it off shows the real names. The choice
  is remembered on that device, and a renamed entry keeps its real name in its
  tooltip. The player, its queue, screen lyrics, and the system media controls
  name tracks the same way and follow the same choice. Queued tracks take the
  new names when you change your metadata language or names are saved, without
  interrupting playback. The real
  names still decide the order, track numbers, the recommended folder, and
  lyrics matching, and file management, Fetch, previews, and downloads use
  them. A user with library write access edits the names from the local
  source's **Edit display names** option, one language at a time: an empty
  field shows the real name, a file keeps its own extension, and **Copy real
  names** and **Paste names** move the whole list out and back in, one name
  per line. A file or folder that **Edit files** moves keeps its names; one
  renamed outside Kikoto loses them.
- The local source's **Manage lyrics** option lists every local audio file
  with a lyrics choice. A user with library write access can assign any local
  lyrics file of the work, including translated lyrics whose names do not
  match the audio, or align a lyrics folder to the tracks by track number (or
  by position when both folders hold the same number of files). Each row
  previews the first lines and warns when the last timed line starts after the
  track ends. Assignments are shared by every listener and become the Auto
  choice; a listener's own choice still takes priority.
- A track keeps one assigned lyrics file per language. The **Lyrics language**
  strip switches between **Fallback** and Japanese, Simplified Chinese,
  Traditional Chinese, English, and Korean, and shows how many tracks have
  lyrics in each. **Fallback** lyrics are used when none of a listener's
  languages has lyrics, and only there does a track without an assignment fall
  back to a file-name match. Playback uses the first of a listener's metadata
  languages that has lyrics, then the fallback lyrics, then any other language.
  You declare a file's language yourself; Kikoto does not guess it from the
  file.
- **Manage lyrics** has a **Lyrics files** tab for users who manage local files.
  Kikoto manages the lyrics in one `lyrics_kikoto` folder inside a work folder,
  in a folder named after their language: `ja`, `en`, `zh-hans`, `zh-hant`,
  `ko`, or `fallback` for fallback lyrics, such as `lyrics_kikoto/ja`. Kikoto
  marks the `lyrics_kikoto` folder it creates as its own. A lyrics folder the
  work ships, such as `lyrics`, is one of the work's files: its lyrics are
  listed under **Other lyrics in this folder**, and Kikoto never adds lyrics to
  it or deletes from it as managed lyrics. A `lyrics_kikoto` folder that Kikoto
  did not create, or a file of that name, stops lyrics from being added until
  you rename or move it. The tab edits them in three
  columns, like **Edit files**: the places lyrics can come from on the left, the
  lyrics files of the chosen place in the middle, and the managed lyrics as they
  will be on the right. When the work has several local folders, the right
  column chooses the one to edit.
- The places are **Managed lyrics**, where clearing a file deletes it; **Other
  lyrics in this folder**, whose selected files are copied into a lyrics folder
  and stay in their own place, or move there when **The work's own files** is
  set to **Move into lyrics_kikoto**; the choice starts on the administrator's
  [default](settings.md#library), which copies unless changed; the
  work's other local folders, including other editions in the library, whose
  files are copied; and the editions that configured remote sources offer, whose
  files are downloaded. Selected files go to the lyrics folder of the language
  chosen under **Language of these lyrics** for their place. Another edition's
  lyrics start in that edition's language; Kikoto does not guess the language of
  the work's own files, so you choose it before anything is previewed. To change
  the language of managed lyrics, turn on **Also list the managed lyrics, to
  change their language** in **Other lyrics in this folder** and select them
  there; they move to their new language even while copying. A file keeps its path below its place, without the lyrics folder it may
  already be in.
- The right column previews the result. A file that is already there with the
  same content is left alone. A different file with the same name is a conflict
  you resolve in that column: keep the existing file, replace it, keep both, or
  rename the incoming file; nothing has to be deleted first. Folders and files
  in the way are handled as in **Edit files**. **Apply changes**
  asks for confirmation before it deletes files. With library write access,
  **Assign added lyrics to matching tracks** assigns each added file in its
  language to the track it matches by file name, then by track order; a track
  that already has lyrics in that language keeps them. Assignments that already
  use a moved file follow it to its language; a copied file is a new file, and
  the work's own file keeps its assignments. A remote edition you read from is
  not added to the library.
- **Manage files** on a local work has **Manage as lyrics** for lyrics that are
  elsewhere in the work folder. Select `.lrc`, `.vtt`, `.srt`, `.ass`, `.ssa`, or `.txt`
  files and choose it to open **Lyrics files** with those files selected under
  **Other lyrics in this folder**.
- **Manage files** hides the lyrics Kikoto manages by default when **Manage
  lyrics** is available for the work. A **Lyrics managed by Kikoto** row
  counts them and opens **Manage lyrics** on its **Lyrics files** tab. Its
  **Show in the list** switch lists them with the other files, where they are
  selected like any file. While they are hidden, selecting the whole work
  folder for deletion includes them; any smaller selection leaves them in
  place.
- **Manage lyrics** has a **Transcribe** tab for users with library write and
  workflow permission when a [speech recognition
  service](settings.md#asr-services) is configured. See
  [Transcribe](#transcribe). Demo shows it with samples.
- **Quick select** in **Manage files** selects files by location or format.
  On a local work it also has **Find identical files**, which compares
  the local files of every edition and folder of the work by content, so a
  translated edition's renamed audio is recognized as the original's. A file
  with an identical copy is marked with the copy's location, and two
  selections appear: **Also in another folder** selects the listed files that
  exist elsewhere with the same content, and **Repeated in this folder**
  selects every copy except the first inside the listed folder. Files that
  only resemble each other, such as the same track encoded again, are not
  identical and are not marked. Nothing is deleted until you review the
  deletion.
- **Manage files** on a local work has **Edit files** for users who manage
  local files. It edits the listed folder in three columns. **Sources** lists
  **This folder**, every other local folder of the work's editions, and every
  edition a configured remote source was last found to offer. **Check sources**
  beside **Remote**, for users who may check sources, asks every remote source
  that answers again about each edition of the work and refreshes the list.
  **Select** shows the files of the
  chosen place: clearing a file of this folder removes it, and selecting a
  file anywhere else adds it. **Final folder** shows the folder as it will be
  and marks each file as kept, removed, moved, copied, downloaded, replaced,
  or already there; a file just selected shows as checking until the preview
  includes it. It is arranged like a file manager: drag a file or folder onto
  a folder to move it there, drag files or folders from the middle column onto
  a folder to add them there, which leaves the middle column as it is, and use
  **New folder** or a folder's menu to create, rename, and delete folders.
  Each row's menu also has **Move to**, for touch screens and keyboards.
  Deleting a folder that holds something asks first, then moves what it held
  up one level. A name already taken where a file or folder lands gets a
  number, such as `01 (2).mp3`. A file you clear gives up the place you moved
  it to, so selecting it again returns it to its own path. When two files
  would still end up at one path, the edit names that path and waits until you
  move or clear one of them. A moved file keeps its playback progress,
  lyrics, and other references. Folders the edit empties are removed, and
  folders you create stay even when empty. Kikoto's `lyrics_kikoto` folder is
  arranged only through lyrics roles, so a dragged selection that holds it is
  not dropped. Files from another local folder are
  copied, and that folder is left unchanged unless **Merge into this folder**
  is on for it. The switch turns on once the folder's files have loaded, and a
  folder on an offline storage pool is never merged. A merged folder takes all
  its files when none are selected yet,
  and once this folder holds what the edit copies, the merged folder is
  deleted with everything it still holds. Files from a remote edition are
  downloaded, which also
  needs permission to fetch, and the edition is not added to the library. A
  lyrics file (`.lrc`, `.vtt`, `.srt`, `.ass`, `.ssa`, or `.txt`) from another place
  can be added as lyrics instead of at its own path: choose a language under
  its name, or for all selected lyrics files of the place under **Selected
  lyrics files**, and it goes to that language's folder inside
  `lyrics_kikoto`, as in **Lyrics files**. You declare the language; Kikoto
  does not guess it. With library write access, **Assign added lyrics to
  matching tracks** assigns each added lyrics file in its language to the track
  it matches by file name, then by track order, including tracks the same edit
  adds; a track that already has lyrics in that language keeps them. A
  file that would land on a different file of the same name is a conflict:
  keep the file in the folder, replace it, keep both, or rename the incoming
  file. A folder or link already at that name is never replaced, so only the
  other choices are offered. A file where a folder of the incoming path belongs
  leaves only keeping that file or renaming the incoming file to another path.
  **Apply changes** asks for both deletion confirmations when files are
  removed. With a merged folder it first compares every file of the merged
  folders by content with the folder as it will be, lists each file that has
  no identical copy there and is lost when its folder is deleted, and asks
  again before deleting; files downloaded from a remote source are not
  compared. Metadata that a NAS or the system keeps beside files, such as
  `@eaDir` folders and `Thumbs.db`, is not compared and goes with the merged
  folder. When a merged folder or this folder changes after the comparison,
  the edit is not applied and asks you to review the merge again. The edit runs
  as one Activity workflow that collects every added file before it removes,
  moves, or adds anything, removes a file only while it is unchanged since you
  applied the edit, and deletes a merged folder last, only if it still
  holds exactly the files the review listed, unchanged, and every file the
  review found a copy of still has that identical copy in this folder;
  otherwise it stops and asks you to review the merge again. A stopped edit
  that you retry continues where it stopped. A merged folder of a
  work that a Fetch is still filling is not merged. The
  directory reloads when it finishes.
- A work whose code a scan finds in several local folders keeps all of them.
  The directory then shows one folder per copy, **Manage files** lists one
  folder at a time with a **Folder** choice, and the work can be forgotten
  only once a single folder is left. A library manager sees a notice above the
  directory when the work is in several folders or another edition of it is in
  the library, with **Manage lyrics** and **Manage files** to bring the lyrics
  into one folder and remove what is identical.
- Lists naturally sorted folders before naturally sorted files. Folder playback
  follows that same visible order.
- Keeps available non-playable files such as images and text in Directory while
  counting audio and audio-bearing video together under the Playable source
  metric.
- Opens previews in a file viewer that steps through the folder's files of the
  same kind with header controls, arrow keys, swipes on phones, or an image
  filmstrip. Images sit on a dark stage that fits the window or shows actual
  size around the clicked point with drag panning, and report their
  dimensions; video uses the same stage. Text opens in a reading view, and LRC,
  WebVTT, and SRT files show time-stamped lines, with LRC header tags and a Raw
  text toggle, parsed the same way as the player's lyrics. The viewer offers
  Copy for text, Download for local and cached files, and Set cover for local
  images, which takes a second click to confirm and resets after a few seconds
  or on another image. It fills the screen on phones and opens above the
  floating desktop player.
- Converts local, cached, and remote text previews to UTF-8 on demand, using byte-order
  marks, declared charsets, and automatic legacy-encoding detection without
  rewriting the source file.
- Reserves bottom scroll space while the desktop Compact player is active so the
  final queue action remains reachable.

## Actions

- Show one fixed Resume action. It is disabled without a positive unfinished
  work cursor; direct file activation starts from the beginning.
- Update quick listening status.
- Manage favorite-list membership. The List button names the list that holds
  the work; when several do, it names the first in list order and counts the
  rest, and its tooltip names them all. **Add list** creates a list inside the
  List menu and selects it; **Save** applies membership alongside existing
  choices.
- Edit personal work tags separately from provider metadata tags.
- Sync metadata.
- Sync/cache/fetch from compatible remote sources.
- Fetch records the selected source as available when it is accepted and reuses
  an existing queued or running Fetch for the same canonical work.
- Opens Login before any Fetch preparation request when the current visitor is
  anonymous.
- **Fetch** on a remote source of a work that has a local folder opens
  **Edit files** on that source's edition, for users who may manage local
  files and fetch. For those users, a work without a local folder opens a
  Fetch into a new folder in the same three columns: the source's edition
  comes first with all its files selected, the work's other editions,
  sources, and local folders can add files, and lyrics files can be added as
  lyrics of a language with track assignments, as in **Edit files**. Its
  **Final folder** is arranged as in **Edit files**, except that a folder
  holding no file is not created. The edition's own files are one Fetch.
  Everything else is added by an
  **Edit files** workflow once the Fetch has published the folder, so a file
  that would land on one the Fetch publishes is a conflict to resolve first.
  While a storage pool it reads or writes is offline, it waits and starts
  once the pool is back. If it cannot be queued at all, the Fetch's run in
  Activity says why, and the folder keeps only the Fetch's files.
  When the destination folder needs review, **Review in the standard Fetch**
  opens the Fetch dialog. Anyone else gets the Fetch dialog.
- Open source-specific Track, Fork, Fetch, Origin, cache, refresh, and file
  maintenance commands from the selected source's Hero Source menu.
- Track the selected remote source, persist its browsable tree, and open the
  corresponding source inside the aggregated Tracked context without requiring
  a second Fork.
- Edit manual overrides when available.
- Link the work's metadata to another DLsite code from the metadata editor,
  for example when a bonus edition is no longer sold and the regular edition
  has a different code. Metadata refreshes then read the linked code and store
  its metadata, tags, and cover on this work; the linked code does not become
  a separate work. When the work's own code has no record, the unavailable
  metadata notice opens the editor directly.

## Detail Loading Model

Work detail should prefer known local database state first, then load slower
remote-derived state separately:

1. Route preview from any work-card surface, or a lightweight code resolve for
   direct URLs.
2. Basic work metadata, user state, editions, and credits.
3. Local media and directory tree.
4. Source availability summary.
5. Selected remote source tree, if the user opens one.

This keeps remote source failures from blocking the local detail shell.
The directory stage uses a stable, directory-shaped skeleton. A media error
replaces only that skeleton and leaves the loaded metadata and actions intact.
Fetch path selection and file-management trees are derived only after their
corresponding Options command is selected.

## Related Docs

- [Library](library.md)
- [Sources](sources.md)
- [Playback](playback.md)
- [Source presence](../../architecture/source-presence.md)
