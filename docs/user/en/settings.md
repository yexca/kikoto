# Settings
[English](../en/settings.md) · [简体中文](../zh-Hans/settings.md) · [繁體中文](../zh-Hant/settings.md) · [日本語](../ja/settings.md) · [한국어](../ko/settings.md)

Settings exposes account controls, playback preferences, and recommendation preferences. Appearance and UI language are available from the header appearance menu. Instance and user administration remain in Maintenance.

## Current Settings

- Update the authenticated user's display name.
- Change an account-managed user's password after verifying the current
  password and confirming the replacement.
- Keep username and role visible but read-only.
- Account-backed folder preferences and recommendation tuning, shared across devices.
- Backward and forward seek intervals. They default to 10 and 30 seconds,
  respectively, and accept whole-second values from 1 through 300.

## Account Boundaries

Changing a password preserves the current session and revokes the user's other
sessions. An administrator password reset from Maintenance revokes every
session for the target user. Role, enabled state, username, and user lifecycle
management are not self-service account settings.

The configured root account cannot change its password in Settings. Its
credential is managed by `KIKOTO_ROOT_PASSWORD`; changing that environment
value and restarting Kikoto replaces the stored root password and revokes its
existing sessions. Other super administrators remain account-managed and can
change their own passwords normally.

Demo mode keeps account-backed Settings read-only. The administration tabs
(Library, Cache & Fetch, Cleanup, and Users) stay visible for inspection even
though the Demo identity is not an administrator, and every change in them is
disabled. Appearance and playback controls remain available because theme mode, style, color, and seek intervals
are browser-local preferences and do not modify Demo server data. Playback
preferences are isolated by server identity and authenticated user, or by the
anonymous principal when anonymous access is enabled.

## Personal Playback And Recommendations

Settings uses Account, Playback, and Recommendation tabs. Playback contains local seek intervals and **Folder preference**: ordered folder matching and exclusion rules. Recommendation contains presets, badge threshold, variation, discovery boost, and advanced scoring, plus a collapsed **Your recommendation activity** summary of the signed-in user's own impressions, opens, plays, marks, and score distribution over the last 30 days. These two migrated preferences are stored per authenticated account on the server; changing them never changes another account. An account without overrides and anonymous browsing retain the existing instance defaults. Old Maintenance Routing and Recommendation links open the corresponding Settings tab.

Saving recommendation settings creates a new recommendation session for the current tab. Other open tabs keep their existing snapshots until a new session is created. Saving folder preferences updates subsequent directory selection without stopping the player. Failed saves retain the draft and the previous persisted values. Demo mode keeps these server-backed preferences read-only.

Appearance is available only from the header menu. The globe option follows the browser or device language; its tooltip and accessible name identify automatic selection.

## Maintenance Organization

Maintenance uses one horizontal row of tabs, scrolling horizontally on narrow screens. Overview is removed; Library is the default for source administrators, and Users is the default for user-only administrators. Old Paths and Access links open Library and Users respectively.

- Maintenance opens with a concise administration description instead of
  repeating editable configuration values as summary statistics. Detail tabs
  retain only operational metrics such as source health, recommendation
  and quick enable state.
- Library combines local scan settings, configured remote sources, and read-only storage paths.
- Instance access settings appear under Users for super administrators in production and development.
  Anonymous Library browsing and playback default to disabled; changing the
  switch applies to the production access boundary and creates an audit entry.
  Development still authenticates every request as root, so the setting remains
  visible and editable there without creating an anonymous development session.
- Remote sources are a compact list: health, host, a health-check action, and an
  enable switch that saves immediately. Health-check results are persisted
  through the same source health state used by automatic probes.
- **Add source** starts from one address. Kikoto probes the address as entered,
  its origin, and the conventional `api.` sibling for a Kikoeru-compatible works
  API, then fills the API URL, public site, and name. When nothing is detected,
  **Connection details** opens for manual entry. Endpoint fields, priority, and
  network/storage options stay in collapsed groups.
- Remote sources default to compatible public storage hosts. Source
  configuration can enable **Restrict outbound hosts** to allow only the API,
  Public site, Fallback, and an editable list of exact or `*.example.invalid`
  public host patterns.
- Maintenance contains Library, Cache & Fetch, Cleanup, and Users.
- Cache & Fetch contains configuration only: playback cache policy, transfer
  safety, and collapsed download pacing, with one save action that is enabled
  after a change. Cache contents are managed in the Cleanup tab.
