# Unreleased

- Shared frontend reads are isolated by session/server generation. Account changes
  and writes invalidate pending reads, including reads started during a write;
  individual callers retain independent cancellation.
- Logout clears the client cookie but reports a retryable failure if persistent
  session revocation fails. Bearer and cookie credentials are revoked together.
- Remote work and track caches validate current enabled source configuration and
  outbound policy. Source changes detach old calls and reject late results.
- User demotion, disabling and deletion retain an enabled super administrator in
  the same write transaction as the change and its audit record. Partial updates
  and environment-managed account restrictions use that transaction's state.
- Manual covers publish a new complete asset before changing the database
  reference. Failed or oversized copies preserve the saved cover; replacement,
  reset and startup cleanup remove unreferenced assets.
- Schema 059 versions local files by size and nanosecond modification time.
  Rescanning a changed file clears duration/audio metadata, including same-size
  replacements, and late probes cannot overwrite newer observations. Work,
  media and personal-state identities remain stable. Existing databases apply
  `059_local_media_file_version.sql`; fresh installs use `059_v0.7.1.sql`.

- The expanded desktop sidebar is narrower, giving pages 40px more width at the
  default font size, and its width now follows the browser's default font size
  so navigation labels keep their room. The collapsed rail keeps its width.
- Text previews and lyrics decode GBK and GB18030 files, which previously
  appeared as Latin mojibake. A file that mixes UTF-8 lines with one legacy
  encoding, or carries a few corrupt bytes, keeps its detected Japanese or
  Chinese text instead of falling back to a single-byte charset, and a
  single-byte charset declared by a remote source no longer overrides a
  confident Japanese, Chinese, or Korean detection.
- Metadata settings are reorganized. **Catalog freshness days** moves to a
  new **Creator catalogs** section in `Settings -> Library` with its own
  **Save catalog settings** button, and **Remote metadata fallback** moves to
  **Configure** on the Metadata sync workflow, offered to administrators with
  `sources:write`. The Metadata page's settings popover keeps the DLsite proxy
  shortcut and links to both as **Catalog freshness** and **Remote metadata
  fallback**.
- The instance-wide default metadata language is removed. Stored and shared
  metadata (projected titles and tag names, background syncs, creator catalog
  refreshes, remote metadata fallback, and Activity text) always uses each
  work's original language, and `GET`/`PATCH /api/settings` no longer carry
  `dlsiteMetadataLanguage(s)` (PATCH ignores them). On upgrade, startup removes
  the old setting; if it held a language other than Origin, the startup
  metadata tag backfill projects stored titles and tag names again in the
  original language. No schema change is involved.
- Metadata → Tags is keyed and ordered by the shared tag ID, so the list no
  longer depends on a language setting. The ID cell also shows the DLsite genre
  id and, only for hidden or merged tags, their status. Columns show the name
  each of Japanese, Simplified Chinese, Traditional Chinese, English, and
  Korean displays, with all-language manual names muted, followed by **Other
  names**, Works, and Manage. Search also matches remote-source names, and a
  numeric query matches the tag ID or DLsite genre id. On narrow screens the
  table scrolls sideways in its own box with Manage pinned to the right.
- The metadata editor on work detail and Metadata → Works is reorganized into
  Title, Cover, Tags, Credits, and Metadata source sections that mark unsaved
  changes. Every language title has its own row, covers are picked from a
  thumbnail grid, and circle, series, voice actor, and tag fields complete from
  suggestions with keyboard selection while keeping identifiers visible. Each
  tag's names can be edited by language from the work editor, including names
  for a new custom tag; renaming a shared tag applies to every work that has it. Reverts
  and metadata link changes are now drafts applied by Save instead of taking
  effect immediately and closing the editor, and Cancel confirms before
  discarding drafts.
- Preferred metadata language is now a personal choice for every signed-in
  user in the header Appearance menu. It selects that user's titles,
  introductions, tag names and default detail edition, sorts lists by the
  titles shown, and leads that user's remote-source requests. Without a choice
  it shows **Origin**, each work's original language, which anonymous visitors
  also see; choosing **Origin** clears the preference. A work's shared
  tags always come from its original edition, so every language shows the same
  tags. Remote sources replace the per-source request language with a
  **Fallback language** in the source dialog: requests send the viewer's
  languages first and the fallback last, while viewers on Origin, anonymous
  visitors, and background jobs such as crawls, downloads, and fallback
  lookups ask in the fallback language only. Cached remote works are separated
  by language. Tag name learning covers every language some user prefers.
  Schema 056 adds the personal preference and per-language sort titles, and is
  packaged in `056_v0.7.1.sql`; the schema-055 development baseline is retired
  with its checksum kept for upgrades.
