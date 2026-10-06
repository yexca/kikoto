# Frontend

On mobile, the app header is a compact tool bar ordered as Quick actions,
Notifications (when authenticated), Appearance, and account. Quick actions
opens the searchable Command Palette in a bottom sheet; Notifications,
Appearance, and account use anchored popovers. Appearance owns mode, style, and
color choices, and for a signed-in user the personal preferred metadata
language: **Origin** is shown when the user has no preference and choosing it
clears the stored preference, and a saved change refreshes the routed page through the user preference event; the account surface owns Activity, account settings, native
connection actions, and authentication actions. On desktop, Quick actions and
the same command palette remain a centered surface while the header popovers
stay anchored to their triggers.

`MobileSheet` is the shared bottom-sheet primitive. It animates in from the
bottom and out toward the bottom, supports Escape and outside dismissal, and
accepts a downward drag on its handle to close. Its default layer is
transparent so sheet content does not add a backdrop mask. The shared
`MobileSheetHeader` and `MobileSheetBody` keep command and catalog-options
sheets on the same bordered header and compact scrolling body treatment. Mobile
command and catalog-options sheets rely on sheet dismissal rather than an
in-content close icon; desktop command surfaces may retain an explicit close
action.

The header owns the desktop page title and description. Mobile browsing
destinations use the bottom navigation as their location cue and show a compact
Kikoto mark instead; administrative destinations retain a single-line title.
Descriptions do not appear in the mobile header, so page content owns any
additional context it needs.

The frontend is a React application focused on library browsing, work detail,
remote source management, and playback.

At startup, the authentication provider loads current-user and public runtime
settings before mounting the application shell or global player. A production
client without a user sees the full-page sign-in surface when anonymous access
is disabled; when it is enabled, the same client enters the read-only-capable
Library shell. Stored theme mode, style, and color are applied before React
renders, including on the sign-in and Demo surfaces.

Native server health checks omit both bearer credentials and cookies and reject
redirects. Switching the normalized server URL, including its base path, clears
the old credential in browser storage and native preferences before publishing
the new server configuration. Re-selecting the same server retains its session.

## Stack

- React.
- TypeScript.
- Vite.
- Tailwind CSS 4 with PostCSS and matching `tailwind-merge` utilities.
- Local shadcn-style primitives.
- lucide-react icons.