- Cache & Fetch includes the per-file remote media limit and the retention age
  for unpublished staging from failed or cancelled Fetch runs. The defaults are
  100 GB per media file and seven days of staging retention.
- Cache & Fetch exposes an independent transcode cache limit from 1 to
  4096 GB. It defaults to 5 GB. This rebuildable cache lives under
  `/cache/transcodes` and does not change the managed remote-media cache limit.
- Storage paths in Library are collapsed by default, read-only, and show the resolved data root, cache root, default
  cache/save previews, and per-source save previews. Remote Source configuration
  shows the same resolved example instead of exposing a path-template editor.

## Cleanup

**Cleanup** is an administrator tab in Settings, after Cache & Fetch
(`/settings?tab=cleanup`). Cache sections need `downloads:manage` and database
sections need `sources:write`.

- **Transcode cache** shows usage against its limit and offers a confirmed clear
  action.
- **Managed media cache** reports on-disk, referenced, eligible, and protected
  files, and cleans orphan or per-work cache grouped by source. Cleanup remains a
  two-step destructive action queued as a workflow run.
- **Database records** lists record types that can be removed, each with a
  current count: missing work folders and local files confirmed absent on disk
  (with the empty track entries and local availability they leave behind),
  orphaned metadata snapshots, unused source tags, expired sessions, dismissed
  notifications, finished workflow runs older than 90 days, recommendation
  signals older than 90 days, and unused recommendation snapshots. Personal
  tags, runs with reviews, Fetch records, or metadata issues, and the latest run
  of each workflow are kept. Selected tasks are removed after confirmation and
  recorded in the audit log; media files are never deleted. Expired sessions
  and eligible old workflow runs are also removed automatically once a day
  with the same rules.
- Path checks pause when the data folder is missing or empty, so an unmounted
  library is never treated as deleted.
- **Works without any source** links to Metadata's **No available source** view
  for review and deletion.
- **Compact database** rewrites the SQLite file to return free pages to disk.
  It runs in the background as a workflow run shown in Activity, and only one
  compaction can be queued or running at a time.

## Metadata

The **Metadata** sidebar entry sits directly below **Workflows**. Its horizontal categories are **All**, **Needs attention**, **Metadata issues**, and **No available source**. All includes every saved work family, including metadata without pending issues; the other categories show the applicable attention reasons. Search, pagination, covers, selection, and affected edition/provider details are shared. A separate **Voice aliases** view (requires `metadata:sync`) lists voice actors with their confirmed aliases; **Manage aliases** opens a dialog to add or remove aliases, merge duplicate people, and undo merges. The voice detail Advanced popover links to this view, and `/metadata?view=aliases&voice=<id>` opens one person directly.

The header keeps the categories, search, and list controls on one row. On wide screens the search field sits beside the categories; on narrower screens it collapses to a search icon at the right that opens the field below the row. Refresh, rows per page, **Retry metadata**, **Check sources**, and the **Metadata settings** gear follow. Pagination above and below the list matches the Library. Metadata settings open in a popover; hover or focus an info icon for a setting's explanation, and closing it preserves the current list and filters. Start metadata sync from Workflows.

Select families and choose **Retry metadata**; its count includes only eligible selections. You can also retry an affected edition from its details, including products previously reported unavailable. Failed retries preserve existing metadata and manual overrides. **Check sources** applies to selected families without a source. Confirmed deletion of local information is available only in the **No available source** view; the server rechecks availability and retains media files.

**Open metadata issues** in Activity opens Metadata filtered to that run's unresolved metadata issues; **Show all pending works** removes the run filter. Recovery never changes another user's Activity review. Metadata recovery requires `metadata:sync`, while source checks, deletion, and source/language settings require `sources:write`. The **Metadata settings** popover contains settings only; this page does not duplicate the sync workflow's configuration or run controls. Old Maintenance links redirect here.

Metadata settings let administrators choose and reorder the supported DLsite
  title/tag languages. `Origin` is always retained as the final fallback. Each
  compatible remote source also has its request-language hint in this popover; the
  upstream may ignore it, fall back, or return mixed-language metadata.

## Related Docs

- [Configuration](../../operations/configuration.md)
- [Security](../../operations/security.md)
- [Sources](sources.md)

Metadata uses `/metadata`. Old `/work-management` links still work and retain their filters or settings context. First-sync failures and pending metadata results open Metadata issues; operators without workflow permission see the unscoped issue list. Run diagnostics remain in Workflows Activity.
