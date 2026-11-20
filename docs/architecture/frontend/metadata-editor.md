# Metadata Editor

How the work metadata editor stages and saves titles, descriptions, tags, and
links per language, and how remote metadata fallback is presented and run.

## Work Metadata Editor

The work metadata editor freezes its initial normalized values and sends only
changed scalar fields. Selecting a cover alone does not create title, circle,
series, or voice overrides. The editor's tabs are Title, Description, Cover,
Tags, Credits, Age rating, and Links, each marked while it holds unsaved
changes. The footer keeps the caller's refresh control visible and puts Fetch
for edit and Translate with AI in an overflow menu; Translate with AI closes
the editor, opens the Translate with AI dialog from work detail, and stays
unavailable while drafts exist. The Title and Description tabs list accepted
LLM values per language with Revoke and their history with Restore.

Every change is a draft until Save: credit reverts become explicit `null` or
empty PATCH fields, a cover revert deletes the cover override, and a staged
metadata link and purchase bonus link are written last, so the refresh they
queue reaches the caller. The Links tab holds the metadata link, the parent of
a purchase bonus, and bundle and edition-family membership. Work detail shows
the purchase bonus relation as Bonus for on a bonus, and Bonuses on a work
whose family has linked bonuses in the library. A failure after a partial save
reloads the caller and keeps the editor open. Cancel with drafts asks before
discarding them. Credit and tag inputs share one in-flow suggestion listbox
with arrow-key and Enter selection. The work detail's metadata-unavailable
notice opens the editor on its Links tab.

## Tags

The editor's tag section loads effective tags,
inherited DLsite tags, and the saved override draft. It searches shared
concepts, stages custom names and additions/removals, and can restore
DLsite tags. Exact names in any known language reuse an existing concept after
trimming and ignoring case. Custom names stay local until Save creates and
attaches them in the same request; Cancel leaves no shared entry. Only a changed
tag draft is saved. The tags render as a list under the add field, one row per
tag with its other names. A row's language
button opens the tag names panel inside that row, which loads the
shared tag once and edits its per-language manual names; Save patches renamed
shared tags before the membership request, and new tags send their language
names with it. A tag-section load failure
retains the other metadata fields. Demo shows these controls disabled.

Tag completion requests `resolveMerged=true`, collapses merged matches into
their final target, and retains source names for exact-match reuse. Management
lists still show the original entries for undo. A name resolving to a
hidden final target is labelled and disabled, with an explanation that it must
be unhidden in Metadata first. Creation conflicts returned by the server retain
the draft and show the same explanation. The tag manager explains the shared
locale precedence: language-specific manual name, all-language manual name,
provider name. This also governs default names and detail language switches.
Hide/merge/undo commit immediately and show the instance-wide remaining work
count while background projection runs. The tag list refresh action reads the
current count; the work list and player remain usable during repair.

The maintenance tag and circle dialogs keep transport separate from the work
editor and preserve their loaded state and drafts on request failure.

## Multilingual title presentation

The Title tab lists per-language titles in a single column, then the
fallback row for the universal manual title, with independent drafts.
The declared original language carries an `origin` badge and the selected metadata
language a `current` badge; one row can carry both. The detail editor follows the
detail page's temporary selection, while Metadata uses the default variant.
An undeclared original language stays unmarked.
The fallback row's hint says that every language without a manual title of its
own shows it in place of the provider title, without changing the selected
edition or description.
A row's own manual title is editable text; provider and inherited values are grey
hints. A field keeps its status badge, the source of an inherited value, and
its Revert action on one label line. Source labels
distinguish scope-specific and universal manual titles.
`titleEditorModel` compares only touched scopes with
manual values so unchanged provider text never freezes. Clearing an owned
manual title, or its row's Revert, removes it on Save; clearing an inherited
hint changes nothing.

The Description tab, like the titles, lists a
row per language in the selected scope and a Fallback row for the universal
manual description. A language row starts from its manual description or the
introduction its title choice shows, and the Fallback row from the universal
description or the original introduction. Descriptions follow the
title draft rules: an unchanged or cleared inherited introduction stays out of
the PATCH, and clearing an owned description sends `null` for that language
in `descriptions`.

