# Browsing performance validation

## 2026-10-09 follow-up: comparable list baseline

The follow-up baseline is `fa46210b`: PR #19 (`bf9b1b50`) integrated with
main (`6c1bd77b`), exclusively on the feature branch. The changed results below
use the accompanying query and direct-link changes. Both versions run on the
same Windows machine (Ryzen 7 9800X3D, 16 logical CPUs, 32 GiB RAM), Go 1.26.6,
Node 24.19.0, npm 11.17.0, Playwright 1.63.0 and the FFmpeg version recorded
in the historical report below. Runs are sequential; no additional build or
benchmark was started during a measurement. Desktop/OS activity is not
controlled, so small differences and encoding tails are not attributed to code.
The baseline is a disposable archive with the identical measurement files
copied in, rather than an unrelated checkout or dataset.

The module selects **Go 1.26.6** through its toolchain directive; Go 1.26.4
is the host launcher version. The final branch also integrates main's
`524c2526` maintenance-notification fix in signed merge `532107d7`. That change
does not alter backend measurement paths. The render comparison predates that
merge; the final production and workflow checks include it.

The earlier approximately 4.8 ms and 80 ms observations are **not a before/after
pair**. The checked-in recommendation benchmark uses default `scope=all`,
recommendation sorting, 32 KiB synthetic snapshots and no persisted edition
families. It times the page SELECT, without COUNT, enrichment or HTTP. PR #19's
HTTP report uses `scope=local`, recent sorting, persisted canonical editions,
small work-code snapshots and no card-summary worker/backfill. The exact
backfill state of the earlier ad hoc 4.8 ms observation is not recoverable
from its number alone. It must not be used as a throughput claim. The new
matrix controls each of these states explicitly and reproduces the scope
difference on one fixture.

`SeedBrowse` is shared by SQL and HTTP experiments: 400 reserved synthetic
works, 8,000 media items, one canonical edition and available local presence
per work, small `workno` snapshots and user 1. Every group starts a fresh
file-backed migrated database. Missing statistics means empty `sqlite_stat1`
and `sqlite_stat4` and reloaded pooled connections; refreshed statistics uses
`OptimizeStatistics`.
Missing summaries means no summary rows; populated summaries use the real
backfill to completion in HTTP (the exact `{v:1}` equivalent in SQL).
No jobs, statistics worker, summary worker or metadata synchronization run.
Metadata language preference is Origin, personal status is unmarked, query is
empty, recommendation badges are off, sort is recent descending, page is 1.
The production pool has four connections. Three warm-ups precede each HTTP
group; SQLite/OS pages and HTTP keep-alive are warm, with no list-response cache.

Each core group has **60 complete HTTP responses**, page size 24, concurrency
1, one request per sample and **0 errors**. Units are milliseconds, p50 / p95.

| Scope | Statistics | Card summaries | Before | After |
| --- | --- | --- | ---: | ---: |
| local | missing | missing | 97.73 / 130.01 | 33.48 / 39.10 |
| all | missing | missing | 34.60 / 39.75 | 34.73 / 42.47 |
| local | refreshed | missing | 78.44 / 97.03 | 6.71 / 8.52 |
| all | refreshed | missing | 6.01 / 8.55 | 5.58 / 8.27 |
| local | missing | populated | 107.42 / 148.29 | 33.97 / 44.85 |
| all | missing | populated | 43.27 / 50.89 | 33.56 / 44.09 |
| local | refreshed | populated | 105.53 / 109.96 | 5.50 / 6.54 |
| all | refreshed | populated | 5.17 / 6.66 | 5.17 / 6.51 |

Representative expanded scenarios use refreshed statistics and populated
summaries, again one request/sample and 0 errors:

| Scope / page size / concurrency | Samples | Before | After |
| --- | ---: | ---: | ---: |
| local / 100 / 1 | 60 | 80.03 / 107.33 | 13.02 / 14.72 |
| all / 100 / 1 | 60 | 13.55 / 14.78 | 13.04 / 16.14 |
| local / 24 / 8 | 160 | 261.25 / 376.83 | 15.62 / 21.24 |
| all / 24 / 8 | 160 | 14.33 / 17.55 | 14.61 / 18.18 |

The local COUNT is the dominant cost. Its original OR/IN predicate prevents
an indexed equality lookup for each work: refreshed EXPLAIN searches
`scope_presence` with an automatic partial index on `presence_type`, followed
by a correlated edition list. Separate direct-presence and family-presence
EXISTS probes use the existing `sqlite_autoindex_work_source_presence_1`
(`work_id=?`), with `idx_work_edition_translation_kind` for family membership.
Canonical visibility, personal state, sorting, total count and media/version
projection are untouched. No index, numbered migration or baseline is added.

These are **independent phase experiments**, 60 samples each, not additive
spans within one request. Page projection runs over the same 24 selected IDs;
candidate/sort uses the production materialized page CTE. Refreshed/populated
local results are:

