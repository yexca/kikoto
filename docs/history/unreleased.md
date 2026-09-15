## Metadata and scans

- Expand Unlinked works into Work maintenance, combining metadata issues and
  missing sources in one family list with reason/run filters, edition details,
  and selected-work retries. Keep the Metadata tab for settings. Activity links to the
  corresponding outstanding issues while preserving execution and review history.
- Merge repeated failures by work/provider and clear resolved components after
  success. Retain existing metadata on failure and protect newer successful
  updates from stale results. Metadata and cover failures are tracked separately.
- Coordinate overlapping DLsite family requests within one application instance.
  Recovery requires metadata synchronization permission without granting access
  to source configuration.

## Operations and reliability

- Add numbered migration `033_metadata_sync_issues.sql` and the generated
  `033_v0.5.5.sql` fresh-install baseline. Existing databases upgrade through the
  numbered chain; structured unavailable-product observations enter the recovery
  list. Historical free-text errors remain in their original Activity records.
