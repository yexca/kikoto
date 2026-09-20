# Settings
[English](../en/settings.md) · [简体中文](../zh-Hans/settings.md) · [繁體中文](../zh-Hant/settings.md) · [日本語](../ja/settings.md) · [한국어](../ko/settings.md)

Settings exposes per-user account controls and browser-local appearance and
playback preferences. Instance and user administration remain in Maintenance.

## Current Settings

- Update the authenticated user's display name.
- Change an account-managed user's password after verifying the current
  password and confirming the replacement.
- Keep username and role visible but read-only.
- Light, dark, and system appearance preferences.
- Anthropic, OpenAI, Apple, and Google Material Design style preferences.
- Original, Graphite, Cobalt, and Iris color preferences.
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

Demo mode keeps account-backed Settings read-only. Appearance and playback
controls remain available because theme mode, style, color, and seek intervals
are browser-local preferences and do not modify Demo server data. Playback
preferences are isolated by server identity and authenticated user, or by the
anonymous principal when anonymous access is enabled.

## Maintenance Organization

- Maintenance opens with a concise administration description instead of
  repeating editable configuration values as summary statistics. Detail tabs
  retain only operational metrics such as source health, recommendation
  telemetry, and managed-cache usage.
- Library combines the local scan settings and configured remote sources.
- Access is visible to super administrators in production and development.
  Anonymous Library browsing and playback default to disabled; changing the
  switch applies to the production access boundary and creates an audit entry.
  Development still authenticates every request as root, so the setting remains
  visible and editable there without creating an anonymous development session.
- Each enabled remote source has an explicit health-check action. The result is
  persisted through the same source health state used by automatic probes.
- Remote sources default to compatible public storage hosts. Source
  configuration can enable **Restrict outbound hosts** to allow only the API,
  Public site, Fallback, and an editable list of exact or `*.example.invalid`
  public host patterns.
- Routing rules are ordered preferences. Their timeline position determines
  internal priority; disabled and numeric-weight controls are not exposed.
- Recommendation starts with named common profiles, exposes result variation
  and discovery boost, and keeps the state-mix slots, affinity baseline,
  weights, and caps under Advanced scoring.
- Cache & Fetch presents editable policy first, followed by managed-media usage
  and cleanup controls. Its configuration is a vertical list; resolved save
  paths are read-only previews owned by Paths.
- Cache & Fetch includes the per-file remote media limit and the retention age
  for unpublished staging from failed or cancelled Fetch runs. The defaults are
  100 GB per media file and seven days of staging retention.
- Cache & Fetch exposes an independent transcode cache limit from 1 to
  4096 GB. It defaults to 5 GB, reports prepared audio and HLS segment usage and
  available quota, and provides a confirmed clear action. This rebuildable cache lives
  under `/cache/transcodes` and does not change the managed remote-media cache
  limit.
- Managed media cache cleanup is grouped by source scope. Groups can be
  collapsed and selected as a unit while the bounded list scrolls independently
  for large libraries. Cleanup remains a two-step destructive action.
- Paths is read-only and shows the resolved data root, cache root, default
  cache/save previews, and per-source save previews. Remote Source configuration
  shows the same resolved example instead of exposing a path-template editor.

## Work management

The **Work management** sidebar entry → **Pending works** lists existing work families needing attention. Filter by **All needing attention**, **Metadata issues**, or **No available source**. Search, paging, covers, and selection are shared. Each family occupies one row, with multiple reason badges and expandable affected editions/provider details. Successful metadata updates remove only the corresponding issue; a work with no available source stays visible.

Select families and choose **Retry metadata**; its count includes only eligible selections. You can also retry an affected edition from its details, including products previously reported unavailable. Failed retries preserve existing metadata and manual overrides. **Check sources** applies to selected families without a source. Confirmed deletion of local information is available only in the **No available source** view; the server rechecks availability and retains media files.

**Open metadata issues** in Activity opens Work management filtered to that run's unresolved metadata issues; **Show all pending works** removes the run filter. Recovery never changes another user's Activity review. Metadata recovery requires `metadata:sync`, while source checks, deletion, and source/language settings require `sources:write`. The **Metadata settings** tab contains settings only. **Open metadata sync** opens the existing workflow in Workflows; this page does not duplicate its configuration or run controls. Old Maintenance links redirect here.

Metadata settings let administrators choose and reorder the supported DLsite
  title/tag languages. `Origin` is always retained as the final fallback. Each
  compatible remote source also has its request-language hint on this tab; the
  upstream may ignore it, fall back, or return mixed-language metadata.

## Related Docs

- [Configuration](../../operations/configuration.md)
- [Security](../../operations/security.md)
- [Sources](sources.md)
