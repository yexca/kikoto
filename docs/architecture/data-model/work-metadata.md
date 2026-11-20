# Work Metadata

The tables behind a work, its editions, metadata snapshots and sync state, the people and circles credited on it, and how metadata languages are chosen.

Important tables:

- `work`
- `logical_work`
- `work_edition`
- `work_code_alias`
- `custom_work_code_counter`
- `work_external_id`
- `work_metadata_link`
- `work_purchase_bonus`
- `work_bundle_member`
- `work_manual_override`
- `metadata_provider`
- `metadata_snapshot`
- `metadata_snapshot_card_summary`
- `party_metadata_snapshot`
- `dlsite_metadata_variant`
- `work_title_language`
- `remote_metadata_title_variant`
- `work_metadata_field_source`
- `work_metadata_sync_state`
- `work_metadata_provider_state`
- `metadata_sync_attempt`
- `metadata_sync_attempt_work`
- `metadata_sync_attempt_run`
- `tag`
- `work_tag`
- `metadata_tag`
- `metadata_tag_name`
- `metadata_tag_provider_name`
- `work_tag_override`
- `work_dlsite_genre`
- `dlsite_genre_name`
- `dlsite_genre_name_request`
- `dlsite_genre_name_gap`
- `party`
- `work_party`
- `party_alias`
- `party_merge_review`
- `party_catalog_item`
- `party_catalog_refresh_state`
- `person`
- `person_alias`
- `person_merge_review`
- `work_credit`
- `person_external_id`
- `work_staff_credit`
- `work_snapshot_projection`

DLsite metadata sync stores raw snapshots and updates normalized fields used by
library and detail views.

`work_party` relates a work to a circle (`role = 'circle'`) and records the
provider that supplied the relation; `work_credit` relates a work to a person
in a role such as `voice_actor`. `person_external_id` records a provider's
voice actor id for a person (`id_type = 'voice_actor_id'`), scoped to that
provider: the DLsite creator id from a DLsite snapshot, or a remote source's
own id. The provider id, not the name, identifies a voice actor: two people may
share a display name. Credit projection resolves a credited voice actor by
that id first. An id seen for the first time binds to the voice actor credited
by name before the id was known: among the people of that name, the one who
carries no id of the same provider, or, when several carry none of it, the
one who carries no id at all. When no person displays the name, it binds to
the one person holding the name as a confirmed alias, if that person carries
no id of the provider. In every other case the id gets a new person with the
plain name, so it never binds to a namesake who carries another id of the
provider; an administrator who knows two ids name one voice actor merges
them. A credit without an id resolves by name alone: the one person of that
name, or, when several share it, the person among them who carries no voice
actor id (the earliest when several carry none), never a namesake a provider
id identifies. When every one of them carries an id, a new person with the
plain name takes the credit, marked `person.ambiguous_name`, and later
credits of the name reuse it; no provider id binds to that person and no
projection merge absorbs it, so the credits it holds never move to one of the
identified namesakes. A name no person displays resolves through a confirmed
alias only when one person holds it.
`person.id` stays the voice actor's identity, and one person may hold several
ids. A work's voice link by name links to a credited voice actor only when
the name matches exactly one of them.

A person resolved by a provider id is named by that provider's spelling on an
original edition, so a provider rename renames the person and keeps the former
name as an alias. A translated edition (a non-canonical `work_edition`) adds its
spelling as an alias and names the person only while no original edition's
snapshot of the same provider credits them. A name an administrator merged into
the person never replaces the display name they kept. A person whose display
name is the snapshot's spelling of a resolved id is the same voice actor
credited by name before the id was known: projection merges the two through the
same recorded, undoable merge an administrator makes, so each id is one person
credited once per work. When several people of that spelling could be that
voice actor, when another person of that spelling carries an id of the same
provider, or when the person was made for an ambiguous name, projection
merges none of them. When the spelling names the voice actor, the person
already displayed under it survives, unless an administrator merged that name
into the person carrying the id; otherwise the person carrying the id survives.
Projection keeps them apart when the other person carries another id of
the same provider or an administrator undid a merge of the two; when a manual
override credits the other person, it stays apart and loses only its snapshot
credit on the projected work.

A voice actor's detail URL is `/voices/{routeKey}`. The route key is the
person's canonical DLsite voice actor id: among its numeric `voice_actor_id`
rows of the built-in `dlsite` provider, the primary one, then the lowest row
id. A person without one has the key `local-{person.id}`. Remote-source voice
actor ids never become route keys, so a bare number in the URL is always a
DLsite id. The server sets the key on every voice link it returns and resolves
a key to its person through `GET /api/voice-routes/{routeKey}`; another DLsite
id of the same person, such as one a merge moved to it, and the local key of a
person that holds a DLsite id resolve too and report the canonical key, which
the page then shows in the URL. The other voice APIs stay keyed by
`person.id`.

