# Browsing performance validation

Measured on 2026-10-08 against baseline commit `9d35985c` and the accompanying
working-tree change. These are isolated synthetic experiments on Windows,
not production measurements. Go 1.26.4 (windows/amd64), Node 24.19.0, npm
11.17.0 and FFmpeg `N-124448-g7e045dfbfc-20260513` were used. Baseline and
changed runs used the same machine and harness, sequentially, without another
test or build running during the measurements. The baseline ran in a disposable
archive of the commit, with only the measurement harness copied into it.

## Changes and bounds

- Committed scans, metadata synchronization, indexing, tracking and Fetch
  publication notify one statistics worker. A one-second settle window merges
  bursts; subsequent passes have a 30-second cooldown. Each automatic pass has
  a five-second context budget, samples at most 400 rows per index, and yields
  to a busy SQLite writer within 100 ms. Failed passes retry through the same
  cooldown. Connection pragmas are restored, and shutdown cancels maintenance.
- Resolve GET uses persisted aliases and editions, with a read-only fallback
  for a legacy snapshot's declared origin. Ingestion and synchronization own
  relationship writes. Repeated resolution no longer queues title projections.
- Summary and directory requests start together after resolution. A summary
  renders independently and survives directory errors. Edition redirects,
  cancellation, obsolete responses and principal-scoped media caching remain
  covered. Explicit local routes start the list with restored browse controls
  while source configuration loads.
- Cold recommendation preparations queue before borrowing a connection, with
  one writer and at most 32 active or queued requests. Warm sessions stay reads;
  cancellation releases a place and overflow returns a retryable 503.
- Locally filtered remote browsing caches upstream pages for 30 seconds, at
  most 32 pages / 16 MiB serialized data. Pages above 2 MiB bypass retention.
  Keys include user, full source configuration and invalidation generation,
  language, query/filter plan, sort, direction, seed and upstream page. Local
  tags, marks, availability and scores are recomputed for every request.
  Configuration is checked before and after page access. Cache misses use the
  existing outbound policy and bounded request lanes.

Work identity remains `primary_code`; discovery does not create works.
Metadata and file-source roles, publication filesystem boundaries, Range,
audio cache quota, publication locks and the global player are unchanged.

## Authenticated HTTP measurements

`TestBrowsePerformance` creates a file-backed database through the packaged
migrations, using the production four-connection pool, production access
policy, a synthetic authenticated session and a real loopback HTTP server.
There are 400 deterministic synthetic works and 8,000 media items, with local
presence, canonical edition rows and small metadata snapshots. List pages have
24 entries. Timings include reading the complete HTTP response body.

Ordinary scenarios use 60 samples, concurrency 1, and three warm-up requests.
The concurrent list uses 160 samples and concurrency 8. The write-lock resolve
uses 60 samples. The cold-recommendation scenario uses 20 samples, one held
writer and three cold session requests; each sample sends four HTTP requests
and measures the ordinary list 50 ms after starting the three preparations.
The write transaction is released after 250 ms.

All scenarios completed with **0 errors**. Each measured API operation uses
one client request, except the four-request interference scenario.

| Scenario | Baseline p50 / p95, ms | Changed p50 / p95, ms |
| --- | ---: | ---: |
| List, statistics missing | 110.88 / 151.80 | 106.46 / 116.08 |
| List, explicitly refreshed statistics | 79.21 / 86.14 | 80.32 / 85.94 |
| Refreshed list, concurrency 8 | 480.01 / 625.52 | 487.15 / 679.58 |
| Summary, media excluded | 2.54 / 7.54 | 2.03 / 5.26 |
| Directory | <0.01 / 4.01 | <0.01 / 2.57 |
| Resolve | <0.01 / 6.21 | <0.01 / 1.03 |
| Resolve, held 250 ms write lock | 334.09 / 335.68 | 1.03 / 1.20 |
| List during three cold recommendation preparations | 286.83 / 292.52 | 83.16 / 88.05 |

Missing-statistics scenarios deliberately do not start the maintenance worker;
refreshed scenarios call the same `OptimizeStatistics` directly to isolate
planner state. Worker timing, burst merging, retry and cancellation are covered
separately by deterministic tests. No GET runs analysis. Sub-millisecond
numbers include timer quantization and should not imply microsecond precision.

The submitted statistics conclusion was reproduced in direction and query
plan, but its absolute 31 / 4 ms API numbers were not reproduced. In this
fixture, explicitly refreshing statistics reduced baseline list p50 from
110.88 to 79.21 ms. `LoadMediaSelections` p95 fell from 6.57 to 0.51 ms over
60 samples. Without statistics, EXPLAIN starts at
`idx_media_file_location_cache_lru`, then finds each media item by rowid;
after refresh, it starts at `idx_media_item_work`, then uses
`idx_media_file_location_item_source_type` for its locations.

Warm ordinary-list throughput has **no demonstrated improvement**. Its
concurrent p95 increased in this run; no throughput claim is made. Diagnostics
over ten samples put the changed page query at 77.19 / 84.43 ms, availability
at <0.01 / 2.00 ms, titles at <0.01 / 0.50 ms, and 24 cover lookups at
1.58 / 2.09 ms. The page query remains the main server-side list cost.
Scope-predicate and media-join experiments gave no measurable benefit and
were removed. Cover batching was not justified by these measurements.

