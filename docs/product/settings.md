# Settings

Settings exposes per-user account and appearance preferences. Instance and user
administration remain in Maintenance.

## Current Settings

- Update the authenticated user's display name.
- Change the authenticated user's password after verifying the current
  password and confirming the replacement.
- Keep username and role visible but read-only.
- Light, dark, and system appearance preferences.
- Pink, blue, and green accent-color preferences.

## Account Boundaries

Changing a password preserves the current session and revokes the user's other
sessions. An administrator password reset from Maintenance revokes every
session for the target user. Role, enabled state, username, and user lifecycle
management are not self-service account settings.

`KIKOTO_ROOT_PASSWORD` supplies the root credential only when one does not
already exist. A password changed in Settings therefore remains authoritative
after restart.

Demo mode renders Settings read-only.

## Related Docs

- [Configuration](../operations/configuration.md)
- [Security](../operations/security.md)
- [Sources](sources.md)
