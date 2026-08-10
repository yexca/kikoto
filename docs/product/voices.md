# Voices

Voice pages present persisted person and credit data.

## Current Behavior

- Lists voice actors from local provider credits and user-maintained person
  data.
- Uses server-paged, URL-backed list search and filters with responsive creator
  cards, Library-style pagination, and the latest known credited-work cover.
- Shows favorite, rating, note, and user tag state.
- Supports alias review, duplicate merge, and merge undo.
- Groups works with no provider voice credits under an `unknown` bucket.
- Shows `works`, `playable`, `local`, and `remote` counts in one compact line on
  voice detail. Playable is the distinct union of canonical works available
  locally, from cache, or remotely.
- Presents known and remote works with the same responsive grid and shared work
  cards as the Library.
- Loads person detail, known works, and remote matches independently. Remote
  source searches use bounded concurrency, while voice counts and user tags are
  aggregated in batches.
- Places Alias review and Remote Sources actions beside Favorite on voice
  detail. Each action opens an anchored popover on mobile and desktop; alias
  management remains permission-gated while alias viewing stays available.
- Treats the mobile detail back control as Up to the last
  server-and-user-scoped Voice Actors list location, including when the detail
  was opened from Library or Favorites. Wide layouts keep the source-aware
  history return.

## Boundary

DLsite remains a metadata provider for known works. Kikoto does not treat DLsite
keyword crawling as a reliable voice actor catalog.

## Review Behavior

Alias and merge tools should preserve user state and keep merge undo visible
when duplicate person records are consolidated.

## Related Docs

- [Library](library.md)
- [Work detail](work-detail.md)
- [Data model](../architecture/data-model.md)