The metadata language label of an original edition whose language was never
declared reads only Original; other editions keep their language or the
unknown-language label.

The language strip of the Title, Description and Tags tabs, the only values
saved per language, uses the shared segmented control: All languages, a fixed
tab for each language titles and tag names are saved in, Fallback for the
universal manual title and description and all-language tag names, and
a More tab whose menu lists the work's editions in other languages, including
an original edition with no declared language. Choosing one selects More and
names that language on the tab; the menu says so when the work has no such
edition. `metadataLanguageScope` builds the scopes and maps provider language
spellings onto the supported tokens, so an edition's raw language and a
metadata variant's language match the same scope. An original edition never
implies a language.

The Tags tab table shows the work's tags with a column per language and a
Fallback column for All languages, and only the selected column for one
language or Fallback; names apply unsaved name drafts, and a name a language
inherits is muted. A supported scope shows its own title and description
rows, and the tag names panel lists only that language's name and the fallback
name. The scope of another edition
shows its provider title and introduction read-only and the tags' fallback
names in one column. Tag membership, cover, credits, age rating, and links
remain work-wide.

Effective titles and descriptions arrive together in metadata variants. Detail
language selection updates both; descriptions render stored plain text verbatim
through React escaping, preserving brackets, ampersands and line breaks. Local,
remote-preview and resume queues take the current
display title while retaining their media identity and directory edition.
Existing global playback remains outside page boundaries. Cards and search
results use the same backend display policy; the frontend does not strip authored
titles or rewrite provider values.

## Translate with AI

The Translate with AI dialog (`features/work-detail/translation`) reads the
server's plan for the chosen languages, which counts what each category
lacks, and builds the lyrics request from the work's local tracks: it selects
every missing track and language and reads each track from its default source
file; a track without lyrics links to Manage lyrics → Transcribe. A matrix
edits that selection. The dialog's Results tab reuses the shared translation
review list with a lyrics preview: items waiting for review when auto-accept
is off, then running, stopped and applied items.

## Remote metadata fallback presentation

Metadata sync and its trigger editor share Run options: scope, product codes,
metadata source, refresh mode, and DLsite-only fallback and bonus detection.
The source selector uses the public capability list and appears only with an
enabled metadata-capable remote source. The fallback starts off and offers
checkboxes plus earlier/later controls for this run's source order. Saving a
trigger stores all options; running sends them as run input without PATCHing
settings. Manual and DLsite precedence remain unchanged. The remote source dialog has a
Provides work metadata switch that writes the `metadata` capability;
`lib/remoteSourceCapabilities` holds the shared capability rule.

The work detail notice shows `remote_fallback` as an informational state that
names the filling source and, per source, which values it filled; a not-synced
work with remote values shows the same per-source lines. The title editor names
a remote title's source. Metadata issue rows say a DLsite-unavailable work was
filled by a named remote source instead of showing a bare unavailable status.
An edition with an unavailable outcome offers a dismiss action beside its
retry, and the selection bar dismisses the selected works' unavailable
editions. A DLsite issue also offers a fetch action per enabled source with
declared metadata capability, and the selection bar offers one per source for
the retryable selection; Needs attention on Workflows offers **Mark reviewed**
for a run once its pending metadata has no retryable failure.

The metadata editor's **Fetch for edit** action opens a three-column comparison
of current, fetched, and expected values. Choosing a fetched value keeps it as
provider metadata; changing the expected value records a manual override. The
preview is private, expires, and is rejected when the work changed while it
was open.

Tags offer an explicit merge action that preserves current concepts as manual
additions to the fetched provider set. A DLsite family has its own accept
action; the normal field save does not materialize sibling editions.

Learn tag names (`metadata_genre_names`) is a system workflow nobody starts
by hand: Workflows does not list it, and its runs, progress and failures
appear in the run lists.