| Phase | Before p50 / p95 | After p50 / p95 |
| --- | ---: | ---: |
| COUNT | 72.54 / 77.79 | <1 / 1.04 |
| Candidate filtering / sorting | <1 / 1.01 | <1 / 1.00 |
| Isolated page projection | 1.00 / 2.13 | 1.04 / 4.04 |
| Full page SELECT | 2.00 / 2.66 | 2.02 / 4.61 |
| Store list (COUNT + page) | 69.08 / 76.04 | 2.50 / 3.51 |
| Title inputs | <1 / 1.00 | <1 / 0.53 |
| Media selection | <1 / 1.00 | <1 / 1.00 |
| Card projection and enrichment | 2.51 / 3.76 | 2.51 / 3.16 |
| Connection acquisition, concurrency 1 | <1 / <1 | <1 / <1 |

Windows timer quantization makes sub-millisecond samples coarse. Complete HTTP
is the benefit gate. The refreshed all-scope control is unchanged code and
stable; no benefit is claimed for it. On the work-code-only snapshots, summary
backfill does not remove the local COUNT cost. Without both STAT1 and STAT4,
the remaining media-selection plan still leaves complete requests near 34 ms.
PR #19's bounded statistics worker is disabled for this controlled comparison;
refreshing statistics remains necessary after ingestion. Rich metadata parsing
and very large families remain separate workloads.

For local/refreshed/populated page 24, response size stays 25,943 bytes;
allocated Go bytes/request are 868,159 before and 726,976 after (GC-sensitive,
not peak RSS). At concurrency 8 they are 1,166,155 / 1,189,168. Throughput rises
from 30.48 to 470.78 responses/s in that batch. Pool wait count falls from
6,315 to 4,691, and cumulative wait from 20,254.71 to 739.28 ms across 160
requests. This is cumulative time across borrowers, not a per-request percentile.
Concurrency 1 has zero pool waits. Page 100 returns 107,948 bytes and allocates
2,398,723 / 2,226,751 bytes/request; no peak-memory reduction is claimed.

## 2026-10-09 follow-up: direct links and playback

The existing summary GET and media GET now also accept a work code. They share
the resolve endpoint's read-only canonical alias/edition/legacy-snapshot
resolution; numeric GETs still select their exact edition. Both code reads
retain authorization, Demo visibility and media-selection behavior. Direct
links start these two requests together, avoiding the preliminary resolve
round trip. Directory errors retain the summary; cancellation and obsolete
navigation guards remain active. If concurrent alias reads disagree, the
directory is read once for the summary's exact numeric identity.

The real authenticated API uses the same 400/8,000 fixture, populated summaries,
refreshed statistics, Origin preference, four connections, warm keep-alive and
no jobs. It mirrors the actual client graph: resolve followed by parallel
numeric summary/media before; parallel code summary/media after. Each latency
group has 60 operations, three warm-ups, concurrency 1 and 0 errors.

| Complete summary + directory HTTP graph | Before p50 / p95, ms | After p50 / p95, ms |
| --- | ---: | ---: |
| Loopback, no injected delay | 3.55 / 5.03 | 3.00 / 3.59 |
| 200 ms delay per API request | 405.94 / 406.81 | 203.98 / 204.65 |

Requests/operation fall from 3 to 2, response bytes from 13,913 to 13,574.
No low-latency p95 benefit is claimed. The measured delayed-path improvement
is about 202 ms; the one-round-trip estimate is 200 ms and is an **estimate**.

The browser comparison uses production builds with real React rendering and
controlled app API responses. Each row has 20 samples, concurrency 1, 0 errors,
fresh principal storage/media cache, service workers blocked and browser HTTP
caching disabled by interception. API delay is 0 or 200 ms, source configuration
0 or 600 ms, Origin metadata preference and one WAV directory entry. A page-local
MutationObserver records the first animation frame with a visible summary
action or directory row, relative to navigation's browser time origin. This
measures a render frame; it does not measure GPU display/output-device latency.
Playwright visibility waits are slower polling observations and are not used
as paint timings.

| Production render-frame milestone | Before p50 / p95, ms | After p50 / p95, ms |
| --- | ---: | ---: |
| Summary, no API delay | 99.10 / 115.00 | 119.20 / 405.50 |
| Directory, no API delay | 111.90 / 115.70 | 132.60 / 412.50 |
| Summary, 200 ms API delay | 699.50 / 713.00 | 494.60 / 547.50 |
| Directory, 200 ms API delay | 700.10 / 713.40 | 503.00 / 556.60 |

Request traces show resolve at 212.45 / 222.03 ms, then summary at
204.52 / 214.30 and media at 204.51 / 214.25 ms before. After, summary
(212.06 / 220.94) and media (211.65 / 220.89) start together. Detail request
count is 3 / 2 for every sample. The no-delay rendering tail fluctuates markedly;
there is no demonstrated cold-bundle or fast-network rendering benefit. The
delayed-path reduction is confirmed by both real API and render-frame results.
These clocks are separate and are never added to server timings.

