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

Demo mode keeps account-backed Settings read-only. Appearance and playback
controls remain available because theme mode, style, color, and seek intervals
are browser-local preferences and do not modify Demo server data. Playback
preferences are isolated by server identity and authenticated user, or by the
anonymous principal when anonymous access is enabled.

## Personal Playback And Recommendations

Settings uses Account, Playback, and Recommendation tabs. Playback contains local seek intervals and **Folder preference**: ordered folder matching and exclusion rules. Recommendation contains presets, badge threshold, variation, discovery boost, and advanced scoring. These two migrated preferences are stored per authenticated account on the server; changing them never changes another account. An account without overrides and anonymous browsing retain the existing instance defaults. Old Maintenance Routing and Recommendation links open the corresponding Settings tab.

Saving recommendation settings creates a new recommendation session for the current tab. Other open tabs keep their existing snapshots until a new session is created. Saving folder preferences updates subsequent directory selection without stopping the player. Failed saves retain the draft and the previous persisted values. Demo mode keeps these server-backed preferences read-only.

Appearance is available only from the header menu. The globe option follows the browser or device language; its tooltip and accessible name identify automatic selection.

## Maintenance Organization

Maintenance uses one horizontal row of tabs, scrolling horizontally on narrow screens. Overview is removed; Library is the default for source administrators, and Users is the default for user-only administrators. Old Paths and Access links open Library and Users respectively.

- Maintenance opens with a concise administration description instead of
  repeating editable configuration values as summary statistics. Detail tabs
  retain only operational metrics such as source health, recommendation
  telemetry, and managed-cache usage.
- Library combines local scan settings, configured remote sources, and read-only storage paths.
- Instance access settings appear under Users for super administrators in production and development.
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
- Maintenance contains Library, Cache & Fetch, and Users. Library includes a collapsed, administrator-only recommendation telemetry section.
- Cache & Fetch presents editable policy first, followed by managed-media usage
  and cleanup controls. Its configuration is a vertical list; resolved save
  paths are read-only previews in Library.
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
- Storage paths in Library are read-only and show the resolved data root, cache root, default
  cache/save previews, and per-source save previews. Remote Source configuration
  shows the same resolved example instead of exposing a path-template editor.

## Metadata

The **Metadata** sidebar entry sits directly below **Workflows**. Its horizontal categories are **All**, **Needs attention**, **Metadata issues**, and **No available source**. All includes every saved work family, including metadata without pending issues; the other categories show the applicable attention reasons. Search, pagination, covers, selection, and affected edition/provider details are shared.

Use **Metadata settings** at the upper right to open settings in a dialog; closing it preserves the current list and filters. **Metadata sync** opens the existing sync workflow, where you choose the scope and start it.

Select families and choose **Retry metadata**; its count includes only eligible selections. You can also retry an affected edition from its details, including products previously reported unavailable. Failed retries preserve existing metadata and manual overrides. **Check sources** applies to selected families without a source. Confirmed deletion of local information is available only in the **No available source** view; the server rechecks availability and retains media files.

**Open metadata issues** in Activity opens Metadata filtered to that run's unresolved metadata issues; **Show all pending works** removes the run filter. Recovery never changes another user's Activity review. Metadata recovery requires `metadata:sync`, while source checks, deletion, and source/language settings require `sources:write`. The **Metadata settings** dialog contains settings only. **Metadata sync** opens the existing workflow in Workflows; this page does not duplicate its configuration or run controls. Old Maintenance links redirect here.

Metadata settings let administrators choose and reorder the supported DLsite
  title/tag languages. `Origin` is always retained as the final fallback. Each
  compatible remote source also has its request-language hint in this dialog; the
  upstream may ignore it, fall back, or return mixed-language metadata.

## Related Docs

- [Configuration](../../operations/configuration.md)
- [Security](../../operations/security.md)
- [Sources](sources.md)

Metadata uses `/metadata`. Old `/work-management` links still work and retain their filters or settings context. First-sync failures and pending metadata results open Metadata issues; operators without workflow permission see the unscoped issue list. Run diagnostics remain in Workflows Activity.