- Language-scoped manual titles follow configured language priority before DLsite
  editions. Editors directly edit owned manual titles, show inherited/provider
  sources as hints, preserve drafts across resets, and save only changes.
  Language menus never infer a language from request locale or a universal title.
  Leading translation labels are recognized by format on every non-original edition,
  only for provider display, preserving raw values and authored titles. Detail
  introductions follow the selected edition as verbatim plain text; playback queues use the display
  title. Unsupported edition entries retain their own cleaned titles, circle and
  voice actor titles load in batches, and every manual title language remains searchable.
  An all-language manual title replaces only the displayed text, so it no longer
  moves the default edition, introduction, or tags back to the original. An
  original edition without a declared language is labelled only Original.
- Tag names for preferred languages are learned in the background: for each
  preferred non-Japanese language, Learn tag names asks DLsite once for the
  work covering the most unnamed genres, so requests scale with missing genres,
  not works, and Japanese-only works show translated tag names. It runs after
  startup, metadata syncs and language changes, follows the existing request
  pacing, proxy and outbound policy, resumes after interruption, reports
  progress and failures in Activity, never stores titles, works or snapshots,
  and never repeats an answered request. Schema 055 adds the learning state.
- Opt-in remote metadata fallback: when DLsite explicitly reports a work as not
  found, a metadata refresh asks the selected metadata-capable remote sources in
  the configured order, once each through workInfo (reusing cached catalog
  JSON), and fills title, release date, circle, tags, and a missing cover.
  Retryable DLsite failures never contact remote sources, and no work is
  created. Every value records its remote source; the detail says DLsite has no
  record and names the filling source, the title editor and Metadata issues
  name it too, and later DLsite data takes over. Remote tags join shared tags
  only while the fallback uses their source. Several remote sources now apply
  in a deterministic order instead of last-writer-wins. Requests stay on the
  configured origins with bounded size and time. Schema 054 adds the
  provenance and provider tag name tables; the schema-053 and schema-054
  development baselines are retired with their checksums kept for upgrades.
- Admin tag merge targets label hidden tags and explain that the merged tag will
  be hidden on all works. Remote tags are documented on voice actor remote-work
  lists in all five languages.

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
  names follow the viewer's metadata language priority and learned dictionary.
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
- Schema 053 added language-scoped titles; released baselines remain intact.
  Existing `main` and metadata development databases retain their original
  migration history and receive the missing changes through separate immutable
  paths that converge at schema 053. Historical metadata schema-051/052 and
  development schema-050 baseline checksums remain available for upgrades.

Changes through v0.7.1 are summarized in [v0.7.1](v0.7.1.md).

## Remote metadata titles

Remote sources can supply language titles through the edition relationships
and sibling titles already returned in their work metadata. These titles join
the library's language priority, detail language menu, title editor, title sort
and search while the work has no DLsite metadata. They do not create additional
library works or file locations, and no sibling lookup is performed.
The shared title uses the original edition; personal language preferences
select from the stored titles without changing shared metadata.

Migration `057_remote_language_titles.sql` queues existing remote snapshots
for background projection. New installations use `057_v0.7.1.sql`, generated
from the current `VERSION`; existing installations continue through the
numbered migration chain. See [migration guidance](../development/migrations.md).

## Purchase bonus metadata

A purchase bonus such as an early purchase bonus (`【早期購入特典】`) is a free
DLsite product that does not name the work it belongs to, so it used to show
only its own title. Metadata sync now links it to that work by checking the
circle's works in the library and the nearest codes on the circle's DLsite page.
A bonus links only when its title reading, or its release date and quoted title,
names exactly one work. The **Link purchase bonuses to their work** switch in
the Metadata sync Configure popover is on by default. A library editor can also
link or unlink a bonus in the metadata editor's Metadata source tab.

A linked bonus stays its own work with its own title, files, cover and
playback. It takes the tags, voice actors and series it lacks from the parent.
Its detail links to the parent, and the parent's detail lists its bonuses. The
parent code never becomes a library work.

Migration `058_work_purchase_bonus.sql` adds the link table. New installations
use `058_v0.7.1.sql`; existing installations continue through the numbered
migration chain. See [migration guidance](../development/migrations.md).
