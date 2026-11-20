# Shown Works Actions and Preset Workflows

The system workflows an account starts from the works it is looking at, and the preset workflows composed from validated parameters.

## Shown Works Actions

Two system workflows act on the works an account is looking at on the
Discover page, only when it asks; no schedule, ranking pull, or
subscription refresh starts them. Both are incremental: each takes only the
shown works that still need it, at most 100 in the order shown, and with
nothing to take queues no run. A request names what is shown:

- `POST /api/rankings/{id}/metadata-sync` and `POST
  /api/rankings/{id}/source-check` take the `snapshotId` of the shown
  [ranking](rankings.md#rankings) order, which must belong to a list the account may see.
- `POST /api/subscriptions/feed/metadata-sync` and `POST
  /api/subscriptions/feed/source-check` take the `page` and `days` of the
  account's [release feed](catalog-refresh-and-subscriptions.md#creator-subscriptions) page; the works are the
  codes its family cards show.

A request for the same order or feed page while its run is queued or running
joins that run. Demo refuses both.

- `shown_works_metadata_sync` requires `metadata:sync`. It takes the codes that
  have no work and those whose work's DLsite metadata is missing or older than
  a day, and leaves works DLsite does not list. The shown codes are explicitly
  requested metadata roots, so the run synchronizes each code's DLsite family
  in the order shown through the paced DLsite client, holding
  `metadata:provider`, and may create their edition works, as Availability
  Watch does for watched codes. A code that fails is recorded and the run goes
  on; the run is partial when some codes failed and failed when every code
  did.
- `shown_works_source_check` requires `remote:track` and an enabled source that
  supports work lookups, or answers `409` with `no_remote_source`. It takes
  the codes that have no work and the works not known to be available: without
  an available location or source presence, and whose `source` presence was
  not checked within a day. The run probes the sources once, then asks the
  healthy ones about each code through the paced crawl lane, holding
  `remote:availability`, and records the answer as the `source` presence of
  a code that has a work. It never creates works. Its summary lists, for every
  code, the sources that have it and those that do not, so the page can show
  the answers for codes without a work. After five codes in a row that no
  source answered, it stops and the run is partial.

## Preset Workflows

Preset workflows are system definitions whose graph is composed by the server
from a small validated parameter set. The typed workflow graph runtime
(`workflow_graph*.go`; persisted as `custom_workflow` jobs with checkpoints and
retry) executes the node kinds the presets and the circle and voice actor
detail refreshes compose. One job runs the nodes in topological order, each to
completion before the next, and checkpoints every completed node with its
outputs; a retried or resumed job continues after the last completed node,
which keeps its recorded result. A queued or running graph run whose stored
graph names a node kind the runtime does not have fails at startup: the node
of that kind fails with a public reason, the unfinished nodes are skipped, and
the job is not recoverable, so the run is neither claimed nor retried.
`circle_catalog_sync`,
`series_catalog_sync`, and `voice_catalog_sync` share one input, filter, and
actions shape:

| Section | Circle | Series | Voice actor |
| --- | --- | --- | --- |
| Input | `circleId`, `catalogRefresh` (`incremental`, `full`) | `seriesId` (stored catalog) | `personId`, `sourceIds`, `catalogRefresh` |
| Filter | `releaseFrom`, `releaseTo`, `maxWorks` | same | same |
| Actions | `metadata`, `tagNameTemplate`, `checkSourceIds` | `metadata`, `tagNameTemplate` | `metadata`, `tagNameTemplate` |

```text
discover (circle_catalog | series_catalog | voice_catalog)
  -> circle_sources (circle, when checkSourceIds is set)
  -> filter_works (existing=missing_metadata, releaseFrom, releaseTo, limit)
  -> metadata_sync
  -> tag_works (optional, rendered from a tag template)
```

The filter keeps catalog works that lack DLsite metadata: codes without a work
and works without a DLsite snapshot, skipping works the provider reported as
not found. A candidate without a work takes its release date from the circle
or voice actor catalog. Every filter is off by default; without a work limit a
run syncs every catalog work that lacks metadata, up to the internal catalog
bound of 5000. Syncing a circle or voice actor catalog is therefore an explicit
request for its catalog.
With `metadata` off the run only refreshes the catalog (and checks sources), so
the filter and tag are dropped; a series has no catalog refresh and requires
the metadata action. Refreshing the metadata of works that already have it is
Metadata sync with a circle or voice actor [scope](metadata-sync.md#metadata-sync-scope).
Catalog sync presets never track or fetch remote works; those actions belong
to Availability Watch, remote collections, and Fetch. The presets run on
demand and accept no trigger: following a catalog on a schedule is a
[creator subscription](catalog-refresh-and-subscriptions.md#creator-subscriptions).

An administrator with `sources:write` reviews the user definitions saved in
`legacy_workflow_snapshot` during library onboarding. An upgrade from a
database below schema version 35 fills that table, with each definition's
triggers, before the numbered migrations run. The review offers conversion only
for a graph equivalent to a current preset with Startup or schedule triggers.
Conversion subscribes the reviewing account to the circles, series, or voice
actor the graph read; their baselines come from the next successful catalog
pull. Any other definition can be skipped or exported.

`GET /api/workflow-presets` publishes each preset's parameter schema; the
Workflows page renders it as that operation's run form.
`POST /api/workflow-presets/{code}/runs`
validates the inputs, checks that a selected source is an enabled compatible
remote source, renders the tag template for this dispatch (`{date}`,
`{target}`), builds the graph, validates it with the typed workflow graph
validator, and enqueues one recoverable `custom_workflow` job. The job payload
carries the built graph, so the run shows the real nodes while the definition
record only stores a display pipeline. Required permissions are derived from
the composed node capabilities: catalog refresh and metadata need
`metadata:sync`, tagging needs `tags:write`.

The circle and series targets (`circleId`, `seriesId`) accept up to 20
entries separated by commas, semicolons, or new lines. They are normalized and
deduplicated into one comma-separated input, and the single discover node reads
each target in order, combining the catalogs and keeping each work once within
its catalog bound. `{target}` renders the joined list as a tag fragment. An
empty tag template omits the tag node.

`releaseFrom` and `releaseTo` are optional inclusive bounds passed to
`filter_works`; either may be omitted to leave that side open, and a start
after the end is rejected. `maxWorks` is optional (1 to 500); an omitted limit
runs at the 5000-work catalog bound, which is still explicit in the composed
graph.

The catalog sync presets reject the unsupported inputs `newWorks`, `existing`,
`action`, `sourceId`, `metadataRefresh`, and the Fetch limits with a
reconfiguration message rather than reinterpret them. Preset runs are
system-scope runs and share the visibility, cancel, retry, and run-list
behavior of built-in runs.
