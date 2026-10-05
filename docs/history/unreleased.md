# Unreleased

- Metadata edits send only changed fields; PATCH leaves omitted fields intact.
  Cover-only edits no longer freeze projected titles or creator metadata.
- Admin now has `library:write` for work metadata, covers, metadata links,
  untracking sources, shared tags, and circle identity changes.
- Remote covers use the nested cache layout, preserve existing provider covers,
  and publish complete files by portable rename with serialized concurrent
  writers. Old flat files migrate in the background, continuing past individual
  file errors and retrying failures next startup.
- Migration 048 removes only title overrides exactly matching a trimmed
  provider title in the same work family; other authored overrides and malformed
  JSON values are kept without preventing startup.
- Shared metadata tags have stable identities, manual locale names, global
  hiding, reversible merge mappings, and per-work additions/removals. Display
  names follow the configured metadata language priority and learned dictionary.
  Effective tags drive display, multilingual search, workflows, and recommendation
  similarity. Normal sync refreshes only learned tag names immediately. Detail
  language switches prefer names in that variant's locale. Merged source names
  remain searchable; only the final target's hidden flag controls visibility.
  Hide/merge/undo project only related works atomically with a bounded deadline.
  Startup backfill is independent of core workflows, batched and safely repeatable.
  Snapshot-only tags retain fallback until their per-work projection completes;
  an intentionally empty projection stays empty.
- Metadata groups Works separately from Tags, Circles, and Voice actors. Work
  editors support shared tag completion, custom tags, removal, and DLsite reset.
  Custom tags stay as drafts until work save, which reuses exact existing names
  in any language after trimming and ignoring case. Cancel leaves no orphan.
  The Voice actors label is updated in all five languages with alias deep links
  retained. Management reads follow Metadata-page permissions; Demo restricts
  entries and work counts to demo works and withholds circle merge history.
- Circle management supports manual names, confirmed aliases, and reviewed,
  reversible merges that transfer creator relations and personal circle data.
- Schema 050 is packaged in `050_v0.7.1.sql`; released baselines remain intact.

Changes through v0.7.1 are summarized in [v0.7.1](v0.7.1.md).
