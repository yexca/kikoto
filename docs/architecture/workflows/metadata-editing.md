# Metadata Editing and Remote Fallback

How the work metadata editor handles language-scoped edits, previews, and explicit refreshes from a remote source.

## Language-scoped title edits

The work editor and Metadata Works editor share per-language drafts and the same
partial PATCH. Only authored changes are sent; source placeholders never become
manual overrides. Own manual titles load as editable text. Title reset targets
one field/language and keeps other unsaved drafts in the open editor. Cover and
shared metadata tag operations are separate requests with their own
transactions. Title insert, update, language change and delete queue the work's
search document and language titles. Changing a user's metadata language
selects titles and descriptions from stored editions without new provider
requests or work identities. See [data model](../data-model.md) for the
precedence and `origin` contract. A remote-filled title follows DLsite in the
title chain. Provider-declared remote edition titles add metadata language
choices; an undeclared remote title remains the languageless fallback.

## Metadata preview and apply

The work metadata editor can request a bounded preview for one existing work
without writing provider snapshots, projections, work identities, or workflow
state. The preview is retained privately for a short period and is bound to
the requesting user, work, and the work's update timestamp. Applying it fails
when the work changed after the preview was opened.

The comparison presents current, fetched, and expected values. Selecting a
fetched value accepts provider metadata and clears an older manual override
for that field. Editing the expected value creates a manual override. Keeping
the current value while accepting another fetched field pins that current
value as a manual override so the provider update cannot replace it. Shared
tag overrides are cleared only when fetched tags are explicitly accepted.
The comparison can merge current and fetched tag concepts by stable tag id; the
result keeps current concepts as explicit additions to the fetched provider
set. A fetched DLsite family is accepted by a separate action and uses the
bounded family sync path, so ordinary field acceptance never materializes
sibling editions.

## Remote Metadata Fallback

The detail metadata editor also offers an explicit `From <source name>`
refresh for each enabled source with declared metadata capability, and
Metadata issue recovery offers the same per source.
`POST /api/works/{id}/metadata-sync` and `POST /api/metadata/issues/retry`
accept an optional `sourceId`; without one they queue the DLsite family
refresh. Issue recovery with a source still queues only works with a pending
DLsite issue or a family that was never synced. A source refresh requests only
the current work, bypasses cached descriptions, and operates independently of
automatic fallback settings and DLsite availability. It preserves manual and
DLsite precedence and uses the same bounded request policy described below.
Submission and execution both validate the source's capability and enabled
state. Repeated requests for the same work and source reuse the active run;
The run records source codes and fixed outcomes without endpoint details.

Bulk and scheduled metadata sync decide by error type. A DLsite request
answered with 429, or with 503 and `Retry-After`, waits the bounded backoff
and retries; rate limiting that persists through those retries stops the run,
which fails so it can be retried later. A timeout or any other error of one
work skips that work: the run continues with the others and finishes
`partial`. When enabled in the DLsite run options, these runs ask the
selected sources after DLsite reports the requested product as not found.
Timeouts, rate limits and other retryable DLsite failures never contact a
remote source, so a DLsite outage cannot fan out to remote sources. Fallback-enabled runs revisit unavailable works
within their scope. A DLsite `metadata_family_sync` job, used by work detail
and Metadata recovery, snapshots the instance remote metadata fallback and
purchase bonus settings when it is queued.
A work that already has DLsite metadata is skipped, and the
fallback never fills a language DLsite lacks.

For works without DLsite metadata, the same response's `language_editions`
relationships and `other_language_editions_in_db` titles supply stored language
choices. Switching language reads those choices without requesting sibling
codes. These metadata references never materialize library works or playable
editions; an edition relationship without a returned title stays a relationship.

Sources are tried in the configured order, and the first that describes the
work wins. A matching cached description is reused first: that source's earlier
snapshot of the work, then a voice catalog listing. Otherwise the source is
asked exactly once through `workInfo`; the catalog page scan is not used. Each
lookup has a 30-second bound, uses the source's paced crawl lane, buffers at
most 2 MiB, and accepts only a response that decodes within the snapshot bounds
and names the same code. A 404 or a different code counts as not found; other
errors are failures. The snapshot write, reconciliation and shared-tag
projection commit together; the cover is cached afterwards only when the work
has none.

Each attempt records a fixed outcome per source in the shared attempt ledger.
Once a later source fills the work, earlier sources' pending states are
cleared. A family refresh of a product DLsite reports not found succeeds
whatever the fallback outcome. Run output and `metadata.remote_fallback`
events list source codes and outcomes, not endpoints, while protected
logs keep detailed errors. See [data model](../data-model/remote-metadata-fallback.md#remote-metadata-fallback)
for ordering, provenance and switching the fallback off.
