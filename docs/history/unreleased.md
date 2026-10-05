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
  Hide/merge/undo commit their state and durable related-work queue together;
  bounded background batches retain each work's old links until replacement,
  retry after failures/restarts, and update search and recommendation inputs.
  The worker drains consecutive batches, recovers reduced batch sizes, and
  defers failed works with durable backoff so they do not block later works.
  Management shows the remaining instance-wide work count.
  Startup backfill is independent of core workflows, batched and safely repeatable.
  Snapshot-only tags retain fallback until their per-work projection completes;
  an intentionally empty DLsite projection stays empty. Snapshot fallback is
  DLsite-only, fills absent dictionary cells without guessing language, and skips
  malformed or over-limit input with protected logging. Remote tags retain their
  existing snapshot display.
  Snapshot writes retain authoritative empty tag sets while repair is pending;
  snapshots can safely outlive deleted works. Manually added shared tags are
  shown alongside remote catalog tags.
- Metadata groups Works separately from Tags, Circles, and Voice actors. Work
  editors support shared tag completion, custom tags, removal, and DLsite reset.
  Custom tags stay as drafts until work save, which reuses exact existing names
  in any language after trimming and ignoring case. Hidden matches are labelled
  and cannot be silently created; server conflicts keep drafts intact. Locale
  manual names precede universal manual names, which precede provider names.
  Completion shows merged names as the final target while retaining exact-name
  reuse and hidden-target notices.
  Cancel leaves no orphan.
  The Voice actors label is updated in all five languages with alias deep links
  retained. Management reads follow Metadata-page permissions; Demo restricts
  entries and work counts to demo works and withholds circle merge history.
- Circle management supports manual names, confirmed aliases, and reviewed,
  reversible merges that transfer creator relations and personal circle data.
- Schema 051 is packaged in `051_v0.7.1.sql`; released baselines remain intact.
  The superseded development schema-050 baseline is retired with its ledger
  checksum retained for upgrades.

Changes through v0.7.1 are summarized in [v0.7.1](v0.7.1.md).
