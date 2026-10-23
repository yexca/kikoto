# Library
[English](../en/library.md) · [简体中文](../zh-Hans/library.md) · [繁體中文](../zh-Hant/library.md) · [日本語](../ja/library.md) · [한국어](../ko/library.md)

The Library is the main browsing surface for works.

## Current Behavior

- Shows local, tracked, and configured remote source tabs.
- Uses server-side pagination for large result sets.
- Searches normalized titles, codes, language-edition aliases, circles, tags,
  voice credits, and staff credits before hydrating the current page. Provider-declared edition
  codes remain searchable without creating extra works or scanning raw metadata
  snapshots during a Library request.
- Matches search text literally and ignores width, letter case, and kana
  script: `100%` and `a_b` are not wildcards, full-width `ＡＢＣ` finds `abc`, and
  katakana finds the same word written in hiragana. Prefix a term with a
  clause such as `tag: 癒し`, `circle:`, `va:`, or `mytag:` to search one field.
  `staff:` searches every staff credit from DLsite, and `author:`,
  `scenario:`, and `illust:` search one staff role; `creator:` searches voice
  actors. Put `-` in front of `tag:`, `mytag:`, `circle:`, `va:`, or a staff
  clause to leave out the works that match, and quote a phrase, as in
  `"calm night"` or `circle:"Example Circle"`, to match it as a whole.
- A DLsite tag also matches its name in every language Kikoto has fetched for
  that tag: when an edition requested in English reports `Healing` for the tag
  shown as `癒し`, `tag: healing` finds both. Results whose tag, title, circle,
  voice credit, or staff credit equals the search term exactly appear before
  partial matches, and the selected sort orders each group.
- The `+` button in the search field opens a floating editor for a
  structured search condition. Selecting a condition badge edits it in the same
  popover without moving the results.
- Shows cover, title, code, Circle / Series on one ellipsized line, voice
  metadata, local availability, source tags, and quick listening marks when
  available.
- Measures provider tags into at most two card rows. A `+N` badge opens hidden
  tags in a popover; personal tags remain a separate user-owned row.
- Shows compact DL sales and a five-segment non-numeric rating comparison in one
  metrics row. A playback-history icon appears when a persisted cursor exists.
- Shows a lyrics icon when a track of the work has lyrics: a lyrics file
  assigned in **Manage lyrics**, or one matched to the track by name. Other
  text files, such as a readme or a script, do not count. A work without
  tracks of its own takes the status of its other editions.
- Shows the current price when normalized commercial metadata is available and
  labels zero-price works as Free.
- Shows the signed-in user's work tags separately from metadata tags on unified
  work cards and detail. `mytag:` filters personal tags without changing the
  provider `tag:` search meaning.
- Keeps source availability visually separate from metadata tags.
- Shows known age ratings beside the circle name on work cards while retaining
  the complete age metadata in work detail.
- Uses the same responsive grid for work collections across the Library,
  Favorites, circle detail, and voice detail surfaces. Column choices are
  shared instead of being reimplemented per page.
- Persists the selected work-collection column settings locally and applies
  them across Library, Favorites, circle work collections, and voice work
  collections.
- Supports stable seeded random ordering. A seed keeps pagination consistent;
  reshuffling creates a new seed rather than reversing an order.
- Defaults new Library views to personalized recommendation ordering while
  preserving restored browse choices. Canonical URLs retain the query and
  non-default listening status; explicit browse parameters are also read.
  Listening and Want receive leading slots, Unmarked is the main discovery
  pool, Relisten and Finished receive bounded insertions, and zero-slot states
  follow scheduled states. Each state shows a bounded set of recommendation
  candidates first, then every remaining matching work in stable seeded
  exploration order. Exact search matches still lead, totals include all
  matches, and changing page size does not change the order. This order does
  not rank the complete result set by personal affinity.
