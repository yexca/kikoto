# Remote Metadata Fallback

How a remote file source describes a work without creating a second identity.

Remote file sources may describe works, but they never create a work or a
second identity. A source declares the ability in `file_source.config_json`
`capabilities`. Only Kikoeru-compatible source types support `metadata`; a
config without the list keeps that type's default, and an explicit list,
including an empty one, is authoritative. Code checks the declared capability
and source type, never a display name. A remote source's provider identity is
`kikoeru_source_<source code>`.

`app_setting.remote_metadata_fallback` is the instance policy
`{"enabled", "sourceIds"}`, default off with no sources. `enabled` gates the
lookup after DLsite reports a work as not found and the folding of remote tags
into shared tags. `sourceIds` lists at most 16 distinct metadata-capable
sources and forms the fallback order. Every remote source is ranked, with the
selected ones first in that order and the others by source priority and id.
The ranking decides every stored remote value, independent of which source
wrote last.

The metadata workflow stores `sourceId`, `workCodes`, `remoteMetadataFallback`
and `purchaseBonusAutoLink` alongside its scope and mode in run and job JSON.
Trigger JSON holds the same options except `workCodes`, because selected works
never run from a trigger. These are execution options, not instance-setting mutations, and a bulk
run's fallback choice is independent of the instance policy. Retries keep the
saved values. A per-work refresh without a selected source snapshots the
instance policy and the purchase-bonus auto-link setting into its job when it
is queued.

`remotemetadata.ReconcileWorkTx` derives a work's normalized fields from the
latest stored snapshot of each remote provider. Snapshots are untrusted:
non-objects, missing codes, titles over 2048 bytes, circle names over 512 bytes,
more than 256 tags, tag names over 512 bytes, more than 16 localizations per
tag, more than 32 entries in either edition collection, or snapshots over
8 MiB are skipped as a whole with a protected log.
Release dates must start with `YYYY-MM-DD`. For each field the first-ranked
source with a value wins. Without DLsite (or another non-remote provider)
metadata, the winner replaces title, release date, age rating and duration;
with it, remote values only fill an empty field.
`work_metadata_field_source` records the provider of each
remote-filled value (`title`, `release_date`, `age_rating`, `duration`,
`circle`, `tags`, `cover`). It holds rows only while the work has no DLsite
metadata; projection clears them when DLsite data arrives, so DLsite always
takes over.

`remote_metadata_title_variant` holds the first-ranked
provider's title per supported language and original edition for an existing
work. A title's language comes from the provider's edition declarations,
never the request locale or title text. `language_editions` supplies code and
language relationships; `other_language_editions_in_db` supplies the titles
already returned for sibling codes. A source-local numeric id alone is not an
edition code. A relationship without a title creates no language choice and
causes no additional request, work, alias or file availability. Raw snapshots
remain the provenance source; projection reads no remote catalog.

The shared title projection always uses the original edition when it has a
stored title; otherwise it keeps the source's own title as the fallback.
Each viewer selects their own title from the stored variants. The title
editor, detail language menu, title sort and search share these values.
Snapshot refreshes and source-order changes replace the projection through the
bounded queue. Turning the fallback off retains these titles as passive
metadata; DLsite takeover removes the remote projection and never fills a
missing DLsite language from a remote source.

The winning circle name links an existing circle by name or confirmed alias.
Only an active fallback source (switch on, selected, capable, enabled) may
create a new circle without a maker id; such duplicates can be merged in the
circle view. One remote circle relation is kept per work, from the winner, and
a manual or DLsite circle keeps precedence. A fallback cover is cached only when
the work has no cover, so an existing DLsite cover is never replaced.

While the fallback is enabled, the first active source whose snapshot declares
tags supplies a remote-only work's shared-tag base. Each tag reuses the concept
whose display, manual, dictionary or provider name equals its primary or any
localized name, ignoring case, so a remote name matching a DLsite genre joins
that genre. An unmatched tag gets the same deterministic `dlsite-name:<hash>`
concept as an imported name without a genre id. Its localized names go to
`metadata_tag_provider_name`, only for concepts without a genre id and only
into absent cells. They rank after manual and dictionary names in display
precedence, are searchable, and invalidate search when they change. Remote
refreshes reach the durable projection queue through the snapshot triggers, so
tags follow the latest snapshot.

`work_metadata_sync_state` and `work_metadata_provider_state` record remote
providers' outcomes as well as DLsite's. When DLsite reported the work not found
and remote values remain, the detail's `metadataSync.status` is
`remote_fallback`, with the filling source and per-field sources, and the
Metadata issue list names that source on the DLsite row.

Turning the switch off stops new lookups and requeues every work with a remote
snapshot. Remote tags then leave shared tags and their snapshot display
returns. Filled titles, dates, circles and covers, their provenance and the
snapshots stay as passive remote data under the same ordering until DLsite or
manual values replace them. Changing the order, or a source's enabled state or
capability, requeues the affected works the same way, and pending remote issues
of a source the fallback does not use are cleared.
