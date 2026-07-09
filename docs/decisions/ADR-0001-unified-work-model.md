# ADR-0001: Unified Work Model

## Status

Accepted.

## Context

Kikoto combines local folders, cache files, and remote source data. Treating
each source as a separate library would duplicate works and make user state
fragile.

## Decision

Kikoto stores one unified work identity keyed primarily by normalized product
code. Sources attach presence, locations, metadata snapshots, or user state to
that work.

## Consequences

- User state survives source replacement.
- Remote sync and local scan must converge on the same work.
- Source-local ids cannot become primary work identities.
