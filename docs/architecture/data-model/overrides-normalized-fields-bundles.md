# Overrides, Normalized Fields and Bundles

Manual metadata overrides and title resolution, the normalized work columns and metadata links, purchase bonuses, and bundle membership.

## Manual Overrides and Titles

`work_manual_override` has primary key `(work_id, field_name, language)`. Only
`title` and `description` allow a nonempty language (`ja-jp`, `zh-cn`, `zh-tw`,
`en-us`, `ko-kr`); every other field uses the universal `language = ''`. Search
invalidation triggers on title, circle, series, and voice actor overrides also
fire on a language-only update.

Display title selection picks the first preferred language with its own manual
title or description, provider edition or accepted translation, then shows its language manual title, the universal
manual title, the matching provider edition title, an accepted machine title, or
the original title. A universal manual title replaces only
the text: it never selects an edition, so the default edition, description, and
tags match the presentation without it. `origin` matches the canonical
edition's declared language and never infers a language from text or request
locale. Unknown origin languages use the universal manual title or original
title. Descriptions use a separate priority: the language's manual description, the
universal manual description, the matching provider introduction, then an
accepted machine introduction. A language's manual description replaces only
the introduction; the title keeps its own priority. A title-only
translation without a matching edition retains the original introduction. A
matching edition without either introduction remains empty.

