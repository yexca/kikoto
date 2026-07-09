# Core Boundaries

## Unified Work Identity

A work exists once in the database. Local folders, remote sources, cache files,
and tracked state describe availability for that work; they do not create new
work identities.

The primary identity key is currently a normalized DLsite-style `primary_code`,
such as `RJ0123456`.

## Metadata Sources

Metadata sources answer:

```text
What is this work?
```

Examples:

- DLsite metadata.
- Manual user overrides.
- Future metadata importers.

Metadata belongs in work, metadata snapshot, tag, party, person, credit, and
edition tables.

## File Sources

File sources answer:

```text
Where can this work be played, cached, or fetched?
```

Examples:

- Local folders.
- Kikoeru-compatible remote sources.
- Cache files.

File availability belongs in source presence and media file location tables.

## User State

User state is separate from provider metadata and file availability. Listening
marks, favorites, tags, notes, and playback progress should survive source
replacement and metadata refreshes.
