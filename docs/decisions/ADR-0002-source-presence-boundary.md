# ADR-0002: Source Presence Boundary

## Status

Accepted.

## Context

Remote source checks can prove that a source knows about a work before Kikoto
has a concrete playable tree.

## Decision

Use `work_source_presence` for source-level facts and `media_file_location` for
concrete local, cache, stream, or download locations.

## Consequences

- Availability checks can update reusable source facts.
- Concrete playback still requires media item and location records.
- Source outages should update source health, not erase work identity.
