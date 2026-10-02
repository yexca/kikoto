# Work Detail
[English](../en/work-detail.md) · [简体中文](../zh-Hans/work-detail.md) · [繁體中文](../zh-Hant/work-detail.md) · [日本語](../ja/work-detail.md) · [한국어](../ko/work-detail.md)

Work detail presents metadata, editions, file trees, source availability, and
playback actions for one work.

## Current Behavior

- Loads by work code and resolves translated DLsite-family routes.
- Shows cover, title, code, circle, tags, rating, voice metadata, and DLsite
  link.
- Shows known language editions for a logical work family.
- Keeps the metadata-language and directory-edition selectors as two separate
  compact chips beside the work code. Each chip names its current choice and
  opens its own list; an Origin directory edition reads `Origin · <language>`.
  The metadata chip becomes a read-only label when there is only one variant.
  Metadata defaults to the configured language priority for local works and the
  source request-language hint for remote-only works; a user's temporary switch
  changes the displayed title and provider tags without being persisted. The
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
- Wraps complete folder and file names in variable-height Browse and Tree rows,
  including long names without spaces, without horizontal page overflow.
- Keeps Browse breadcrumbs on one line. Mobile collapses intermediate ancestors
  into a menu while desktop bounds each visible segment; complete names remain
  available through rows, ancestor commands, titles, and accessible labels.
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
  lists collapse behind a `+N` control. The Directory fills the main column
  below. Source info and the metadata update time share one panel that stays
  beside the Directory on wide pages and follows it on narrower ones. Source
  info reports file/audio counts, size and duration coverage, and labels a
  metadata-duration fallback instead of silently replacing source duration.
  On compact screens, the Hero keeps the same credit line, tag row, stat
  strip, and actions above the Info and Directory tabs, Info shows the source
  panel, and Mark, List, DLsite, Metadata, and Source collapse to icons.
- Uses one two-line row for every directory file type on mobile and desktop,
  placing the complete name above type, precise audio duration, and size.
- Folds matched same-folder lyrics sidecars out of the default Browse and Tree
  rows while keeping unmatched text visible. Audio rows expose lyrics choice,
  preview, and reveal actions, and a directory control can show all folded
  lyrics. File management and Fetch selection continue to show the complete
  unfiltered tree.
- Lists naturally sorted folders before naturally sorted files in Tree and
  Browse. Folder playback follows that same visible order.
- Keeps available non-playable files such as images and text in Directory while
  counting audio and audio-bearing video together under the Playable source
  metric.
- Converts local and remote text previews to UTF-8 on demand, using byte-order
  marks, declared charsets, and automatic legacy-encoding detection without
  rewriting the source file.
- Reserves bottom scroll space while the desktop Compact player is active so the
  final queue action remains reachable.

## Actions

- Show one fixed Resume action. It is disabled without a positive unfinished
  work cursor; direct file activation starts from the beginning.
- Update quick listening status.
- Manage favorite-list membership.
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
