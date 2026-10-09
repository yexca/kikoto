# Browsing performance validation

The browse and playback performance suite is a set of opt-in synthetic
experiments for the Library list, direct work-code links, and playback startup.
It reports latency percentiles, query plans, and resource counters so a change
can be compared against its base revision on the same machine. It is a
measurement tool, not a CI gate.

## Contract

No experiment asserts a latency budget or threshold. An experiment fails only
when a response breaks its functional contract: an unexpected HTTP status, a
list page with the wrong entry count or total, a wrong work identity, a Range
response other than 206 with exactly 4,096 bytes, a compatibility Range that is
not served as `audio/mpeg`, or a browser workflow that never reaches its
rendered or `playing` state.

Every experiment is skipped unless its environment variable is set, so
ordinary CI never runs them. Behavior regressions belong to the normal suites
(`make ci-backend`, `make ci-frontend`, `make frontend-e2e`). Test-only control
routes such as `/api/perf/...` exist only inside the experiment's server and are
never application routes.

## Fixture and conditions

`testfixture.SeedBrowse` gives the SQL and HTTP experiments identical records:
400 reserved synthetic works, each with 20 audio items (8,000 in total), one
canonical edition, one available local presence, and a work-code-only metadata
snapshot, plus one synthetic user and session. Each measured group starts from
a fresh file-backed database migrated through the packaged migrations. HTTP
experiments use the production four-connection pool and access policy over a
real loopback server. Workflow jobs, the statistics worker, the card-summary
worker, and metadata synchronization do not run during a measurement.

Two planner states are explicit rather than incidental:

- **Statistics** are either missing (`ClearBrowseStatistics` empties both
  `sqlite_stat1` and `sqlite_stat4`, and pooled connections are reopened) or
  refreshed through `storage.OptimizeStatistics`.
- **Card summaries** are either missing or populated. HTTP experiments run the
  real backfill to completion; SQL experiments insert the equivalent rows.

Requests use the Origin metadata language, an unmarked personal state, an empty
query, recent descending order, page 1, and recommendation badges off. Three
warm-up requests precede each measured group, so SQLite pages, OS file cache,
and HTTP keep-alive are warm; there is no list-response cache.

The fixture does not model rich metadata, large edition families, NAS or
offline storage, physical mobile devices, audio output latency, real network
bandwidth, jitter or loss, multi-hour recordings, mixed video and encoding
load, or peak process memory.

## Running

Run the targets from the repository root, one at a time, on an otherwise idle
host:

```text
make browse-performance
make browse-production-performance
make playback-performance
make recommendation-performance
make recommendation-performance RECOMMENDATION_PERF_ARGS="--baseline <git-ref>"
```

`scripts/run-browse-performance.mjs` implements all three modes.

| Target | Runs |
| --- | --- |
| `make browse-performance` | `TestLibraryPagePerformance` (`internal/library`), then `TestBrowseMatrixPerformance` and `TestWorkCodeHTTPPerformance` (`internal/httpapi`), one package at a time with `KIKOTO_BROWSE_PERF=1`. |
| `make browse-production-performance` | Builds the frontend, starts a production `vite preview` on `127.0.0.1:3102` unless `PLAYWRIGHT_BASE_URL` names an existing preview, and runs `browse-production-performance.spec.ts` on desktop Chromium with one worker. |
| `make playback-performance` | Builds the frontend and runs `TestPlaybackStartupPerformance` with `KIKOTO_PLAYBACK_PERF=1`. The test serves the built assets itself and starts `playback-production-performance.spec.ts`. |
| `make recommendation-performance` | Runs the opt-in recommendation scale experiment over 50,000 and 100,000 synthetic works, 100 users, and 20 concurrent cold requests. |

The browser and playback targets require installed frontend dependencies and a
Playwright Chromium. Playback also requires `ffmpeg` and `ffprobe` on `PATH`.

## Experiments

### SQL phases

`TestLibraryPagePerformance` covers every combination of statistics state,
summary state, and `local` or `all` scope. For each, it times four independent
statements: the list COUNT, candidate filtering and sorting through the
production page CTE, an isolated page projection over 24 known ids, and the
full page query. Each stage takes 60 samples after three warm-ups and logs its
`EXPLAIN QUERY PLAN`.

### Library list over HTTP

`TestBrowseMatrixPerformance` uses the same combinations against complete
authenticated `GET /api/works` responses: page size 24 at concurrency 1 with 60
samples, and, with refreshed statistics and populated summaries, page size 100
(60 samples) and page size 24 at concurrency 8 (160 samples). Each group also
logs bytes per response, Go bytes allocated per request, pool wait count and
cumulative wait time, and throughput. Separate stage loops time the store list
(COUNT and page), title inputs, media selection, card projection and
enrichment, and connection acquisition.

### Direct work-code links

