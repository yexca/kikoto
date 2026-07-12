# Sources

Sources describe where files come from.

## Source Types

- Local folder source.
- Kikoeru-compatible remote source.
- Number178-compatible remote source.

## Current Behavior

- Local scan detects supported work-code folders under the configured data root.
- Remote source tabs browse configured sources without importing every result.
- Work detail uses backend aggregate availability checks.
- Remote sync imports metadata and source file trees into the unified database.
- Remote cache materializes selected remote files under the cache root.
- Remote fetch promotes selected remote files into the local data tree.
- Cache and local deletion target concrete file locations, not the unified work.
  Mixed selections are submitted as one recoverable workflow; local deletion
  preserves work progress and listening marks.
- Remote source list and detail pages should remain source-scoped views; they do
  not replace the unified local work detail model.

## Availability Checks

Startup and source-change batch checks first verify relevant source health. The
probe prefers `/api/health` and falls back to a one-item list request for
compatible sources that do not expose a health endpoint.

If a source is unreachable, Kikoto marks that source unavailable for the batch
and skips per-work checks. It does not mark every candidate work as missing.

## Download Pacing

Remote downloads wait for configured delay and retry temporary errors with
backoff. DLsite metadata sync also uses configured base delay and backoff for
provider product and cover requests.

Fetch planning uses already complete persisted metadata and cached source
availability. When the requested code has no DLsite snapshot or edition
relationship, preparation performs a bounded targeted family sync before
building the review. A queued Fetch reuses the remote tree accepted during
submission instead of immediately requesting the same tree again. After Local
registration succeeds, cache objects promoted by that Fetch are removed;
unselected cache objects remain available.

## Related Docs

- [Work detail](work-detail.md)
- [Settings](settings.md)
- [Source presence](../architecture/source-presence.md)
- [Reliability](../operations/reliability.md)
