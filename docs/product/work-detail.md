# Work Detail

Work detail presents metadata, editions, file trees, source availability, and
playback actions for one work.

## Current Behavior

- Loads by work code and resolves translated DLsite-family routes.
- Shows cover, title, code, circle, tags, rating, voice metadata, and DLsite
  link.
- Shows known language editions for a logical work family.
- Separates the metadata-language selector from the directory-edition selector.
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
- Places the work code and DLsite link, title, circle, and series in a
  full-width desktop heading above the cover and metadata. Medium-width detail
  pages use two independent columns, with Voices, Tags, and personal tags
  flowing directly below the cover and source facts, version controls, and Hero
  actions flowing from the top of the second column.
  Wide detail pages use three columns for the cover, identity metadata, and
  source metadata. Notices and version controls span the two metadata columns
  immediately below their content, with Hero actions directly beneath them;
  the cover height does not push these controls downward. Source info reports
  file/audio counts, size and duration coverage, and labels a metadata-duration
  fallback instead of silently replacing source duration. On compact screens,
  voice credits remain visible above the primary actions while Mark, List,
  DLsite, Metadata, and Source collapse to icons.
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
- [Source presence](../architecture/source-presence.md)
