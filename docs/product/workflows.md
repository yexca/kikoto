# Workflows

Workflows make backend actions inspectable.

## User Surfaces

- Workflows: definitions, scheduled triggers, and system definitions.
- Activity: running, review, failed, completed, and log views.

## Current Behavior

- Local scan, metadata sync, source availability, remote sync, cache, fetch,
  cleanup, circle refresh, and bulk remote actions record workflow runs.
- Node runs expose step-level progress.
- Candidates expose reviewable outcomes.
- Informational review runs can be acknowledged separately from candidate
  decisions.

## Later Work

- Retry failed runs or nodes.
- Durable async worker execution.
- Restart recovery for queued or running jobs.

## Related Docs

- [Architecture workflows](../architecture/workflows.md)
- [Reliability](../operations/reliability.md)
- [Testing](../development/testing.md)