`TestWorkCodeHTTPPerformance` mirrors the client graph for a direct link: the
summary (`GET /api/works/{code}?includeMedia=false`) and directory
(`GET /api/works/{code}/media`) requests run in parallel against real
authenticated handlers, with populated summaries and refreshed statistics. On a
revision without code reads it measures resolve followed by numeric reads. It
runs with 0 ms and 200 ms of injected delay per request, 60 samples each, and
logs requests and bytes per operation.

`browse-production-performance.spec.ts` renders the same link with the
production build, real React rendering, and mocked application APIs. API
requests wait 0 ms or 200 ms, and source configuration waits three times as
long. Each delay takes 20 samples with cleared browser storage, blocked service
workers, and route interception that bypasses the HTTP cache. It records
summary and directory visibility, the first animation frame in which each
appears, per-request durations, detail request count, and click to `playing`.

### Playback startup

`TestPlaybackStartupPerformance` generates a five-second PCM WAV and a
300-second AAC file. It requests the first 4 KiB Range through:

- the authenticated media API: direct WAV (60 samples), compatibility AAC with
  a changed source revision per sample (12 samples), and compatibility AAC with
  a reused prepared MP3 (60 samples);
- the playback handlers behind the production static handler, adding the
  secured remote-source proxy against a loopback upstream with a 200 ms delay
  (60 samples).

Two isolated experiments follow: transcode-slot acquisition while both slots
are held for 250 ms, and FFmpeg encoding of the 300-second track with its CPU
time and output size (12 samples each). The test then runs
`playback-production-performance.spec.ts`, which measures click to `playing` in
the production player against the real playback handlers on a single-track
queue (20 samples per kind, 12 for cold compatibility). It finishes with the
upstream request count and the prepared cache file count and bytes.

### Additional scenarios

`TestBrowsePerformance` (`internal/httpapi`) and `browse-performance.spec.ts`
are also gated by `KIKOTO_BROWSE_PERF=1` but are not part of a Make target.
The Go test includes resolve under a held write lock, the list during three cold
recommendation preparations, locally filtered remote pagination against a
delayed loopback source, and cold AAC preparation. The spec measures
controlled-latency browsing against the Vite development server. Run them
directly only when a change touches those paths.

### Recommendation scaling

The recommendation experiment uses the bounded
`testfixture.HighCardinalityWorkCodeAt` constructor, a file-backed migrated
database, and the production connection pool. Its 100 users span zero, 10, 100,
and 1,000 feedback works. Shared popular tags and creators exercise long posting
lists. Catalog preparation runs separately from measured user preparation;
normal GET requests consume only a fully published epoch.

Run candidate and baseline revisions sequentially on the same idle hardware
with identical fixture counts, feedback, seeds, filter cases, and connection
limits. The `--baseline` runner archives the requested revision outside the
workspace, copies the same harness and synthetic constructors, runs the
baseline followed by the working tree, and removes its owned temporary checkout.
`KIKOTO_RECOMMENDATION_PERF_WORKS` accepts comma-separated fixture counts and
defaults to `50000,100000`. All 100 fixture users have seeded feedback. By
default, 40 users prepare cold generations: 20 concurrent requests followed by
20 sequential requests, with five users per feedback density. Another 20
generations exercise retained-version storage. Set
`KIKOTO_RECOMMENDATION_PERF_PREPARED_USERS=100` for the optional larger cold
preparation stress case; storage reports name the number actually prepared.
The experiment reports cold preparation and warm-request p50/p95,
scored-work counts, read/write rows, derived storage by shared history,
generations and contexts, allocation/heap measurements, write contention and
connection waits, and candidate quality against affinity evidence. A count or
deep-page scan may grow with the matching library, and profile preparation may
grow with feedback; candidate scoring remains bounded independently of the
library size. Structural limits are 2,000 scored recall works, 500 stored prefix
rows per context, eight contexts per generation, and 100 ordinary page scores.
Report each measured counter's scope; a logical row counter or cumulative
allocation is not an SQLite page-read count or peak resident memory.

## Reading results

Go experiments log one line per group:

```text
<name> n=<samples> concurrency=<c> requests/sample=<r> errors=<e> p50=<ms> p95=<ms>
```

SQL phases log `sql/...` lines in the same shape plus `plan/...` lines.
Playwright specs print one JSON object per measurement with `name` or `kind`,
`n`, `errors`, `p50`, `p95`, and a `conditions` string. Percentiles are taken
from sorted samples after warm-ups.

- Compare a change only against its base revision, run sequentially with the
  same harness on the same machine. Record the OS, CPU, Go, Node, Playwright,
  and FFmpeg versions with the numbers.
- The complete HTTP response is the benefit gate. SQL phases and stage loops are
  independent experiments; they explain a result but are not additive spans of
  one request.
- Browser clocks and server clocks are separate and are never added together.
  A paint frame is a render frame, not display or audio output latency.
- Sub-millisecond values are coarse, especially with Windows timer resolution.
- Allocated bytes per request are GC-sensitive cumulative allocation, not peak
  memory. Pool wait time is cumulative across borrowers, not a per-request
  percentile.
- Measurements belong in the change's review discussion, not in reference
  documentation. See [Testing](testing.md) for fixture and privacy rules.