`metadatatitles` holds the shared pure selection/display policy. Every
non-canonical edition is a translation, independent of translator classification.
One leading DLsite language-edition label is recognized by its suffix format,
including unsupported languages such as `【ドイツ語版】`; genre labels remain.
Provider projections and raw snapshots are untouched, and authored titles and
unrelated brackets survive. Batched HTTP presentation applies the policy to
cards, search results, circle and voice actor lists without reading introductions.
Each edition list entry uses its own provider title, never a sibling's title.
Detail variants carry their effective title and
plain-text introduction, including manual-only language choices. Universal manual
titles and descriptions overlay existing choices without creating a language; a language-specific manual title or description, or an accepted machine field, may add a choice, and
machine choices carry an LLM marker without adding a media edition. Unknown original languages stay unknown in
the menu, selection and editor sources. All manual languages are
indexed and scoped writes/reset invalidate search. A work without DLsite data
falls back to the title a remote source filled (see
[remote metadata fallback](remote-metadata-fallback.md#remote-metadata-fallback)), then to its own title.
Remote titles may declare a language through `language_editions` and
`other_language_editions_in_db`. Stored titles with declared languages enter
the same priority selection and manual-title precedence; an undeclared title
remains a languageless fallback. Remote titles receive no translation-label
stripping, and their metadata choices never become playable editions or proof
of a successful DLsite synchronization.

`PATCH /api/works/{id}/manual-overrides` updates only supplied fields;
explicit null or empty values reset that field. Omitted relations remain
unchanged. The optional `titles` map updates only supplied language keys;
`null` or empty values remove that language. The compatible `title` field is
the universal value; using both forms in one request is rejected. The
`descriptions` map and the compatible `description` field follow the same
rules. GET returns `titles` and `descriptions` plus the universal `title` and
`description`. DELETE `.../manual-overrides/title?language=zh-cn` or
`.../manual-overrides/description?language=zh-cn` resets only that scope; an
omitted language resets only the universal scope.

An `ageRating` override stores a known rating under its canonical name,
`general`, `r15`, or `adult`. It may fill in a missing provider rating or
make the work's provider rating stricter; any other value is refused with
`400 invalid_age_rating`. The effective rating is the manual one unless the
provider rating is stricter: work detail shows it with the provider value as
`providerAgeRating`, library search matches it, Demo eligibility requires it
to be all-ages, and the content safety assessment uses it. A stored manual value that is not a known rating leaves
the assessment unknown.

## Normalized Fields and Metadata Links

`work.rating_average`, `work.sales_count`, and the current commercial fields are
normalized projections maintained by metadata sync. Interactive rating/sales
filtering and sorting read these columns rather than extracting snapshot JSON.
`regular_price` and `current_price` are integer JPY amounts. A work is marked
`is_permanently_free` only when both prices are zero and the provider does not
report a discount; temporary free campaigns therefore remain ineligible for
Demo mode. Rating, sales, and prices come mainly from DLsite's dynamic product
request. When that request fails, the sync still stores the product, and each
of these columns, the price currency, `is_permanently_free`, and the
snapshot's `dynamic` section keep their stored values unless the product
response itself declares the field.

`work_code_alias` maps provider-declared edition codes to a logical work. An
alias may reference a persisted edition work, but metadata-only aliases do not
create works and do not imply local or remote file availability.

A verified DLsite replacement code has `relationship_kind = provider_reissued`
and `source_work_id` pointing to the existing edition. The edition keeps its
local primary code. Verification requires an exact request returning the
candidate code, `original_workno` matching the local canonical code, and
evidence of the same language edition checked against that edition's stored
DLsite snapshot: either `parent_workno` naming the local edition with the same
provider language on both sides, or a nonzero `edition_id` and nonempty
language exactly matching the snapshot. A product made from the local edition
in another language, or one whose language either side does not name, is a
separate edition in the same family. Ambiguous matches and independently
persisted works retain their own identities. Remote source language lists
supply candidates only; titles and language labels do not prove a
relationship.

Check source reports `editionCode` for the local edition and `remoteCode` for
the product available on each source. Fetch plans and recoverable job payloads
keep both codes: remote requests use `remoteCode`, while folders, manifests,
cache entries, and media ownership use `editionCode`. Fetch requests carry the
selected local `editionCode`; the server checks it against the verified mapping
before planning files or reusing a queued result. Remote persistence
resolves verified aliases before inserting works. An explicitly selected
unknown code is checked for a replacement relationship before persistence;
discovery does not materialize candidate siblings. When DLsite fails or does not
answer within 10 seconds, the relationship stays unverified: the remote work
keeps its own code and the request proceeds. The failure goes to the server
log, never to the remote source's health, and pauses these DLsite checks for
five minutes; DLsite answers used for them are reused for six hours.

`work_metadata_link` records a user-declared DLsite product whose metadata a
work uses, for example when a bonus edition is withdrawn from sale and the
regular edition is sold under another code. Metadata sync for a linked work
requests only the linked code and stores the result on the linked work under
its own code: the snapshot's product codes are rewritten to the work, its
translation and language-edition relationships and its bundle fields
(`work_pack_children`, `work_pack_parent`) are removed, so no bundle membership
is recorded for the linked work, and
`_kikoto.metadata_source_code` keeps the source for traceability. The linked
code never becomes a work, edition, or alias, and its family is not walked.
Saving a link rechecks a work recorded as `not_found`; removing it keeps the
stored metadata until the work's own code is synchronized again.

## Purchase Bonuses

`work_purchase_bonus` attaches a purchase bonus
(`購入特典`, `早期購入特典`) to the family of the product it was distributed with.
DLsite declares no relationship between the two: the bonus has no translation,
edition, or bonus field naming its parent, and its public page is unlisted. The
bonus is not an edition. It keeps its own work, singleton edition family,
playback cursor, availability, Library card and deletion, because every family
reader treats a sibling `work_edition` as an interchangeable language edition.
The row stores the parent by code only; the parent never becomes a work, edition
or alias, and the detail resolves it at read time to the work with that code or
the canonical work of the family declaring it as an alias. A parent's detail
lists linked bonuses whose code belongs to its family.

`status` is `linked` (with `parent_code`), `unmatched` (detection found no
single parent) or `dismissed` (a user removed the link); `origin` is `detected`
or `user`. Detection never replaces a user's link or dismissal, and a dismissed
work is not detected again. Metadata sync stores a linked bonus's own product
and fills only its empty genres, credits (`creaters`) and series fields from
the parent product, requested in the bonus's locale. The snapshot keeps the
bonus's code, title, introduction, cover and release date, and records
`_kikoto.purchase_bonus_parent_code` and `_kikoto.purchase_bonus_inherited`, so
the tag, credit, card-summary and search projections need no bonus logic. A
dismissal queues a refresh that stores the bonus's own product again.

## Bundles

`work_bundle_member` records that an official bundle contains a member, both
by DLsite code in upper case; see
[ADR-0004](../../decisions/ADR-0004-bundle-membership.md). Neither code has to be
a work, and membership is not an edition, alias, or family: the bundle and
each member keep their own work, edition family, playback, availability, and
files. `status` is `linked` or `dismissed`; `origin` is `detected` or
`user`. Metadata sync inserts the members a product declares in
`work_pack_children` and the bundles it declares in `work_pack_parent`,
reading only codes that stand as an entry or as an entry's `workno` or
`product_id`, at most 64 per field. It only inserts: a row a user decided,
including a dismissal, stays as it is, and a member DLsite stops declaring
stays until a user removes it. Removing a detected member dismisses it;
removing one a user added deletes the row.

A work's detail resolves the relation through its family's codes: its own
code, its editions, and the edition codes its family declares. `bundleMembers`
lists the linked members of any of those codes as a bundle, each code once in
the bundle's order, and `includedInBundles` lists the bundles outside the
family that name one of them as a member. Each entry carries the library work
for its code, resolved as a purchase bonus's parent is, when one exists.
Demo keeps only the entries whose library work is eligible for Demo.

A bundle's search document holds the codes of its linked members and the
titles of the members in the library, and a code search also matches a bundle
that lists the code as a linked member, so searching for a member finds its
bundles. Triggers on `work_bundle_member` and on a member work's code and
title queue the bundle's document.
