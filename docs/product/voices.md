# Voices

Voice pages present persisted person and credit data.

## Current Behavior

- Lists voice actors from local provider credits and user-maintained person
  data with Local and Remote availability badges on each creator card.
- Uses server-paged, URL-backed list search and filters with shorter responsive
  creator cards, dynamic user-tag rows, Library-style pagination, and the latest
  known credited-work cover.
- Shows favorite, rating, note, and user tag state.
- Supports alias review, duplicate merge, and merge undo.
- Groups works with no provider voice credits under an `unknown` bucket.
- Shows Local and Remote availability badges followed by user tags on voice
  detail. Cache remains available to playback and filtering data, but is not
  presented as Local.
- Presents known and remote works with the same responsive grid and shared work
  cards as the Library.
- Loads person detail, known works, and remote matches independently. Remote
  source searches use bounded concurrency, while voice counts and user tags are
  aggregated in batches.
- Places Alias review and Sources actions beside the icon-only mobile Favorite
  control on voice detail. Each action opens an anchored popover on mobile and
  desktop; alias management remains permission-gated while alias viewing stays
  available. Mobile work search keeps one row and opens filter, column, and
  selection controls from a separate options sheet.
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
