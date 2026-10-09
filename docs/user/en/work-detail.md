# Work Detail
[English](../en/work-detail.md) · [简体中文](../zh-Hans/work-detail.md) · [繁體中文](../zh-Hant/work-detail.md) · [日本語](../ja/work-detail.md) · [한국어](../ko/work-detail.md)

Work detail presents metadata, editions, file trees, source availability, and
playback actions for one work.

## Multilingual titles

The editor's Title section lists Japanese, Simplified Chinese, Traditional Chinese, English, and Korean first, each in a full-width row. The original language has an `origin` badge, and the currently displayed metadata language has a `current` badge; both can appear on the same row. **Universal title** appears below them under **Advanced title options**, collapsed by default. Existing universal titles open those options automatically for editing or clearing. The hint explains that a universal title overrides provider titles in every language, while per-language manual titles take precedence; the edition and description stay the same. A row's own manual title is editable text; provider and inherited titles stay grey hints and are never saved unchanged. Each row names its current source and marks a manual or edited title. Save sends only changed fields and title languages; clearing an existing manual title, or choosing Revert on its row, removes that scope when you save, while clearing an inherited hint makes no change. The same editor opens from Metadata → Works.

Kikoto uses the first preferred metadata language that has its own manual title or DLsite edition. Its language-specific manual title wins, then the all-language manual title, then that edition’s title. An all-language title replaces only the text: the default edition, introduction, and tags stay the same as without it. `Origin` uses the original edition’s declared language; an unknown language is not guessed. If nothing matches, the original title is used. Circle, series, and voice-actor overrides remain shared across languages. An undeclared original language stays unknown everywhere, regardless of the metadata request locale; its language label shows only **Original**. A language-specific manual title takes effect for that declared language or when that manual language is explicitly preferred or selected. The language menu includes only existing editions and languages with their own manual title; an all-language title applies to existing options without adding a language.

When DLsite has no record of a work and a remote source filled it, the detail notice says **Filled from a remote source** and lists which values each source filled. A remote title comes after DLsite in the title order and before the work's own title. It declares no language, so it adds no language choice and keeps its text unchanged; the title editor names its source.

For provider display, any non-original edition in the work family is a translation, including third-party translations. Only one leading DLsite language-edition label, such as `【简体中文版】` or `【ドイツ語版】`, is removed by its format. Labels such as `【ASMR】`, interior labels, and manual titles remain intact. Each edition entry keeps its own title, including unsupported languages. Raw provider titles and snapshots remain unchanged. Cards, detail, language choices, search results, and new playback queues share the display rule; all manual titles remain searchable. Introductions are rendered verbatim as plain text and follow the selected edition. A manual language without a matching edition uses the original introduction.

## Editing metadata

The Hero **Metadata** button opens the editor directly. **Refresh metadata**
is at the bottom left and runs the usual DLsite refresh. When an enabled remote
source supports metadata, the adjacent arrow opens `From <source name>`
choices. Selecting one requests fresh metadata for this work from that source;
manual edits and DLsite values keep their precedence, and unsaved editor drafts
remain in place. This explicit refresh does not require automatic remote
fallback to be enabled.

Admin and super_admin can edit work metadata with `library:write`. Save sends only fields changed from the initial editor values; selecting a cover alone preserves automatic titles, circles, series, and voice credits. Clearing a field resets only its override. Existing frozen title overrides that exactly match a trimmed DLsite title in the same family are removed during upgrade; circle, series, and voice overrides are kept.

The editor groups fields into Title, Cover, Tags, Credits, and Metadata source sections; a dot marks each section with unsaved changes, and the footer lists them. Every change stays a draft until Save, including Revert on a manual circle, series, voice actor list, or cover and a new or removed metadata link, so switching sections never loses an edit. Cancel asks before discarding drafts. Circle, series, and voice actors offer suggestions that link a known entry; their identifiers stay visible beneath the name and remain editable under Edit IDs. Covers are picked from a thumbnail grid of the work's local images. Ctrl+Enter saves.

The Tags section searches shared metadata tags, adds or removes them for this work, and can create a custom tag even when the work has no DLsite metadata. Restore DLsite tags clears the work’s tag additions/removals. Shared names follow your preferred metadata language, using manual names and learned genre names; a Japanese-only work can show a known Chinese tag name. After background updates complete, hidden tags remain absent everywhere. Personal “My tags” are separate account-owned tags. Demo shows the editor read-only.

Each tag's language button opens its name in every language, with separate rows for its all-language name and each supported language: a manual name is editable text and a provider or learned name stays a grey hint. Tag names are shared, so a renamed tag changes on every work that has it; the panel shows how many works share it. A new custom tag keeps the typed name as its all-language name and can receive names for other languages before it is created. Name edits are drafts like every other change and are written when you save.