- Affinity uses favorite, tag, voice, and circle evidence, excludes the
  candidate's own feedback, strengthens repeated positive evidence up to five
  favorites' worth, and discounts common tags. Your
  [rating](work-detail.md#current-behavior) is the main evidence: four and five
  stars count as liking a work, one and two stars as disliking it, and three
  stars as neutral. A rated work counts only by its rating. For an unrated
  work, a favorite counts fully, Relisten counts half, Shelved counts lightly
  against its tags and creators, and Finished alone is neutral. One disliked
  work is enough to lower similar works; shelved works lower them only once
  enough of them agree. Seeded discovery, variation, and
  creator diversity affect candidate ordering, while badges retain affinity.
  Ordinary-sort badges score only the current page. Explanations show real
  affinity even outside the candidate set; query-specific ranking adjustments
  appear only when the displayed recommendation context applies. If that
  context expires, the explanation keeps the original session's affinity and
  omits ranking adjustments.
- A browser tab or native-app launch freezes its preference profile, listening
  lanes, and shared metadata version in one generation. Navigation, filters,
  pagination, card mutations, and reshuffles reuse that profile. Live favorite
  and listening changes appear on cards immediately and affect ranking in a new
  session. Shared features update in background, so a new session uses the
  latest fully published version and may lag metadata edits. A reshuffle
  changes only the seed. Browse membership and filters remain live: additions,
  deletions, availability, permissions, or personal filters can move page
  boundaries, while the same visible data stays deterministic and complete.
- Ordinary browsing and playback stay available during initial recommendation
  indexing. Failed optional badges offer an independent Retry with cards
  retained; failed recommendation preparation offers Retry beside the last
  loaded cards. The global player keeps playing during both failures.
- Remote recommendation badges also score works that have not been imported,
  using known localized tags and creator aliases. Turning badges on scores the
  current page in one batch without reloading the remote source, then reveals
  badges progressively (with reduced motion respected). Every scored work
  shows its score; scores meeting your highlight threshold are emphasized and
  lower scores appear muted. A score failure leaves the works available
  and offers Retry. Remote scores use the same frozen session preference profile
  and do not import any works.
- Offers recently played works, ordered per user from the one cursor owned by
  each logical work family, with the latest track position. On wide screens a
  history button in the toolbar opens the list. On phones a Continue listening
  button in the sort row opens a horizontally scrolling strip of recently
  played covers below it, on any page and source.
- On phones the Library leads with an always-visible search field and,
  beside it, a source button that names the current source and opens every
  source in a menu. Below them, the sort row starts with what shapes the
  results, the sort button and a Mark filter button, and ends with extras and
  view controls: recommendation badges, Continue listening, and display
  options. Mark filter and Continue listening each show or hide a row below:
  the Quick mark filter chips, then the Continue listening strip. Both rows
  start hidden. While a mark filter is set, its button shows that mark.
  Selecting the active chip clears the filter.
- The sort button names the current order and opens the orders and direction
  in a popover. The Recommended and Random orders add a refresh button beside
  it.
- Display options start with **Cards**, a choice of **Full**, **Compact**, and
  **Mini** that is stored with the column settings, separately for phones and
  wide screens. **Full** is the default. Automatic wide-screen columns fit up
  to 5 full cards, 6 compact cards, or 7 mini cards in a row, and fewer when
  the window is narrower. Choosing a different mode resets the other display
  options to that mode's starting point, which can then be adjusted: automatic
  wide-screen columns in every mode, 24 works per page with automatic cover
  source marks for **Full** and **Compact**, and 48 works per page with no
  cover source marks for **Mini**. Phone columns keep their own setting.
  **Compact** shows each work as a row
  in one phone column: the cover beside the code, title, circle and voice
  names, rating, sales, and price, then one row of tags with personal tags
  first and the last listening position when there is one. Two phone columns
  and wide screens show short tiles with the price on the cover and no tag
  row. **Mini** shows only the cover and up to two lines of the title, without
  the code, credits, tags, ratings, price, recommendation score, or action
  row, and automatic columns on phones show two covers in a row. Cover source
  marks follow their own display option in every mode, and a card opens its
  work the same way in every mode. The choice applies to Local, Tracked, and
  remote sources in the Library, including the remote loading placeholders.
- Uses one shared query across Local, Tracked, and configured remote sources.
  Each source retains its own pagination, sort, and scroll state, while grid
  column settings remain shared. A source cannot restore stale query text after
  the user clears it elsewhere.
- Keeps the active Local, Tracked, or remote-source page size in the toolbar's
  display options. Local, Tracked, and remote sources all offer 24, 48, or 96
  works per page. Wide screens show a compact top pagination with result
  context and page navigation. Phones show the result count and the current
  page as a caption above the works and change pages from the bottom
  pagination. The bottom pagination lists the first, last, current, and
  neighboring pages; an ellipsis between them opens a field that goes to a
  typed page number.
- Keeps database cleanup out of Library. Metadata -> DLsite works -> No
  available source provides paged search, source checks, and confirmed
  local-information deletion for logical families with no available source or
  media location.
- `/no-source` and `/library/no-source` links open Metadata -> DLsite works ->
  No available source; `/library/all` and `/library/remote` links open the
  Library.
- When `KIKOTO_MODE=demo`, backend list, detail, and media responses admit
  only all-ages, permanently free works. Local works use normalized commercial
  metadata, where unknown metadata and temporary free promotions are excluded.
  The simulated Remote Kikoeru source only republishes admitted local works.
  Demo sessions can play admitted full media but cannot mutate library,
  settings, or workflow state. Recommendation scores are simulated random
  values, labelled "Demo score, randomly generated" in explanations. They stay
  stable for each work in a demo session across reshuffles and do not show
  preference contributions or ranking adjustments.

Work cards use the same summary model on every collection surface, including
voice credits when they are known. Compact cards show at most two voice names
and summarize additional credits without allowing metadata to grow the card
unboundedly.

Favorites keeps only entity/search intent in the canonical URL. Its selected
list, favorite filters, ordering, seed, pagination, selection, and work anchor are
restored from the current history entry with user-scoped session fallback.
`All Favorites` aggregates works with a Quick mark and works you added to any
list. `Marked` is the fixed system list containing only works whose Quick mark
is not Unmarked; its membership is derived and cannot be edited as a list.
Other lists are user-created and keep explicit membership. **Add to list** on a
work card or on work detail lists your lists with a search field; each list you
check or clear is saved at once, and typing a name no list has offers to create
that list with the work in it. A smart list that holds the work through its
rule says so, and clearing it keeps the work out of that list. **Change lists**
on selected Favorites works shows the change each list will make, such as how
many works it adds, and applies them together; a list that holds only some of
the works stays untouched unless you change it. Phones open both as a bottom
sheet.

A smart list fills itself from tags. When you add a list, choose **Smart list**
and sort tags from the shared metadata tags and your own tags into three
groups: **Required tags** a work must all have, **Any of these tags** of which
it needs at least one, and **Excluded tags** it must have none of. An empty
group is skipped, but the rule needs at least one required or any-of tag. The
editor counts the matching works as you go. Works that match appear in the list without becoming
favorites. You can still add other works by hand, which makes them favorites
like in any list, and remove a matching work, which keeps it out of the list
until you add it again. The list only gathers works already in your library.
When works start to match later, the shelf shows how many are new and marks
them **New** until you choose **Mark all as seen**; **Only new** shows just
those works. **Convert to regular list** keeps the works the list shows now as
an ordinary list, makes all of them favorites, and removes the rule. A tag that
is later hidden or deleted stays in the rule, crossed out, and matches no work.

Switching lists keeps the
full favorite-list row stable while results load, and Shelved is the final
listening-state option. Playback cursors alone never add a work to Favorites.
The resource filter narrows favorite works by the availability their cards
show: Available (Local, Cached, or Remote), Local, Remote, or Missing. A work
whose files belong to another language edition counts with that edition. The
filter reads stored availability and does not request a live remote refresh.

On wide screens a shelf rail beside the results lists All Favorites, Marked,
your lists, and followed circles and voice actors with their counts. Like the
Workflows and Settings rails, it can hide its names and keep only icons, and the
choice is remembered on that device. Each user list can show an icon chosen in
its editor, which is what tells the lists apart in the icon rail; the list icon
also appears in the add-to-list menus. The open shelf has a header with a cover
mosaic, its count, how many works are finished, and the works you are
listening to. Phones show the same shelves as one scrollable row above a
one-line header that states the finished share as a percentage. Below it come
the search field, the named sort beside the resource, display, and selection
buttons, the listening-status filters as a scrollable chip row, and a caption
with the result count and page in place of a top page bar. Display options
switch works between cards and a denser list with each work's resume point.

**Add list** in the shelves and **Edit list** on a list's shelf open one list's
editor: its name with the icon beside it, an optional description, the rule of a
smart list, and **Delete list**. A name another list already uses is pointed out
but allowed. **Edit lists** shows every list; **Move up** and **Move down**
reorder them at once without leaving the open shelf, and opening a list there
edits it and returns to all lists with **Back**.

## Identity

Library cards represent unified works, not per-source copies. Remote cards can
track or sync a work before it has local files, but the resulting state attaches
to the same unified work identity. Track also persists the selected source tree
and opens that source in Tracked.

A remote source can hold several language editions of one work. When the
library already knows that work's edition family, a remote tab shows the
editions it returns as one card. The card presents one edition: the code the
search names, otherwise the first of your metadata languages the source has,
otherwise the family's own code. The code, title, cover, DLsite link, Track,
and Fetch on the card all belong to that edition. When the source returned more
than one edition, the languages button in the card footer lists them and opens
the one you choose. Editions of a family the library does not know yet appear
as separate cards. A result that fits on one page counts its cards; a result
over several pages counts the source's entries.

## Source Tabs

Source tabs should help users answer where a work can be played or fetched from.
They are not separate libraries with separate metadata ownership. Local,
tracked, cache, and remote facts all point back to the same work model.

## Related Docs

- [Work detail](work-detail.md)
- [Sources](sources.md)
- [Core boundaries](../../architecture/core-boundaries.md)