The web app and Android WebView require modern CSS support (Chrome 111+,
Safari 16.4+, or Firefox 128+), following the
[Tailwind browser requirements](https://tailwindcss.com/docs/compatibility).

Non-English translation resources and their surface labels live in separate
language modules loaded on demand. The English fallback must not synchronously
import a module that also owns deferred languages, or those languages enter the
initial bundle despite the dynamic resource entry points. Each deferred locale
module owns its own copy, and a unit test keeps other scripts out of the English
modules apart from the language picker's native labels.

## Code Organization

New and extracted frontend code follows a downward dependency direction:

```text
app and routes -> domain features -> shared application code -> UI primitives
```

- `app` and page shells compose navigation, providers, and domain surfaces.
- `features/<domain>` owns a cohesive business slice such as work detail,
  workflows, or maintenance. Sibling features should not deep-import each
  other's internals.
- `components`, reusable hooks, and `lib` hold application-wide behavior with no
  single domain owner.
- `components/ui` contains generic primitives and must not acquire work, source,
  or workflow knowledge.

This is an incremental extraction direction, not a request for a repository-wide
move. A domain earns its own feature boundary after it owns a real page or flow
and several mostly private components, models, or hooks. App composition or a
small shared contract should resolve cross-domain needs.

Library work detail lives in `features/work-detail` and loads as its own chunk
through the feature's single lazy entry, `lazyWorkDetail`. The app shell
recognizes a direct work link with `workDetailCodeFromLocation` from
`app/workDetailNavigation` and starts the detail chunk beside the Library chunk
instead of after it; an idle Library also preloads it, so opening a work
normally renders without suspending. Library, circle, voice actor, and work
detail surfaces load the remote Fetch workspace dialog on demand through
`LazyRemoteFetchWorkspaceDialog`, which mounts it only while a draft is open
and closes the draft with a toast if its chunk fails to load. The production
build keeps React, i18next, and `tailwind-merge` in a separate `vendor` chunk
so a release that changes only app code leaves it cached; list only libraries
the entry already loads there, because everything in that chunk loads eagerly.

The production build stamps `public/sw.js` with a build id derived from the
version and the emitted file names. Each build therefore owns one service
worker cache, and activating a new worker deletes the previous build's cache
instead of keeping its hashed assets.

Navigation and browse state that pages and features share lives in `lib`:
circle and voice route helpers, Library browse state, and Library search
clauses. Work detail and the pages depend on those modules instead of on each
other, so no feature imports from `pages`. The circle and voice actor lists
render through one `pages/creator/CreatorListPage`, and the creator detail pages
and the Library remote source panel record remote Fetch and Fork runs through
`pages/useRemoteWorkActions`.

The Workflows page keeps routing, selection, and run handlers. Definition
detail, run forms, the trigger editor, availability watches, run detail, and
candidate review live in `features/workflows`.

The Favorites page keeps data loading, browse state, and history restoration.
The shelf rail, shelf header, controls, card and list views, creator shelves,
and list management live in `features/favorites`. List icons come from a
shared catalog in `components/favorite-list`, so the work card's list menu and
Favorites draw the same icon for a stored key.

Work detail metadata editing exposes one entry from
`features/work-detail/metadata`. Its modal owns interaction and save actions,
suggestion hooks own asynchronous lookup, and a pure model maps editor state
to metadata overrides. Library composes that entry instead of owning its internals.

The global player keeps its public track and state types in `playerTypes` so
media-tree and queue models do not depend on the React provider. `playerPersistence`
owns browser preference access and queue parsing, including legacy migration.
`PlayerProvider` builds the player contexts from focused hooks: playback engine
and source loading, progress saving, recovery, sleep timer, queue actions and
storage, seeking, system media controls, and keyboard shortcuts. It uses
account-scoped storage keys and remains mounted across navigation. System media
controls (Media Session and the Android notification) stay registered and read
the latest actions through a ref, so they never act on a stale queue or mode.
Source loading also warms the next auto-advance track in one detached audio
element (`useNextTrackPreload`) so the player element can reuse the buffered
bytes for the identical URL. The dock UI
lives in `player/dock`: `PlayerDock` owns the Mini, Compact, and full surfaces,
while queue reordering math and formatting stay in pure modules. Timed-lyrics
parsing lives in `lib/timedLyrics`, so the player and the work detail file
viewer read LRC, WebVTT, and SRT files the same way.

## Major Surfaces

- Library.
- Work detail.
- Favorites.
- Circles.
- Voice actors.
- Settings: one shared `IconRail` with the personal tabs (Account, which opens
  with the profile and ends with data transfer; Playback; History;
  Recommendations, which shows recommendation activity above recommendation
  tuning; and personal tags) followed, after a divider, by the Library,
  Cache & Fetch, Proxy, Cleanup, and Users administration tabs, which share an
  Administration accessible description. Wide layouts show a sticky vertical
  rail of icons; compact layouts show one scrollable row of icons with only the
  active tab labelled, and keep the active tab in view. Every tab keeps its
  label as the accessible name and tooltip. A toggle below the wide rail shows
  every label beside its icon; Settings, Metadata, and the Workflows list each
  store their own choice locally. Section headings are plain text,
  and a switch or number field stays beside its label even on a phone.
  Listening history shows a 30-day, 12-month, or all-time report of totals,
  activity, and most listened works as cover cards, with the full per-work
  history collapsed until opened;
  personal tags manage account-owned work, circle, and voice tags; data
  transfer offers personal JSON export and previewed import from a Kikoto or
  Kikoeru file, a Kikoeru account, or an open-source Kikoeru database.
- Metadata: a Works group for saved metadata and attention categories, and an
  Entries group for Tags, Circles, and Voice actors. Each entry view owns a
  searchable table and management dialog. Tag and circle edits require
  `library:write`; voice aliases retain `metadata:sync`. The URLs
  `?view=tags`, `?view=circles`, and `?view=aliases&voice=<id>` select
  those views; existing voice deep links remain valid. The shared icon rail
  shows group headings when expanded and accessible group descriptions at all
  sizes. The header settings popover keeps the DLsite proxy shortcut and
  links to Settings → Library (creator catalog freshness) and to the
  Metadata sync configuration (remote metadata fallback). The Tags table is
  keyed and ordered by shared tag ID, so its rows never depend on a
  language setting. The ID cell carries the DLsite genre id and, only for a
  hidden or merged tag, its status; there is no separate status column. The
  table shows one column per supported language plus Other names and Works,
  and scrolls sideways inside its own box on narrow screens with the Manage
  column pinned to the right edge.

- Workflows: horizontal definition tabs and a right-side Activity summary.
- Activity run details inside the Workflows panel, also reachable through notifications.
- Users.
- Global player dock.

The work metadata editor freezes its initial normalized values and sends only
changed scalar fields. Selecting a cover alone does not create title, circle,
series, or voice overrides. Its separate tag section loads effective tags,
inherited DLsite tags, and the saved override draft. It searches shared
concepts, stages custom names and additions/removals, and can restore
DLsite tags. Exact names in any known language reuse an existing concept after
trimming and ignoring case. Custom names stay local until Save creates and
attaches them in the same request; Cancel leaves no shared entry. Only a changed
tag draft is saved. Each tag chip opens `MetadataTagNamesPanel`, which loads the
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

`lib/metadataTagModel` holds draft comparison and language labels; the shared
suggestion hook owns cancellation and debounce. The maintenance tag and circle
dialogs keep transport separate from the work editor and preserve their loaded
state and drafts on request failure.

The personal destinations open at `/settings?tab=history`, `?tab=tags`, and
`?tab=data`; `data` is an alias that opens the Account data section, and
`?tab=recommendation` opens Recommendations. The former `/history`,
`/tags`, and `/user-data` links redirect there. They require `library:read`, are reachable from mobile account actions
and Quick actions, and load their own chunks independently of the global
player. The administration tabs appear only for administrators and Demo,
which sees every tab read-only.
The player records cumulative listening time under an account/server scope;
history clearing invalidates older reports using a server generation. Sleep
rewind preferences share that scope and update the resume cursor only when the
timer stops playback. Android output-disconnect events pause the media element
and player intent, including pending play requests.

## Interaction Principles

- Render known local state first.
- Load slower source availability and remote trees separately.
- Keep source failures local to the affected source.
- Keep work-summary and directory states independent. A media-stage failure
  must not discard an already rendered detail shell.
- Prefer icons for compact controls and reserve text buttons for clear commands.
- Keep playback global so navigation does not interrupt the current queue.
- Keep high-frequency playback position out of bridge and notification rebuild
  paths. Browser time rendering is sampled, Android bridge updates are
  coalesced and periodically calibrated, and a Native build does not register a
  second browser Media Session.
- Treat bottom navigation, safe areas, Compact player placement, page clearance,
  and update notices as one fixed-surface layout contract.
- Size mobile search and modal layers against the visual viewport. The frontend
  hides bottom navigation and player surfaces during text entry so focused
  controls and scrollable results remain visible without relying on Android
  activity resize behavior.
- Treat each mobile bottom-navigation destination as a resumable workspace.
  Switching destinations restores that destination's last stable list or detail
  route, history state, and scroll position for the current server and user;
  dialogs, pending mutations, and other transient overlays are not resumed.
- Retain every visited primary browse workspace (Library, Favorites, Circles,
  and Voice Actors) on both layouts so returning to a destination never reloads
  its rendered list. Each workspace has its own loading boundary. The current
  location's page chunk starts loading with the app, the other three and the
  command palette when the shell is idle, and a loaded chunk renders without
  suspending: React holds a shown Suspense fallback for at least 300ms, which
  would otherwise delay the page and the requests its effects start. An inactive
  workspace is hidden, cancels unfinished detail/list work, and pauses polling.
- Retain a visited Library, Circle, or Voice actor list when opening its detail
  route. Detail URLs do not reinitialize list controls or fetch a replacement
  collection. Returning reveals the loaded cards and restores the originating
  history entry's filters and page before list effects may write or fetch.
- Keep destination switches proportional to the workspaces that change. A
  workspace that stays hidden skips shell-driven renders, and browse list items
  are memoized with stable item handlers (`useStableCallback`) so a page render
  does not re-render unchanged cards.
- Browse workspaces share the window scroll position. When a retained workspace
  becomes active, the shell applies that history entry's scroll offset before the
  first paint; a resumed workspace does not replay its own stored list offset.
- Tapping the active Library, Circles, or Voice Actors destination from its
  detail route returns to that workspace's last list state. Work detail routes
  use the Library renderer, but a work opened from another workspace does not
  replace Library's saved destination. Only Library-origin details and direct
  work links are resumed by its tab; existing cross-workspace detail snapshots
  are ignored so Library remains reachable after returning to a creator.
- Distinguish Android client-old, server-old, and network-disconnected states;
  version actions open signed GitHub Releases and never imply silent install.
- Use the shared work-collection layout and work-card view model whenever a
  surface presents works. Page-specific filters and statistics may differ, but
  grid behavior and responsive column choices should remain aligned.
- Detail-page Back returns to the entry that opened the detail on both layouts,
  including Favorites and nested creator routes. A resumed mobile detail uses
  its captured return entry; a direct link falls back to its workspace list.
  Tapping the active bottom-navigation destination remains workspace Up.
- Keep provider tags to two measured card rows with an overflow popover. Card
  summaries use Circle / Series, DL sales, segmented rating, known available
  alternate-language state, and a compact playback-history indicator when a
  persisted cursor exists.
- Persist work-collection column settings as one shared browser preference,
  rather than separate page-local selections.
- Scope account-bearing browser state by the configured server identity and
  current user (or anonymous principal). This includes player queue/progress,
  Library and Favorites browse restoration, workflow selection, and in-memory
  work media. Pure display preferences such as theme and player Dock mode stay
  shared on the device. Demo mode may change those local display preferences
  even though server-backed account and administration state remains read-only.
- Keep the recommendation client-session id in server-and-user-scoped session
  storage. Navigation and reloads in one browser tab reuse it; a newly opened
  tab or native-app cold launch creates a new id and stable recommendation seed.
  Manual reshuffle changes the browse seed without replacing the session id.
- Keep scroll state per browser history entry. A push navigation starts at the
  top, while browser back/forward restores the originating entry after its
  content has rendered. The shell observes content height for up to ten seconds
  for deep restoration and cancels all pending frames and observers on user
  scroll intent or navigation. Scroll writes belong to a unique history entry;
  delayed writes and page-level cleanup must not overwrite another entry's
  saved position, even when both entries share a URL.
- For collection-to-detail navigation, keep only shareable semantic filters in
  the URL. Store complete browse state plus selection/focus anchors in the
  originating history entry and use session state as a refresh/new-entry
  fallback. Continue to parse legacy explicit browse parameters.
- Reserve a directory-shaped skeleton with stable height while media is being
  indexed or loaded, then replace it in place without a separate loading card.
- Build Tree rows and playback queues from one folder-first natural ordering.
- Apply a persisted position only through Resume or the restored current queue
  item. After a reload, that item continues the work cursor when it still points
  at the same media item and is unfinished, unless the listener has already
  played or sought in it. Ordinary track selection starts at zero, while an
  active source fallback (only when the account enabled it) carries the current in-memory time, or a start position
  still waiting for metadata, to the replacement location.
- A playback instance writes the work cursor only after its start position is
  applied and the listener has played or sought in it. Page hide, pause, track
  switches, and the sleep timer must not replace the cursor with the position
  of an idle or still-loading element.

## Design and Semantic Contracts

- Consume semantic theme roles instead of hard-coded palette steps. Availability
  and feedback use success, warning, info, and error roles; destructive styling
  is reserved for destructive actions.
- Source color communicates health or availability, not source identity.
- Every reusable control defines hover, pressed, keyboard-focus, disabled,
  loading, and selected states as applicable. Touch actions keep a large target
  and never depend on hover feedback.
- Use surface and border changes for static hierarchy. Noticeable shadows belong
  to floating overlays and the player rather than every card.
- Accessible roles, names, and labels are the primary browser-test contract. An
  authored semantic marker may scope a complex app-owned surface, but utility
  classes and incidental DOM ancestry are not stable APIs.

## Failure Boundaries

The global player and app shell are continuity infrastructure. Route and domain
error boundaries should sit inside them so a render failure in Library,
Maintenance, or a remote panel does not stop playback or discard navigation.

Fallbacks must use sanitized copy and offer a relevant recovery action. Raw
stacks, upstream bodies, private endpoints, and local paths are diagnostic data,
not anonymous UI. A page that already has useful local data should keep it
visible while the failed remote or media stage renders an inline Retry state.

## Multilingual title presentation

`WorkTitleEditor` lists per-language titles first in a single column, with independent drafts.
The declared original language carries an `origin` badge and the selected metadata
language a `current` badge; one row can carry both. The detail editor follows the
detail page's temporary selection, while Metadata uses the default variant.
An undeclared original language stays unmarked.
The universal title appears under Advanced title options, collapsed by default
and expanded when a saved universal title or a nonempty draft exists. Its hint
explains that it overrides provider titles while language-specific manual titles
take precedence, without changing the selected edition or description.
A row's own manual title is editable text; provider and inherited values are grey
hints. Source labels distinguish scope-specific and universal manual titles.
`titleEditorModel` compares only touched scopes with
manual values so unchanged provider text never freezes. Clearing an owned
manual title, or its row's Revert, removes it on Save; clearing an inherited
hint changes nothing.

`WorkMetadataEditorModal` splits the editor into Title, Cover, Tags, Credits,
and Metadata source tabs, each marked while it holds unsaved changes. Every
change is a draft until Save: credit reverts become explicit `null` or empty
PATCH fields (`MetadataEditorReverts`), a cover revert deletes the cover
override, and a staged metadata link is written last, so its refresh result
reaches `onLinkChanged`. A failure after a partial save reloads the caller and
keeps the editor open. Cancel with drafts asks before discarding them. Credit
and tag inputs share `SuggestionCombobox`, an in-flow listbox with arrow-key and
Enter selection. The work detail's metadata-unavailable notice opens the editor
on its Metadata source tab.

The metadata language label of an original edition whose language was never
declared reads only Original; other editions keep their language or the
unknown-language label.

Effective titles and descriptions arrive together in metadata variants. Detail
language selection updates both; descriptions render stored plain text verbatim
through React escaping, preserving brackets, ampersands and line breaks. Local,
remote-preview and resume queues take the current
display title while retaining their media identity and directory edition.
Existing global playback remains outside page boundaries. Cards and search
results use the same backend display policy; the frontend does not strip authored
titles or rewrite provider values.

## Remote metadata fallback presentation

The Metadata sync workflow's Configure popover, offered with `sources:write`,
holds the Remote metadata fallback: an off-by-default switch and the
metadata-capable remote sources, each with a checkbox and earlier/later
controls for the fallback order. It reads the settings when opened and saves
only the fallback. A pure model (`features/workflows/remoteMetadataFallbackModel`)
orders the rows and drops ids that no longer name a capable source before
saving. The remote source dialog has a
Provides work metadata switch that writes the `metadata` capability;
`lib/remoteSourceCapabilities` holds the shared capability rule.

The work detail notice shows `remote_fallback` as an informational state that
names the filling source and, per source, which values it filled; a not-synced
work with remote values shows the same per-source lines. The title editor names
a remote title's source. Metadata issue rows say a DLsite-unavailable work was
filled by a named remote source instead of showing a bare unavailable status.

Workflows lists Learn tag names (`metadata_genre_names`) in the Basic group
after metadata sync. It is a read-only system workflow: its runs, progress and
failures appear in Activity, and it has no run form.

## Related Docs

- [Frontend guidelines](../development/frontend-guidelines.md)
- [Testing](../development/testing.md)
- [Secure development](../development/security.md)
