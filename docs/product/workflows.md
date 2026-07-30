# Workflows

Workflows make backend actions inspectable.

## User Surfaces

- Workflows: built-in and custom definitions with their triggers managed in the
  selected definition.
- Activity: mutually exclusive running, review, failed, and completed views.

## Current Behavior

- Local scan records folder discovery, local source presence, and missing
  metadata sync in one run. Source availability, remote sync, cache, fetch,
  cleanup, circle refresh, and bulk remote actions also record workflow runs.
- Node runs expose step-level progress.
- Candidates expose reviewable outcomes.
- Review contains terminal runs with unresolved candidates that need a user
  decision. Routine partial or skipped outcomes remain in Completed and keep
  their warning status, summary, and events for inspection.
- The header notification center combines Review items with completed or failed
  Fetch results. Fetch notifications open the local work detail and can be
  dismissed independently for the signed-in user.
- Definitions groups Built-in workflows and Custom definitions. Each list item
  shows compact badges for enabled Startup, Watching, and Schedule modes, with
  Manual as the fallback when no automatic trigger is enabled.
- Built-in local scan, metadata sync, remote popular, and DLsite popular
  workflows support editable Startup and interval triggers. Local scan ships
  with the default Startup trigger and does not check remote availability.
- Local scan also ships with one fixed, enabled folder watcher. It can be paused
  or resumed, but not created, edited, duplicated, converted, or deleted. The
  watcher registers directories under `/data` once, listens for native
  filesystem events afterward, and dynamically registers new directory trees.
  It debounces events for five seconds, ignores Kikoto's staging, backup, and
  trash trees, and queues the same full local scan used by Manual and Startup.
  Changes during an active run produce at most one follow-up scan. Paused events
  are discarded; offline changes rely on the default Startup scan.
- Remote and DLsite popular collection surfaces edit tag templates with a
  current-value preview, the complete workflow-specific variable list, and an
  explicit warning when the rendered tag exceeds 40 characters. Manual runs
  expand the template on request; automatic triggers store it unchanged and
  expand it at dispatch. Remote automatic collection is Track-only so it
  cannot bypass Fetch size and disk-reserve safeguards.
- The two configurable popular collectors keep their detail surfaces compact.
  `Configure` in the selected workflow header opens a modal containing the run
  inputs, tag preview, and final run action in one vertical column at every
  viewport width. Built-in workflows without run parameters continue to expose
  a direct run action.
- Editable version-2 custom workflows with one simple declared input show that
  input directly in the selected definition for repeated Quick Run previews.
  Multi-input and work-code-list definitions still use Configure. The shortcut
  uses the same server preview token, permission checks, and confirmation policy
  as the full run dialog.
- DLsite popular collection supports 24-hour, 7-day, 30-day, and annual voice
  rankings. Recent periods can be limited to works released within 30 days;
  annual runs select an explicit year and default to a template containing
  `{year}`. Runs synchronize metadata and append the previewed user tag without
  replacing existing user tags.
- A queued or running Fetch is unique per canonical work. Repeated Fetch
  requests reuse that run instead of downloading the same work twice, and every
  requesting user receives the shared run's terminal notification.

## Later Work

- Retry failed runs or nodes.
- Durable async worker execution.
- Restart recovery for queued or running jobs.

## Related Docs

- [Architecture workflows](../architecture/workflows.md)
- [Reliability](../operations/reliability.md)
- [Testing](../development/testing.md)
