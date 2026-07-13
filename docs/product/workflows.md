# Workflows

Workflows make backend actions inspectable.

## User Surfaces

- Workflows: runnable built-in definitions, custom definition drafts, and
  scheduled triggers.
- Activity: running, review, failed, completed, and log views.

## Current Behavior

- Local scan, metadata sync, source availability, remote sync, cache, fetch,
  cleanup, circle refresh, and bulk remote actions record workflow runs.
- Node runs expose step-level progress.
- Candidates expose reviewable outcomes.
- Informational review runs can be acknowledged separately from candidate
  decisions.
- Definitions puts manually runnable built-ins ahead of custom drafts. Internal
  system definitions that have no manual action are omitted from this surface.
- DLsite popular collection supports 24-hour, 7-day, 30-day, and annual voice
  rankings. Recent periods can be limited to works released within 30 days;
  annual runs select an explicit year. Runs synchronize metadata and append the
  displayed user tag without replacing existing user tags.

## Later Work

- Retry failed runs or nodes.
- Durable async worker execution.
- Restart recovery for queued or running jobs.

## Related Docs

- [Architecture workflows](../architecture/workflows.md)
- [Reliability](../operations/reliability.md)
- [Testing](../development/testing.md)
