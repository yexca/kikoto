# ADR-0003: SQLite First

## Status

Accepted.

## Context

Kikoto is a personal media library intended to run locally or in a small Docker
deployment.

## Decision

Use SQLite as the first durable database.

## Consequences

- The app is easy to run locally.
- Backups are simple file operations when writes are stopped.
- Query and migration design should avoid closing the door on future database
  portability.
