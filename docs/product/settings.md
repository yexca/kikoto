# Settings

Settings exposes per-user account and appearance preferences. Instance and user
administration remain in Maintenance.

## Current Settings

- Update the authenticated user's display name.
- Change an account-managed user's password after verifying the current
  password and confirming the replacement.
- Keep username and role visible but read-only.
- Light, dark, and system appearance preferences.
- Pink, blue, and green accent-color preferences.

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

Demo mode renders Settings read-only.

## Maintenance Organization

- Maintenance opens with a concise administration description instead of
  repeating editable configuration values as summary statistics. Detail tabs
  retain only operational metrics such as source health, recommendation
  telemetry, and managed-cache usage.
- Library combines the local scan settings and configured remote sources.
- Each enabled remote source has an explicit health-check action. The result is
  persisted through the same source health state used by automatic probes.
- Routing rules are ordered preferences. Their timeline position determines
  internal priority; disabled and numeric-weight controls are not exposed.
- Recommendation starts with named common profiles and keeps the full scoring
  priors, weights, and caps under Advanced scoring.
- Cache & Fetch presents editable policy first, followed by managed-media usage
  and cleanup controls. Its configuration is a vertical list; resolved save
  paths are read-only previews owned by Paths.
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
