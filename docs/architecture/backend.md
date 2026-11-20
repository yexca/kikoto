# Backend

The backend is a Go HTTP API with SQLite persistence. It authenticates users,
scans libraries, syncs metadata, browses remote sources, prepares media for
playback, runs persisted workflow jobs, and makes outbound requests under one
transport policy. Each page below is self-contained; open only the one the
change touches.

| Page | Open this when you change or need |
| --- | --- |
| [Stack and Packages](backend/stack-and-packages.md) | the Go stack, which `internal/` package owns a concern, or the layering rule |
| [Runtime Responsibilities](backend/runtime-responsibilities.md) | what the process does at runtime, duration probing, planner statistics, or job runner limits |
| [Media Playback](backend/media-playback.md) | loudness, transcode slots and failure memory, the playback decision, audio tracks, subtitles, playback location order, queue restore and Resume queues, or how lyrics and subtitle text is read |
| [HLS Encoding](backend/hls-encoding.md) | remux keyframe indexes, HLS encode lifetime and limits, or hardware video encoding |
| [API Shape](backend/api-shape.md) | work, lyrics, custom work, library list, or recommendation endpoints, or the access-policy middleware |
| [HTTP Responses](backend/http-responses.md) | playback reports, listening history, static caching, compression, error shape, or request budgets |
| [Outbound Requests](backend/outbound-requests.md) | the outbound transport policy, proxies, request lanes, or remote caches and covers |
| [Work File and Folder Edit APIs](backend/work-edit-apis.md) | lyrics edit, duplicate detection, bundle members, folder edit, or the Fetch follow-up |

## Related Docs

- [Workflows](workflows.md)
- [Data model](data-model.md)
- [Backend guidelines](../development/backend-guidelines.md)
