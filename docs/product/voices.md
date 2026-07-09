# Voices

Voice pages present persisted person and credit data.

## Current Behavior

- Lists voice actors from local provider credits and user-maintained person
  data.
- Shows favorite, rating, note, and user tag state.
- Supports alias review, duplicate merge, and merge undo.
- Groups works with no provider voice credits under an `unknown` bucket.
- Shows local, cache, remote, playable, and known work counts.

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