`work_staff_credit` holds a work's non-voice DLsite credits: the author,
scenario writer, illustrator, composer, and other staff (`role` is `author`,
`scenario`, `illustration`, `music`, or `other`), each with its provider order
and DLsite creator id. A staff name is a plain credit of the work, not a
`person`: it never appears among voice actors, aliases, merges, or
subscriptions. The projection replaces a work's snapshot-owned staff rows, so a
staff credit the latest DLsite snapshot no longer names is removed.

A work's voice credits are projected from its latest snapshot of any provider
and, when that snapshot belongs to another provider, also from its latest
DLsite snapshot. A voice actor the DLsite snapshot credits therefore carries
the DLsite creator id whichever provider fetched the work last, and a remote
snapshot's id is bound to the same person when both snapshots credit the same
name. The DLsite credits are written last, so DLsite stays the provider of a
credit both snapshots name. One snapshot crediting no voice actor adds the
unknown voice actor only when the other credits none either, and a work that
credits a real voice actor loses its snapshot credit of the unknown voice
actor, such as one an earlier snapshot that named none left. Staff credits and
DLsite circle relations are projected from the work's latest DLsite snapshot.
`work_snapshot_projection` records,
per work and projection, the snapshot and a hash of the projection input it
last produced. Startup and each metadata sync project only works whose latest
snapshot changed since that record, in bounded batches; a new snapshot whose
projection input is unchanged, such as a new sales count, writes nothing but
the record. Triggers drop a record when a credit or circle relation is removed
or reassigned, or when the work's imported circle catalog row changes, so the
next pass restores what the snapshot still declares. The voice credit
projection removes no credit its snapshots do not name, apart from the
duplicate credits of one provider id described above. `party_metadata_snapshot` keeps the two
latest snapshots per circle and provider, as `metadata_snapshot` does per work.

`metadata_snapshot_card_summary` holds one compact, versioned card summary per
snapshot (circle, base and edition codes, release date, rating count, series,
tags, and voice actors) so Library and voice lists do not decode the raw
snapshot for every row. It is a derived cache of `snapshot_json`, not a second
metadata source: triggers drop the summary when the snapshot content changes
and queue the snapshot in `metadata_snapshot_card_summary_dirty`, and the
server rebuilds queued or outdated-version summaries in small background
batches. A row without a current summary is read from the raw snapshot.

`work_metadata_sync_state` records the latest synchronization outcome for each
work, metadata provider, and component (`metadata` or `cover`). Failed and
unavailable components form the metadata reasons in Work maintenance. State
remains per edition/provider/component; the maintenance read combines these
with live missing-source reasons and pages one selectable row per work family.
Repeated failures update the component state; a newer success clears only
that component's pending state. `dismissed_at` marks an unavailable component
an operator dismissed, which is then no longer pending; a newer outcome with
another status clears it. Failed requests retain existing metadata,
and provider updates do not change `work_manual_override`.

Attempts receive a durable increasing id before family requests start. The
latest successful attempt protects stored metadata against stale successful
responses; current state also rejects stale failures. Attempt/work outcomes and
attempt/run associations let the run lists link to outstanding problems without
changing run results or another user's reviews. Once an attempt's issue has
been resolved, a later failure does not reopen its old run association.
Shared issue responses contain fixed statuses rather than upstream error text.
Failure tracking never creates a work solely from a discovered catalog code.

## Metadata Language

For DLsite, `dlsite_metadata_variant` stores the title and tags of each
provider-declared language edition in a logical work family, one row per
edition work. The `origin` display token refers to the canonical edition even
when its source language is not Japanese. A language priority only changes
the normalized title/tag projection; the request locale and the raw snapshot
remain provenance data.

Metadata language has two scopes. Everything stored or shared uses each work's
original language (the `origin` priority): the projected `work.title`,
`tag.display_name`, background syncs, catalog snapshots, remote metadata
fallback and run text. There is no instance-wide language setting. A
signed-in user may store an own priority in `user_preference.metadata_languages`
(`NULL`, also stored when the user picks `origin`, means no preference). It
changes only what that user's requests present: selected titles and
introductions, tag names, the default detail edition, title sorting, and live
remote-source requests. Requests without a user use the original language. No
stored provider value depends on a personal priority, and a personal change
rewrites nothing. Every Demo visitor shares one account, so in Demo the
priority arrives with each request as a comma-separated
`X-Kikoto-Metadata-Languages` header, an absent or invalid header means no
preference, and the shared account's stored value is ignored. Demo responses
vary on that header. Other modes ignore it.

The startup metadata tag backfill deletes the unused instance keys
`app_setting.dlsite_metadata_languages` and `app_setting.dlsite_metadata_language`
when present. When either holds a language other than `origin`, the same step
first sets `metadata_projection_pending`, so the backfill projects stored
titles and tag names again in the original language.

`work_title_language` holds each work's title for every language that title
selection can stop at: each supported language with its own edition, language-specific manual title or
description, or accepted translation field, and always `origin`. Selection over a priority
therefore equals the first present row in that priority, so a title sort reads
`COALESCE` over the viewer's languages and falls back to `work.title` while a
work is queued. Triggers on editions, variants, title overrides and work titles
queue whole families in `work_title_language_dirty`; the search index worker
rebuilds them in bounded batches.
