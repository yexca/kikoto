# Settings

Settings exposes per-user account controls and browser-local appearance
preferences. Instance and user administration remain in Maintenance.

## Current Settings

- Update the authenticated user's display name.
- Change an account-managed user's password after verifying the current
  password and confirming the replacement.
- Keep username and role visible but read-only.
- Light, dark, and system appearance preferences.
- Anthropic, OpenAI, Apple, and Google Material Design style preferences.
- Original, Graphite, Cobalt, and Iris color preferences.

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

Demo mode keeps account-backed Settings read-only. Appearance controls remain
available because theme mode, style, and color are browser-local preferences
and do not modify Demo server data.

## Maintenance Organization

- Maintenance opens with a concise administration description instead of
  repeating editable configuration values as summary statistics. Detail tabs
  retain only operational metrics such as source health, recommendation
  telemetry, and managed-cache usage.
- Library combines the local scan settings and configured remote sources.
- Metadata settings let administrators choose and reorder the supported DLsite
  title/tag languages. `Origin` is always retained as the final fallback. Each
  compatible remote source also has its request-language hint on this tab; the
  upstream may ignore it, fall back, or return mixed-language metadata.
- Access is visible to super administrators in production and development.
  Anonymous Library browsing and playback default to disabled; changing the
  switch applies to the production access boundary and creates an audit entry.
  Development still authenticates every request as root, so the setting remains
  visible and editable there without creating an anonymous development session.
- Unlinked works is a dedicated paged maintenance tab for logical work families
  with no available source or media location. It supports source rechecks and
  confirmed deletion of local database information while retaining media files.
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
- Cache & Fetch exposes an independent video transcode cache limit from 1 to
  4096 GB. It defaults to 5 GB, reports current HLS segment usage and available
  quota, and provides a confirmed clear action. This rebuildable cache lives
  under `/cache/transcodes` and does not change the managed remote-media cache
  limit.
- Managed media cache cleanup is grouped by source scope. Groups can be
  collapsed and selected as a unit while the bounded list scrolls independently
  for large libraries. Cleanup remains a two-step destructive action.
- Paths is read-only and shows the resolved data root, cache root, default
  cache/save previews, and per-source save previews. Remote Source configuration
  shows the same resolved example instead of exposing a path-template editor.

## Related Docs

- [Configuration](../operations/configuration.md)
- [Security](../operations/security.md)
- [Sources](sources.md)
