# Major Surfaces

The pages the shell offers, what each holds, the routes and redirects that
reach them, and who may open them.

## Pages

- Library and Work detail: [Library and Work Detail](library-and-work-detail.md).
- Favorites, Circles, and Voice actors: see
  [Favorites](#favorites) and
  [Circle and Voice Actor Pages](#circle-and-voice-actor-pages).
- Record: [Record](record.md).
- Discover and For you: [Discover and For You](discover-and-for-you.md).
- Settings (`/settings`): the signed-in account's own settings as one page of
  sections: Account, with the profile row (whose edit button opens the
  display-name and password dialog); time zone; Playback with the playback
  preferences after it; and **Your data**. The time zone section holds the
  account's time zone:
  automatic, which follows the device, or one of the IANA zones the browser
  knows plus the zone in use. **Your data** opens dialogs for personal JSON
  export and previewed import from a Kikoto or Kikoeru file, a Kikoeru account,
  or an open-source Kikoeru database.
- System (`/system`): the instance settings as tabs with an icon and
  a name: Library,
  Cache & Fetch, Proxy, ASR & LLM, and Users.
- Cleanup (`/cleanup`): Works, Cache, and Database as the same tabs, each
  shown to an account that may act on it: Works and Cache need
  `downloads:manage`, Database `sources:write`. A tab scans its caches or
  database the first time it opens. `pages/settingsLocation` keeps the open tab
  of these pages in the `tab` query parameter and scrolls to a section a link
  names.
- Settings and System, tabs included, are the content column of
  `components/ui/page-width`, which every page but
  the browse destinations shares; the page sets it, never a feature inside the
  page. A
  `SettingsSection` is a plain
  heading over a hairline followed by
  its fields as rows divided by hairlines; a container query on the section,
  not the viewport, moves the heading into a rail beside the fields once the
  section is wide enough. It has no card or border of its own
  and pages set sections apart with whitespace, so a field never sits in a
  container inside a container; only a repeated object such as a source, a
  proxy, a folder rule, or a user may be a card or table row. Section
  headings are plain text, and a switch or number field stays beside its label
  even on a phone.
  Fields save as the [design contract](../../development/design.md) describes,
  and a typed number field reports a finished edit on commit. Runtime settings
  save one change at a time and send only the changed fields.
- Tags (`/tags`): the account-owned work, circle, and voice tags, with rename,
  merge, and delete.
- Insights (`/insights`): the listening dashboard of
  `features/listening-history`. The page opens
  with a year as a calendar, whose own year menu chooses the past year or a
  calendar year the report lists; a calendar year adds its highlights below
  it. A range switcher beside the summary heading (30 days, 12 months, all
  time) drives the report of totals, activity, ranked most listened works,
  weekly rhythm with listening by hour of day, a taste profile, and tags,
  voices, and circles ranked by preference or listening time, with the full
  per-work history collapsed until opened beside the clear action and the link
  to Your data. A monthly or yearly report reads its rhythm from the past
  year's calendar whatever year the calendar shows.
  The taste profile draws its preferred tags as an SVG radar with an
  equivalent list for assistive technology. Report requests name the device's time zone, and the foot of the page
  names the zone its days follow with a link to the Account setting. The calendar, the report, the profile, and the rankings load independently, so one
  failed request leaves the others on screen. The app shell composes each
  work, tag, voice, and circle link. Demo shows a notice above the dashboard
  that its listening history is simulated.
- Translation (`/translation`, `library:write`): running and queued
  Translate with AI runs by work and language, the shared translation review
  list (`components/translation`) for stopped items, the items translations
  wrote (history) and, while items wait for review, the review inbox, and the
  Metadata feature's translation coverage with batch requests. The `review`
  view shows only while auto-accept is off or items wait; `?view=` selects
  `review`, `running`, `attention`, `history` or `coverage`, and
  `/metadata?view=translation` links redirect to coverage. The page polls
  while a run is queued or running, and offers cancellation according to each
  run's server-supplied `canCancel` flag through the dedicated translation
  cancellation endpoint described in [Run Lists](../workflows/run-lists.md#run-lists).
- Metadata: see [Metadata Page](#metadata-page).
- Workflows (`/workflows`): operation cards for Scan, Metadata, and Index above the run
  lists, with the run lists as tabs (Now and History), the workflow
  filter and search at the end of the row, and run details beside the list from
  1280px, also reachable through notifications. The address holds the open
  run, tab, and filters, and the `/activity`, `/runs`, and
  `/workflows?activity=1` addresses redirect into Workflows. See
  [Run Lists](../workflows/run-lists.md#run-lists).
- Global player dock: [Player and Video](player-and-video.md).

## Metadata Page

Metadata has a Works group for DLsite works and Custom works,
and an Entries group for Tags, Circles, and Voice actors. DLsite works holds
the catalog and attention categories behind a reason filter, a floating select
in the page header's toolbar whose options are the `reason` values `catalog`
and `all`, so `?reason=` links select the tab and the filter together; `metadata`,
`no_source`, and the run-scoped `?reason=metadata&metadataRun=<id>` select `all`. Each entry view owns a
searchable table and management dialog. Tag and circle edits require
`library:write`; voice aliases retain `metadata:sync`. The URLs
`?view=custom`, `?view=tags`, `?view=circles`, and
`?view=aliases&voice=<id>` select those views. Tabs along the top of
the page hold the views, a divider setting the Works group apart from the
Entries group, and each tab's accessible description names its group. The row scrolls
sideways on a phone and keeps the open tab in view, and the header below it
holds the search without a view title, since the open tab names the view.

The DLsite works and Custom works tabs and the filter
options carry counts from `/api/maintenance/works/counts`, read as
descriptions so the tab and filter names stay the labels; the page reloads
them after the work table reports a change. The work table keeps selection
actions in the shared work selection bar, which replaces the upper
pagination while works are selected, and opens the inspector for a
pressed row from the loaded row alone: an `aside` beside the table from
1280px and a sheet below it. A row names what its work needs under the
title, so the table has no status column. The row's inspect button is
visually hidden until keyboard focus. The work, tag, circle, and voice actor
tables share one unframed look: a plain header and
divided rows, with the pinned actions column on the page background. Their
pagination renders only when the list has more than one page.

The page has no settings control; a failed DLsite update links to
System → Proxy for source managers. The Tags table is
keyed and ordered by shared tag ID, so its rows never depend on a
language setting. The ID cell carries the DLsite genre id and, only for a
hidden or merged tag, its status; there is no separate status column. The
Name column shows the interface language's name, muted when it falls back to
another name, followed by Works, with the Manage column pinned to the right
edge.

## Favorites

The Favorites page keeps data loading, browse state, and history restoration;
the shelf list, shelf header, controls, card and list views, and list
management live in `features/favorites`. Followed circles and voice actors are
the Favorite filter of their own list pages. List icons come from a shared
catalog in `components/favorite-list`, so the work card's list menu and
Favorites draw the same icon for a stored key.

## Circle and Voice Actor Pages

The circle and voice actor detail pages compose one summary and works toolbar
from `components/creator`: a frameless summary, one-line counts, an action row
with the quiet Favorite control, the catalog refresh button, and the More
menu, a search, order, filter, and View row (on a phone, Search is an icon
that opens the field above the row), the View popover or phone sheet
around the shared display options, and the toolbar's result caption. Each page
decides the More entries, the refresh button, and the sync and failed-source
marks from the viewer's permissions and passes nothing for one the viewer may
not use, so those components never check permissions themselves. The
subscribe button takes the same quiet look.

## Routes and Access

Personal tags are the Tags page at `/tags`. Settings opens at `/settings`;
`?tab=time-zone`, `?tab=playback`, and `?tab=data` scroll to the time zone,
Playback, and Your data sections, and `?tab=recommendation` redirects to
`/for-you?panel=tuning`. `/user-data` redirects to `/settings?tab=data`,
`/settings?tab=tags` to `/tags`, and `/history` and `/settings?tab=history`
to `/insights`. System opens Library at `/system` and its other tabs at
`?tab=cache`, `proxy`, `llm`, and `users`; `metadata` opens
Library, and `asr` and `services` open ASR & LLM. Cleanup opens its first
available tab at `/cleanup` and the others at `?tab=works`, `cache`, and
`database`. A `/settings` link that names a System tab, `/users`, and the
`/maintenance` tabs redirect to the matching System tab, Settings section, or For you settings, and
`/settings?tab=cleanup` and `/system?tab=cleanup` to `/cleanup`, keeping the
rest of the query.

Insights, Tags, For you, and the Your data section require `library:read`, and each
page loads its own chunk independently of the global player. System appears
only for administrators and Demo, and Cleanup for an account with
`downloads:manage` or `sources:write` and for Demo; Demo sees every tab of both
read-only.
