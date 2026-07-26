# Workflows

Workflows make backend actions inspectable.

## User Surfaces

- Workflows: built-in and custom definitions with their triggers managed in the
  selected definition.
- Activity: mutually exclusive running, review, failed, and completed views.

## Current Behavior

- Local scan, metadata sync, source availability, remote sync, cache, fetch,
  cleanup, circle refresh, and bulk remote actions record workflow runs.
- Node runs expose step-level progress.
- Candidates expose reviewable outcomes.
- Review contains terminal runs with unresolved candidates that need a user
  decision. Routine partial or skipped outcomes remain in Completed and keep
  their warning status, summary, and events for inspection.
- Definitions groups Built-in workflows and Custom definitions. Each list item
  shows one execution status: Scheduled takes precedence over Startup, while a
  definition without either persisted trigger shows Manual.
- Built-in local scan, metadata sync, library refresh, remote popular, and
  DLsite popular workflows support editable Startup and interval triggers.
- Remote and DLsite popular collection surfaces edit tag templates with a
  current-value preview, the complete workflow-specific variable list, and an
  explicit warning when the rendered tag exceeds 40 characters. Manual runs
  expand the template on request; automatic triggers store it unchanged and
  expand it at dispatch. Remote automatic collection is Track-only so it
  cannot bypass Fetch size and disk-reserve safeguards.
- DLsite popular collection supports 24-hour, 7-day, 30-day, and annual voice
  rankings. Recent periods can be limited to works released within 30 days;
  annual runs select an explicit year and default to a template containing
  `{year}`. Runs synchronize metadata and append the previewed user tag without
  replacing existing user tags.

## Later Work

- Retry failed runs or nodes.
- Durable async worker execution.
- Restart recovery for queued or running jobs.

## Related Docs

- [Architecture workflows](../architecture/workflows.md)
- [Reliability](../operations/reliability.md)
- [Testing](../development/testing.md)
