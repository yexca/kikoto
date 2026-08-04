# Overview

Kikoto is a local-first personal audio library for DLsite-style works. It joins
local folders, cached files, and Kikoeru-compatible remote sources under one
unified work model.

## Goals

- Keep a personal audio library browsable and playable from a web UI.
- Enrich local works with DLsite metadata and cover images.
- Treat local folders, cache entries, and remote sources as file availability,
  not separate work databases.
- Make background work visible through workflow runs and Activity history.
- Support mobile-friendly playback while keeping desktop library management
  efficient.

## Current Status

Kikoto currently includes:

- Docker-first backend and frontend.
- SQLite-backed work, media, source, workflow, metadata, and user-state tables.
- Local folder scanning by product code.
- DLsite metadata sync and cover caching.
- Library, work detail, circle, voice actor, settings, workflow, and activity
  pages.
- Kikoeru-compatible remote source browsing, availability checks, sync, cache,
  and fetch flows.
- User authentication, roles, favorite/listening state, and playback progress.
- A persistent browser player plus Android media-session integration.
- SQLite-backed priority jobs with resource lanes, retry state, notifications,
  and restart recovery for the supported workflow families.
- Fetch Activity with byte-level remote-transfer progress that distinguishes
  known totals from files whose size is not declared.
- Bounded remote media and cover downloads plus retention cleanup for
  unpublished staging left by failed or cancelled Fetch runs.
- Outbound source and metadata requests with explicit origin allowlists,
  per-hop redirect checks, credential stripping, DNS-pinned connections, and
  separate private-origin rules for administrator-configured LAN sources.

## Current Limits And Remaining Hardening

- The SQLite deployment model is single-instance; distributed worker execution
  is outside the current personal-deployment scope.
