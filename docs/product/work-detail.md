# Work Detail

Work detail presents metadata, editions, file trees, source availability, and
playback actions for one work.

## Current Behavior

- Loads by work code and resolves translated DLsite-family routes.
- Shows cover, title, code, circle, tags, rating, voice metadata, and DLsite
  link.
- Shows known language editions for a logical work family.
- Shows unavailable metadata-only editions without implying local playback.
- Renders a card-provided or code-resolved preview first, then loads base detail
  and the media tree as separate stages.
- Retains a known work id in card/history previews so Favorites and other
  collection routes cannot race Library loading against a redundant code
  resolution.
- Lazily indexes local media files only when the media stage needs a concrete
  tree. A completed empty scan is remembered until a library scan invalidates
  that state.
- Loads source availability through a backend aggregate check.
- Opens remote source trees lazily after availability is known.
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
- Places desktop Hero actions immediately after the title, then presents
  metadata as independent columns beside the cover: Voices,
  Tags, and personal tags are on the left; one combined DLsite info card and an
  active Source info card are on the right, followed by a full-width version
  selector. Source info reports file/audio counts, size and duration coverage,
  and labels a metadata-duration fallback instead of silently replacing source
  duration. On compact screens, voice credits remain visible above the primary
  actions while Mark, List, DLsite, Metadata, and Source collapse to icons.
- Uses one two-line row for every directory file type on mobile and desktop,
  placing the complete name above type, precise audio duration, and size.
- Reserves bottom scroll space while the desktop Compact player is active so the
  final queue action remains reachable.

## Actions

- Play local files.
- Update quick listening status.
- Manage favorite-list membership.
- Edit personal work tags separately from provider metadata tags.
- Sync metadata.
- Sync/cache/fetch from compatible remote sources.
- Opens Login before any Fetch preparation request when the current visitor is
  anonymous.
- Open source-specific Track, Fork, Fetch, Origin, cache, refresh, and file
  maintenance commands from the selected source's Hero Source menu.
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
Fetch path selection and file-management trees are derived only after their
corresponding Options command is selected.

## Related Docs

- [Library](library.md)
- [Sources](sources.md)
- [Playback](playback.md)
- [Source presence](../architecture/source-presence.md)