New custom names remain drafts until Save creates or reuses the shared tag and attaches it to this work in one transaction. Cancel leaves no shared entry. A name matching any known language after trimming and ignoring case reuses that tag, so repeated clicks and duplicate names do not create duplicate concepts.

Switching metadata language uses that version’s manual or dictionary tag names when available, then falls back to your preferred language. Every version shows the same tags, taken from the original edition, so switching renames tags without adding or dropping any. Additions, removals, final-target hiding, and merge mappings still apply. Snapshot-only tags stay visible until their own projection completes; removing every tag produces an intentionally empty display.

A Japanese-only work shows its tags in a preferred language once the background **Learn tag names** workflow has learned those names; until then a tag falls back to its Japanese name. Its title stays Japanese.

Completion shows merged names as their final tag. A hidden match, including a merge into a hidden target, is labelled and cannot be added; unhide it in Metadata first. Names follow the language precedence described in [Settings](settings.md).

Until a background update finishes, the work keeps its last saved tag set, including an empty set, even when metadata refreshes. The voice actor page’s list of remote works shows remote tags alongside manually added shared tags.

## Purchase bonuses

A purchase bonus, such as an early purchase bonus (`【早期購入特典】`), is its own DLsite product with its own files, but DLsite does not say which work it belongs to. Metadata sync can link it to that parent work (see [purchase bonuses](settings.md#purchase-bonuses)), and a library editor can enter or remove the parent's code under **Purchase bonus** in the editor's Metadata source section. A linked bonus stays a separate work: it keeps its own title, cover, files, playback progress, and library card, and takes the tags, voice actors, and series it lacks from the parent. Its detail shows **Bonus for** with the parent work, or the parent code with a DLsite link when the parent is not in the library, and the parent's detail lists its **Bonuses** that are in the library, including bonuses linked to another edition of its family. The parent code never becomes a library work. Removing the link also stops automatic detection for that work, and the next refresh drops the inherited values.

## Current Behavior

- Loads by work code and resolves translated DLsite-family routes.
- Shows cover, title, code, circle, tags, rating, voice metadata, and DLsite
  link.
- Shows known language editions for a logical work family.
- Keeps the metadata-language and directory-edition selectors as two separate
  compact chips beside the work code. Each chip names its current choice and
  opens its own list; an Origin directory edition reads `Origin · <language>`.
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
- Keeps one Source menu in the Hero action bar. Its icon changes for Local,
  Tracked, and remote contexts, its header names the selected source, and it
  closes on outside interaction, Escape, or a source change.
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
  On compact screens, the Hero keeps the same credit line, tag row, stat
  strip, and actions above the Info and Directory tabs, Info shows the source
  panel, and Mark, List, DLsite, Metadata, and Source collapse to icons.
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
  lyrics. File management and Fetch selection continue to show the complete
  unfiltered tree.
- The local source's **Manage lyrics** option lists every local audio file
  with a lyrics choice. A user with library write access can assign any local
  lyrics file of the work, including translated lyrics whose names do not
  match the audio, or align a lyrics folder to the tracks by track number (or
  by position when both folders hold the same number of files). Each row
  previews the first lines and warns when the last timed line starts after the
  track ends. Assignments are shared by every listener and become the Auto
  choice; a listener's own choice still takes priority.
- When a compatible remote source is configured, **Manage lyrics** also has a
  **From remote** tab for users who can download files. Pick a source and an
  edition of the work's family (a translated edition is chosen first, since
  DLsite usually ships lyrics with translations), list its lyrics files, choose
  which to download and which track each one belongs to, and preview them with
  the same timing check. The files are saved to a new folder named after the
  edition's language, its code, and the download time, for example
  `Lyrics - CHI_HANS - RJ00000001 - 20261008-153012`, inside the work folder.
  Kikoto never replaces an existing file or folder, then rescans the work and
  stores the chosen assignments. The edition you read from is not added to the
  library.
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
- Converts local and remote text previews to UTF-8 on demand, using byte-order
  marks, declared charsets, and automatic legacy-encoding detection without
  rewriting the source file.
- Reserves bottom scroll space while the desktop Compact player is active so the
  final queue action remains reachable.

## Actions

- Show one fixed Resume action. It is disabled without a positive unfinished
  work cursor; direct file activation starts from the beginning.
- Update quick listening status.
- Manage favorite-list membership. **Add list** creates a list inside the List
  menu and selects it; **Save** applies membership alongside existing choices.
- Edit personal work tags separately from provider metadata tags.
- Sync metadata.
- Sync/cache/fetch from compatible remote sources.
- Fetch records the selected source as available when it is accepted and reuses
  an existing queued or running Fetch for the same canonical work.
- Opens Login before any Fetch preparation request when the current visitor is
  anonymous.
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
