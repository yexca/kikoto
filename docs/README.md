# Kikoto Documentation

Kikoto is a personal audio library and player for locally stored audio works, with metadata enrichment and a mobile-friendly playback experience.

## Contents

- [Getting Started](./getting-started.md)
- [Configuration](./configuration.md)
- [Architecture](./architecture.md)
- [API Reference](./api.md)
- [Frontend](./frontend.md)
- [Data Model](./data-model.md)
- [Roadmap](./roadmap.md)
- [Contributing](./contributing.md)

## Current Status

Kikoto currently supports:

- Docker-first local development.
- SQLite-backed work, media, source, workflow, and metadata tables.
- Local folder scanning with configurable scan depth.
- DLsite metadata sync and cover caching.
- Library cards and work-code detail routes.
- Library pagination and circle browsing/detail routes.
- Voice actor browsing/detail routes with favorite, user tag, alias review, and
  merge undo support.
- Local directory trees and local audio streaming with range support.
- Settings-based file source, local scan depth, and cache configuration.
- Configurable compatible remote source browsing, source availability checks,
  remote work sync, cache, and fetch actions.
- Shared work-card actions across Library, Circles, and Voices for DLsite,
  remote sync, remote fetch, and quick marks.
- Workflow definition, scheduled trigger, and run activity workbenches.
- Parent bulk remote workflow runs for selected remote sync/fetch actions.
- RBAC auth with dev-mode root login and admin user management.
- Quick listening marks and per-track persisted playback progress.
- A global custom audio player dock with queue, volume controls, and progress restore.

Kikoto does not yet support persisted queue restore, asynchronous download
queues, workflow retry controls, large bulk action queueing, or full workflow
recovery.
