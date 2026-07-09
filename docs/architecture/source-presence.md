# Source Presence

Source presence records source-level facts about a work.

## Presence Types

- `local`: a local folder scan found a durable local work folder.
- `source`: a configured non-local source reported or can provide the work.
- `tracked`: the user intentionally kept the work/source relationship.

## Boundaries

`work_source_presence` should not be used as a concrete file tree. Concrete
stream URLs, download URLs, cache files, and local paths belong in
`media_file_location`.

Remote source availability checks should create or update `source` presence.
User actions such as mark, track, sync, cache, or fetch may create tracked state
or concrete locations.

## Outages

If a source is offline during a batch check, Kikoto updates source health and
skips per-work checks for that source. A source outage should not mark every
candidate work as missing.
