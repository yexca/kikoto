# Stack and Packages

The backend stack, the internal package map, and the layering rule between HTTP composition and domain code.

## Stack

- Go standard `net/http`.
- SQLite.
- Embedded SQL migration catalog and generated fresh-install baselines in
  `backend/migrations/` (see [Migrations](../../development/migrations.md)).
- Docker-first runtime.

## Main Packages

- `backend/internal/httpapi`: HTTP handlers and feature orchestration.
- `backend/internal/account`: user identity, password credentials, sessions,
  and role permission expansion.
- `backend/internal/accesspolicy`: the stored anonymous-access policy and its
  cached effective value.
- `backend/internal/library`: persisted work browsing: search parsing, list
  queries and projection, batch enrichment, and recommendation sessions.
- `backend/internal/record`: the independent record root marker, folder and
  asset scanner, safe path resolution, artwork selection, streaming,
  per-user playback progress, and moving deleted files to the record trash.
  Record assets never enter the work or media-item identity model.
- `backend/internal/demorecord`: the sample Record library Demo generates
  with bounded `ffmpeg` runs, which never serves or replaces a folder holding
  anything it did not make.
- `backend/internal/storagepool`: storage pool layout below the data root and
  the marker that distinguishes an online pool from an empty mount point.
- `backend/internal/localfs`: local folder discovery.
- `backend/internal/download`: the bounded atomic download writer, cover
  publication, and raster image type detection.
- `backend/internal/dlsite`: DLsite client and parsing. Its product decoder
  accepts both array and numeric-keyed object forms of `language_editions`,
  and splits comma-separated provider language values when family sync matches
  an edition or its availability status.
- `backend/internal/kikoeru`: Kikoeru-compatible client, including the
  account and SQLite readers used by personal data import.
- `backend/internal/metasync`: metadata sync.
- `backend/internal/filesource`: reading stored file sources: a
  `file_source` row with its endpoint, the decoded and normalized
  `config_json` and allowed host patterns, and the API URL fallback a client
  uses. A stored setting that does not decode is reported on the record, never
  replaced with defaults; see [File Availability](../data-model/file-availability.md).
- `backend/internal/remotemetadata`: remote source metadata ordering,
  bounded snapshot decoding, and reconciliation for the opt-in fallback.
- `backend/internal/metadatatags`: shared metadata tag concepts, projection,
  and selection, independent of provider snapshots and personal tags.
- `backend/internal/contentpolicy`: shared deterministic ASR/LLM content
  assessment and service receive maxima, plus the separate Demo admission policy.
- `backend/internal/llm`: bounded translation protocols, endpoint configuration
  and lyrics templates. HTTP composition
  binds these to work identity, review persistence, file scope and workflow jobs.
- `backend/internal/asr`: speech recognition service configuration, the
  OpenAI-compatible transcription protocol, timed segments rendered through
  `timedtext`, and quiet cut points between transcription chunks.
- `backend/internal/timedtext`: the reader of lyrics and subtitle text (LRC,
  WebVTT, SubRip, ASS and SSA) as timed lines or WebVTT, and the WebVTT
  writer; see [Timed Text](media-playback.md#timed-text).
- `backend/internal/kikotohelper`: the Kikoto Helper task endpoints shared by
  `asr` and `llm`: the info probe, the translation task path and the helper's
  error codes.
- `backend/internal/metadatatitles`: display-title selection from edition,
  declared remote, and manual titles without changing provider data.
- `backend/internal/outbound`: the shared outbound transport policy, forward
  proxy dialing, and proxy failover.
- `backend/internal/proxyconfig`: outbound proxy configuration validation and
  per-scope proxy resolution.
- `backend/internal/storage`: database opening and migrations.
- `backend/internal/sqlutil`: shared `database/sql` helpers with no application imports.
- `backend/internal/textvalue`: shared string helpers with no application
  imports.
- `backend/internal/modellist`: validation of the enabled and default models,
  shared by `asr` and `llm`.
- `backend/internal/languageedition`: the key reader of the numeric-keyed
  `language_editions` object, shared by `dlsite` and `kikoeru`.
- `backend/internal/workflow`: workflow persistence helpers, lease-based
  settlement of orphaned jobs, and release of jobs interrupted by a service stop
  (recoverable jobs requeue from their checkpoint, others fail).
- `backend/internal/personal`: account-owned tag changes, durable listening
  history, and transactional personal data transfer.

## Code Organization

HTTP handlers own transport concerns: authentication context, request decoding,
response encoding, and status mapping. Reusable domain state transitions,
filesystem transactions, source adapters, and workflow persistence should move
behind focused packages or services as they become independently testable.

Avoid adding unrelated orchestration to already broad handler files. Extract by
cohesive behavior rather than moving a large file mechanically, and keep
dependencies directed from HTTP composition toward domain and storage code.
