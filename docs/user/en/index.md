# User Guide

[English](index.md) · [简体中文](../zh-Hans/index.md) · [繁體中文](../zh-Hant/index.md) · [日本語](../ja/index.md) · [한국어](../ko/index.md)

These pages describe installation and user-visible behavior. If a change affects
what users see, what actions are available, or how a workflow is named, update
the English page first, then mark translations for review.

- [Library](library.md)
- [Work detail](work-detail.md)
- [Sources](sources.md)
- [Circles](circles.md)
- [Voices](voices.md)
- [Playback](playback.md)
- [Settings](settings.md)
- [Workflows](workflows.md)

## Product Principles

- A work appears as one unified item even when it has local, cache, tracked, and
  remote source availability.
- Local and cached state should remain usable when remote sources fail.
- Remote source actions should be explicit: sync updates source data, cache
  materializes cache files, and fetch promotes selected files into the local
  data tree.
- Long-running or reviewable actions should be visible in Activity.

## Related Docs

- [Core boundaries](../../architecture/core-boundaries.md)
- [Source presence](../../architecture/source-presence.md)
- [Frontend guidelines](../../development/frontend-guidelines.md)