## Remote pagination

The same authenticated fixture includes a configured loopback source returning
400 synthetic works. Every upstream response waits 40 ms. Filtering uses
personal tags, which cannot be pushed down. Sixty pagination pairs use distinct
seeds to keep page 1 cold; page 2 immediately follows page 1. Concurrency is 1,
and error rate is 0. Statistics are refreshed; local response caches are warm.

| Scenario | Baseline p50 / p95, ms | Changed p50 / p95, ms | Upstream requests per sample, before / after |
| --- | ---: | ---: | ---: |
| Plain list, 60 samples | 42.95 / 44.02 | 42.03 / 42.76 | 1 / 1 |
| Local filter, cold page 1 | 183.18 / 185.27 | 176.68 / 177.51 | 4 / 4 |
| Same filter, page 2 | 183.20 / 185.11 | 13.01 / 14.70 | 4 / 0 |

Each row still uses one client API request. Across 60 pairs, upstream requests
were 240 + 240 before and 240 + 0 after. Cache eviction, expiry, cancellation,
viewer/configuration/language/filter/seed isolation, source invalidation and
fresh personal-tag reads have regression coverage. Upstream metadata can lag
by 30 seconds; a large catalog can exceed cache capacity and miss again.

## Controlled browser latency

Playwright uses the same deterministic mock application in both versions:
every API response waits 200 ms, source configuration waits 600 ms, and the
synthetic five-second WAV response waits 200 ms. Principal-scoped browser
storage is cleared on each navigation. Twelve samples are taken for a known
work and twelve for a direct code link; playback therefore has 24 samples.
Concurrency is 1 and all workflows succeed. This measures actual rendered
controls and the audio element's `playing` event, with a Vite development
server; it does not combine real backend timings with real weak-network traffic.

| User-visible milestone | Baseline p50 / p95, ms | Changed p50 / p95, ms |
| --- | ---: | ---: |
| Navigation to local list visible | 1425 / 1454 | 908 / 923 |
| Known-work click to summary visible | 364 / 411 | 372 / 408 |
| Known-work click to directory operable | 558 / 605 | 376 / 412 |
| Direct navigation to summary visible | 1383 / 1400 | 1369 / 1406 |
| Direct navigation to directory operable | 1387 / 1404 | 1373 / 1410 |
| Playback trigger to `playing` | 250.5 / 283.4 | 254 / 264 |

Known detail uses two API attempts in both versions; direct detail uses four
attempts in this development harness, including the StrictMode-aborted resolve
attempt, followed by resolve, summary and media. Parallelization does not
reduce request count. The list and known-work directory improve visibly.
Direct links have no clear improvement in this final run; earlier runs varied
substantially and the development-server rendering tail remains unaddressed.
Summary alone and playback after clicking also have no clear speed improvement.
The theoretical removal of one summary-to-directory
network wait is about 200 ms in this fixture; the table contains measured
values, not that estimate.

## Audio preparation and remaining production coverage

The authenticated HTTP harness requests the first 4 KiB Range of a synthetic
WAV and a 300-second AAC generated by FFmpeg. Direct and warm-cache scenarios
have 60 samples; incompatible cold AAC has 12 samples, each with a changed
file timestamp to prevent cache reuse. Concurrency is 1, one request per sample,
and error rate is 0.

| Scenario | Baseline p50 / p95, ms | Changed p50 / p95, ms |
| --- | ---: | ---: |
| Direct WAV Range | 0.52 / 0.53 | 0.51 / 0.54 |
| Cold AAC compatibility preparation | 695.09 / 699.54 | 705.31 / 714.45 |
| Warm compatible AAC Range | 0.51 / 0.52 | 0.51 / 0.60 |

The complete-file AAC preparation remains the cold cost. No new background
transcoding is introduced: preparing a whole unplayed queue would consume
encoder slots and cache quota without evidence of benefit. Existing next-track
audio preloading remains in place. Production-length recordings, NAS latency,
encoder contention, real bandwidth/jitter, production bundles and browser
output-device latency remain unmeasured. Further work should first measure
those scenarios and the remaining page-query cost.

## Reproduction and validation

Run from the repository root after installing frontend dependencies:

```powershell
$env:KIKOTO_BROWSE_PERF = '1'
cd backend
go test ./internal/httpapi -run '^TestBrowsePerformance$' -count=1 -v
cd ../frontend
npx playwright test tests/e2e/browse-performance.spec.ts --project=desktop-chromium --workers=1
Remove-Item Env:KIKOTO_BROWSE_PERF
```

The measurements are opt-in and contain no timing assertions in normal CI.
Behavioral regression checks run through `make ci-backend`, `make ci-frontend`,
`make ci-style`, `make frontend-e2e` and `make sensitive-check`. See
[Testing](testing.md) for fixture and privacy rules.

All those Make targets passed. Backend coverage was 69.2%, including the full
package and integration suite, followed by a passing race run. Frontend unit
tests passed 670 assertions in 121 files; browser regression passed 298 tests
with one opt-in performance test skipped. Dependency audits reported no called
Go vulnerabilities and no npm vulnerabilities; registry signatures verified.
The final diff passed the sensitive-change scan and `git diff --check`.
