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
- Shows local, cache, remote, playable, and known work counts.
- Presents known and remote works with the same responsive grid and shared work
  cards as the Library.
- Loads person detail, known works, and remote matches independently. Remote
  source searches use bounded concurrency, while voice counts and user tags are
  aggregated in batches.
- On mobile detail views, all five work counts stay in one compact row. Alias
  review and Remote Sources start folded with count and health summaries, while
  desktop detail keeps both panels expanded.

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