Playback is measured separately with generated five-second PCM WAV and
300-second sine-wave AAC. The complete authenticated local Range path uses
the migrated 400/8,000 database, synthetic session, production pool, real media
target lookup and no workers. Cold samples change the source revision; warm
samples reuse its complete compatible MP3. Three warm-ups precede each group.
The first Range requests 4 KiB, checks 206/byte count and verifies MP3 delivery
for compatibility cases. The remote experiment exercises the existing secured
configured-origin playback handler against a loopback upstream with 200 ms
response delay, warm source/track snapshots and no encoded media cache.

| First Range response headers | Samples | Before p50 / p95, ms | After p50 / p95, ms |
| --- | ---: | ---: | ---: |
| Authenticated local direct | 60 | <1 / 1.00 | <1 / 0.52 |
| Authenticated compatible cold | 12 | 708.88 / 724.07 | 710.59 / 735.70 |
| Authenticated compatible warm | 60 | <1 / 0.52 | 0.51 / 0.54 |
| Remote secured handler, 200 ms upstream | 60 | 201.10 / 201.69 | 201.24 / 201.99 |

Complete 4 KiB bodies take 708.88 / 724.07 before and 711.11 / 735.70 ms
after for cold compatibility. These are complete HTTP responses, distinct
from server-internal header probes. Local authentication/lookup is included
in the first three rows; the remote row isolates the secured proxy handler.
All groups have concurrency 1, one request/sample and 0 errors.

The production browser loads the global player with mocked app APIs and real
Go playback handlers, one generated track per queue. Principal storage is
cleared per navigation, service workers/HTTP caching are disabled, and existing
next-track preloading cannot run on the single-track queue. The same changed
production frontend is held fixed while comparing the two backend revisions;
the final run also contains main's maintenance fix. Click and `playing` use
the same browser clock and a real audio element.

| Click to browser `playing` | Samples | Before p50 / p95, ms | After p50 / p95, ms |
| --- | ---: | ---: | ---: |
| Local direct | 20 | 22.70 / 332.20 | 22.20 / 32.70 |
| Remote, 200 ms upstream | 20 | 222.80 / 225.40 | 229.40 / 237.50 |
| Compatible cold | 12 | 768.90 / 783.90 | 859.50 / 3917.80 |
| Compatible warm | 20 | 24.40 / 27.10 | 25.40 / 31.40 |

Each sample starts one media HTTP request; error rate is 0. Remote upstream
requests total 80 per run (60 Range + 20 browser). Cold encoding/rendering
tails fluctuate despite unchanged playback code; **no playback improvement is
claimed**. A separate 12-sample queue experiment holds both realtime slots for
250 ms: acquisition is 250.22 / 250.41 before and 250.35 / 250.53 ms after.
An independent 12-sample encoder experiment takes 771.91 / 826.49 and
748.42 / 937.22 ms. These isolated phases are not additive HTTP spans.

Preparation costs 1,136.72 / 1,209.64 ms of FFmpeg process CPU per 300-second
track, and produces 1,195,945 bytes per complete MP3. Each run retains 39 source
revisions (including cold warm-ups), totaling 46,641,855 cache bytes. The
existing bounded 512 MiB reservation, two encoder slots, publication locks,
quota/eviction, cancellation and Range semantics remain in use. Warm-control
preparation demonstrates reusable-cache latency; it moves the same encoding
cost before the click rather than removing it. No evidence establishes a
worthwhile user-intent/dwell window or contention-safe extra preparation lane,
so no new speculative transcode preparation is shipped. Existing next-track
preloading and current playback priority are preserved.

Not covered: NAS/offline storage, physical mobile devices, device/audio-output
latency, real network bandwidth/jitter/packet loss, long multi-hour recordings,
mixed video/encode load and peak process RSS. Rich metadata and large edition
families are not modeled by the main fixture. The controlled experiments do
not substitute for those measurements. Invalid fixture runs and preliminary
STAT1-only missing-statistics runs are excluded from the final tables.

Reproduce the follow-up with canonical entry points, sequentially on an idle
machine:

```text
make browse-performance
make browse-production-performance
make playback-performance
```

The two browser targets build production assets first. `PLAYWRIGHT_BASE_URL`
may point the direct-link experiment at an existing production preview;
otherwise the runner owns a loopback preview. Playback uses the production
static handler and real playback handlers, with mocked application APIs.
Its test-only controls never become application routes. The loops contain no
timing thresholds and are skipped in ordinary CI.

## Historical PR #19 report (2026-10-08)

The following measurements and validation results belong to PR #19; they do
not describe the follow-up branch or its current CI status.

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
