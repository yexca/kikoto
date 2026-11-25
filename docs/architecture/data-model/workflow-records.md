# Workflows

The tables behind workflow runs and jobs, Fetch manifests, Availability Watch, creator subscriptions and rankings.

Important tables:

- `workflow_definition`
- `workflow_trigger`
- `filesystem_trigger_state`
- `workflow_run`
- `workflow_node_run`
- `workflow_job`
- `workflow_event`
- `workflow_notification`
- `workflow_candidate`
- `workflow_run_review`
- `translation_item`
- `remote_fetch_manifest`
- `remote_fetch_manifest_item`
- `remote_fetch_request`
- `availability_watch`
- `availability_watch_target`
- `creator_subscription`
- `party_release_seen`
- `person_release_seen`
- `user_release_feed_item`
- `user_release_feed_state`
- `ranking_list`
- `ranking_variant`
- `ranking_snapshot`
- `ranking_snapshot_item`
- `ranking_entry`
- `user_ranking_state`

Workflow records make scans, metadata sync, source checks, remote fetches, and
review actions inspectable. `workflow_job.priority` is durable queue-ordering
metadata; higher values claim first, with creation time and id as FIFO
tie-breakers. `workflow_trigger.trigger_type` is `startup`, `schedule`,
`filesystem_event`, `source_poll`, or `after_workflow`, whose schedule names
the workflow it follows (see
[Automatic Triggers](../workflows/built-in-workflows.md#automatic-triggers)).
`workflow_event` is a run's event log (level, type, message and
detail), optionally tied to a node run or job. `workflow_notification` holds at
most one notification per user, run and type, such as ready Availability Watch
works, new subscription releases, or the first metadata prompt; database
cleanup can remove dismissed ones.

`workflow_job.progress_bytes_current`, `progress_bytes_total`, and
`progress_bytes_unknown_items` preserve Fetch transfer progress without
overloading file-count progress. `remote_fetch_manifest` is the plan and state
of one Fetch run: the work, remote and local sources, edition code, and target,
staging and backup roots. `remote_fetch_manifest_item` holds one planned file
per target path with its action, expected size, hash, state and conflict
resolution. `remote_fetch_manifest.staging_cleaned_at` records retention
cleanup while the manifest and its reviewable run history remain available for
retry. `remote_fetch_request` maps a client-supplied request id to its source,
work code, run and result, so a repeated request returns the original result
and reusing the id for another work is rejected.

`availability_watch` holds the single shared
[Availability Watch](../workflows/source-availability.md#availability-watch) setting: the source it
checks, the account that last configured it, and a revision. Its `action` is
always `monitor`, since the watch never tracks or fetches on its own.
`availability_watch_target` holds the normalized work codes in its pool with
per-target check state (`monitoring`, `ready` once available, `error`, or
`disabled` once removed), the source that became available and the family
edition it offered (`available_code`), the last family metadata refresh, and
the Track and Fetch runs started for it by hand: the bulk run that queued
them, then each work's own run. `created_at` is when the code last entered
the pool. A target is a code, not a work.

`creator_subscription` holds one account's
[creator subscription](../workflows/catalog-refresh-and-subscriptions.md#creator-subscriptions) to a circle
(`party_id`), a series (`party_id` with the provider `series_title_id`, which
survives full catalog refreshes that recreate `party_series` rows), or a voice
actor (`person_id`), with its Availability Watch option and `activated_at`,
which stays empty until the catalog has a baseline. `party_release_seen` and
`person_release_seen` hold the catalog codes already accounted for per circle
and voice actor. `user_release_feed_item` holds one feed entry per account,
code, and event with the subscription it came through, and
`user_release_feed_state` the time each account last opened the feed. Feed
entries are catalog codes, not works; a merge moves subscriptions, seen codes,
and feed references to the target.

`ranking_list` holds one tracked [ranking](../workflows/rankings.md#rankings): a DLsite
period (`day`, `week`, `month`, `year`, or `total`), a DLsite annual `year` (0
for every other list), or a remote source (`file_source_id`, removed with the
source). Its identity is the provider, source, period, and year. It also holds
the depth, whether the list is shown (`enabled`), its schedule
(`auto_refresh`, `refresh_interval_minutes`, `next_pull_at`, a pending
`pull_requested_at`, and the `failure_count` that spaces out retries), an
annual list's `final_at` and `follow_current_year`, and the last pull status,
`partial` when only some variants failed. `ranking_variant` holds each order
the list is pulled in, unique per list: a `release_window` (empty or `30d`)
and a `sort` (empty for popularity or `sale`), with its own last pull status
and protected error; it is removed with its list.
`ranking_snapshot` is one pulled order of a variant that differed from the one
before it, with the run that pulled it, a hash of its codes, and
`confirmed_until`, the latest pull that returned the same order;
`ranking_snapshot_item` holds its codes by rank. Snapshots are kept in the
tiers of [Rankings](../workflows/rankings.md#recording-and-history), set by the
`ranking_full_retention_days` and `ranking_daily_retention_days` settings (0
keeps the daily history forever). `ranking_entry` holds per variant and
code the title and circle the ranking showed, a remote list's source-local id
and cover address, and statistics derived from the snapshots: first seen,
start of the current presence, last seen, best rank, and appearances.
`user_ranking_state` holds the snapshot each account last displayed per
variant.
Rankings store codes, never work ids, so work merges and deletions need no
ranking changes.

`filesystem_trigger_state` stores the fixed local-scan trigger's watched
directory count and most recent event time. It is compact orchestration state,
not a per-file index or a directory snapshot. A bounded changed-path batch is
stored in the resulting incremental workflow run and job input. A pending batch
before dispatch is process-local; the default full Startup scan repairs changes
that occurred while Kikoto was stopped.
