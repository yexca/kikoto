# Design

Kikoto should feel like a quiet personal media library and player.

This repository-wide contract governs new and changed UI across the browser,
Android, and iOS shells. Sections labeled as current describe the
implementation; the other rules govern every new and changed surface.

## Design Principles

- Listening comes first.
- Library management should be dense but calm.
- Background work should be visible without taking over the product.
- File source state must be understandable at a glance.
- Mobile should not feel like a reduced desktop layout.
- Failures should stay close to the surface that failed
  ([Failure and Recovery](#failure-and-recovery)).

## Visual Direction

Current implemented direction:

- Anthropic-inspired warm editorial styling by default.
- User-selectable Anthropic, OpenAI, Apple, and Google Material Design presets.
- Preset-owned color, typography, density, radius, elevation, icon weight, and
  motion strength.
- An independent Original, Graphite, Cobalt, or Iris color palette. Original
  resolves to the selected preset's authored default.
- Light, dark, and system display modes remain independent from the preset.
- Persistent mini player.

Preset names describe visual inspiration only. Kikoto does not bundle
third-party logos or proprietary font files, and does not imply affiliation
with those products. Presets must be implemented through shared semantic tokens
and primitives rather than page code branching on a preset name.

Surfaces form a small elevation stack:

```text
background -> card -> popover or dialog
```

Use surface color and borders for static structure. Reserve noticeable shadows
for floating elements such as popovers, dialogs, and the player dock; do not add
shadow to every card.

## Semantic Tokens

Component code should consume semantic roles rather than hard-coded palette
steps. The design contract includes:

- Page, card, popover, foreground, muted foreground, border, input, and focus
  roles.
- Primary and secondary action roles.
- Separate success, warning, info, and error roles, each with a subtle surface,
  readable foreground, and border treatment.
- A destructive action role reserved for irreversible commands. Error feedback
  is not automatically a destructive action.
- A scrim role that darkens what lies behind a dialog, and the edges of a
  picture under controls laid over video, so they read on any frame.
- Place roles for the file workspace: `place-target` for the folder an edit
  changes, `place-local` for another local folder it only copies from, and
  `place-remote` for a read-only remote edition, each with a band, subtle
  surface, readable foreground, and border in both themes. They are strengths
  of the primary color, full for `place-target` and faintest for
  `place-remote`, so they follow the preset and palette; what the edit
  deletes keeps the error role. They tell the workspace's places apart by
  what the edit may do there; they are never a status and never name a
  source, and a place always also carries an icon and a label such as
  **Read-only**.

Status color communicates state, not source identity. Configured source names
remain low emphasis; green, amber, and red describe available, degraded, and
unavailable states consistently across sources. New shared roles must be added
to the token contract before pages use them.

Presets may vary primary actions, selected states, surface tonality, density,
radius, elevation, typography, icon weight, and motion strength. A non-original
palette only overrides primary actions, selected states, and focus rings.
Semantic feedback does not follow the preset or palette: cyan is info, green is
success, amber is warning, and red is error or destructive intent. Age-rating
colors remain fixed across presets.

Interactive controls use one state language across management and listening
surfaces: visible hover on fine pointers, pressed feedback on every input type,
keyboard focus rings, persistent selected state, and restrained motion that
respects reduced-motion preferences.

Every reusable interactive component defines:

- Rest, hover, pressed, keyboard-focus, disabled, loading, and selected states
  when applicable.
- A readable accessible name. Icon-only actions use an `aria-label` and a
  tooltip when the icon is not self-explanatory.
- A minimum 44px touch target on primary mobile interaction paths, even when the
  visible icon is smaller. The shared `Button` extends a compact control's hit
  area to 44px on coarse pointers (`touch-target`) without changing its visible
  size. Adjacent compact controls share their overlap, so space destructive
  actions away from frequent ones.

Keyboard focus must remain clearly visible; do not remove focus feedback
merely to match pointer styling. Pressed feedback and a large touch target never
depend on hover.

## Action Hierarchy

- Give each action cluster one obvious primary command at most.
- A listening surface at rest shows no management actions: they wait behind
  one menu, and only for a viewer allowed to use them.
- Use quiet ghost or outline controls for toolbar and row utilities.
- Dense row actions remain muted until hover, focus, press, or persistent
  selection. A delete trigger need not stay red at rest; the confirmed action is
  destructive.
- Destructive filesystem and account actions require an explicit confirmation
  proportional to their reversibility.
- Prefer a shared component or pattern once the same action treatment appears on
  a second surface.

Avoid:

- Landing-page hero sections.
- Decorative gradients as the main visual identity.
- Oversized dashboard cards.
- Hiding important playback/cache state behind nested menus.
- Nested cards used only to manufacture visual hierarchy.
- Page-local brand colors or hard-coded light and dark palette branches (see
  [Semantic Tokens](#semantic-tokens)).

## Information Density

Presets may tune shared control heights, card padding, navigation height, and
page rhythm, but they do not change information architecture. Touch targets
retain their accessibility floor on mobile, and dense operational surfaces must
remain scannable in every preset.

A work card separates what it shows at rest from what it shows on demand.

At rest, a card states what a listener picks a work by, plus quiet status:

- Cover.
- Title.
- One credit line: the circle, then voice actors.
- File availability marks.
- Listening progress.
- Quick-mark state.

On demand, it adds the browsing-level facts and the actions:

- Product code and age rating.
- Series.
- Metadata and personal tags.
- External rating and sales when known.
- Current price or Free state when known.
- Recommendation score.
- The action row: DLsite, lists, your rating, and Quick mark, with the view's
  own actions.

The simple card is that split, a mode a viewer chooses for a calmer grid. Its
resting status stays on the cover: source marks at the lower left, the
quick mark as one icon at the lower right when the work has one, and progress
as a thin bar along the bottom edge. Nothing at rest is a management action.
The details open in three ways, and none of them moves the grid on a fine
pointer:

- Hovering the card, after a short pause so a pointer crossing the grid opens
  nothing. The details lay over the cards below as one raised surface with
  the card.
- Keyboard focus on the card or inside it, without the pause, so every control
  in the details is reachable by Tab.
- A toggle at the end of the credit line on touch screens, where hover does
  not exist. It is always shown there, has a 44px target, and opens the
  details in place below the credits, where they stay until toggled again.

The details also stay open while one of their menus is open, so a menu never
loses its anchor. The touch entry is a toggle rather than a long press or a
sheet: a long press cannot be discovered or reached by assistive technology,
and the card's menus already open as popovers or sheets of their own, which
an enclosing sheet would have to stack under.

A full card shows the on-demand facts and the action row all the time, and it
is the card a collection starts with. A narrow full card (a container under 12.5rem,
such as two mobile columns or many desktop columns) keeps the same facts with
tighter type and spacing. It folds personal tags ahead of metadata tags into
one measured row, leaving the rest in the overflow popover, names only the
first file source on the cover with a count of the rest, and keeps the 44px
action row. The card's container query owns this breakpoint; tag measurement
reads the row count from it, not from the viewport.

The Library and the circle and voice actor detail pages offer the card mode as
a display option, one choice shared by all of them and kept separately for
phones and wide screens: full (the default), simple, compact, and mini. The
card mode leads the display options because choosing a new one resets
wide-screen columns to automatic and works per page and cover source marks to
that mode's preset. Automatic wide-screen columns allow at most 5 full or
simple, 6 compact, or 7 mini tracks, with minimum track widths sized so every
mode reaches its maximum at about the same container width and steps down
together below it. A simple card has the full card's track width, so its
details open at the width the full card lays its facts out in. Compact uses
row cards in one phone column: a small cover beside the facts, one measured tag
row with personal tags first, and the last listening position. Two phone
columns and wide screens use short tiles that keep the cover dominant and leave
out tags and voice credits. Full and compact keep the action row and its 44px
touch targets on show. Mini is a cover and at most two title lines with no
details and no action row, so a large collection can be scanned by its artwork
while the work detail page carries everything else. Only cover source marks
and the selection control ride on a mini cover. Loading placeholders match the
footprint of the mode in use.

The Library toolbar holds the source switcher, the search field with its
condition builder, and the controls a listener reaches for while browsing,
each one step away: the order (a button that names it, with its direction in
its popover and a reshuffle beside it for a seeded order), the quick-mark
filter, recently played works, and View. The wide source tabs lead with the
source visibility entry, which sets which sources the tabs show. The View
panel holds how the results are drawn: the display options, the
recommendation score switch, and selecting remote works. A wide layout opens
it as a popover and a phone as a sheet, and a choice leaves it open so several
can be adjusted. Each setting shows in one place: the sort button names the
order, and the filter button turns primary with the mark's icon (and on a wide
layout its name) while a filter is set, so no chip restates either. A new
display setting joins the View panel instead of the toolbar.

The works of a circle or voice actor detail page have a toolbar of at most
five controls: a circle's Works and Series tabs, the search field, the order,
the availability filter, and one View entry. Search, order, and filter stay
one step away because they are used often (a phone opens the search field
from its icon); View holds the display options and selecting
works for bulk Fetch or Fork, and opens as a popover on wide layouts and as a
sheet on a phone. A new browse control on these pages joins View instead of the
toolbar. A caption before the order states how many works match and, from
tablet width, the page; these pages have no top page bar, only the bottom one.

Discover's three views and For you read as one surface. They keep one card
mode of their own, apart from the Library's, which starts at simple and offers every mode;
there compact stays a
row card on wide screens, up to three automatic tracks, and only two phone
columns use tiles. Every card has a fixed-height context line above it that
says why the work is in the view, the card itself, and an action row in one
order: DLsite, then Watch, lists, rating, and Quick mark, each only where it
applies. The context line states only what the card does not already show:
the release feed leaves the most common event, a new release, unlabelled and
does not repeat a subscribed name from the credit line. It uses one status
vocabulary: a success badge for
available or in the library, a primary badge for new or back, a neutral badge
for an event, a warning badge for a failed check, and a dot only for unread.
Groups of cards share one section heading (title, a count badge where the
count tells something, hairline, and an optional action at the end), and the
page toolbar keeps the same controls
in place on every view, disabling one a view does not offer. A work without
metadata shows its code on a placeholder cover and no metric line; every card
leaves out a rating or sales figure it does not know.

The bottom page bar of a collection shows the first and last pages and the
current page with its neighbors, with an ellipsis for each gap that opens a
page number field. The bar's own width sets how many neighbors it shows: one
on each side on a phone, up to four on a wide bar. Once the pages outnumber
the bar's slots, it keeps the same number of items on every page, so the
arrows stay in place while paging. Results that fit one page show no page
bar; the Library states its count where the top page bar would be.

Work detail pages should show decision-level facts:

- Metadata source.
- Tags and credits.
- Translation relation.
- File tree.
- File locations.
- Cache/download actions.

Use cards for repeated objects, not for every section. A settings section is
a plain heading over a hairline followed by its fields, set apart from the next
section by whitespace and from its own fields by hairlines; it has no card or
border, and a field has no framed container around it. Where the section is
wide enough, the heading, its description, and the section's action sit in a
narrow rail beside the fields, and the hairline runs above both, so a label and
its control stay close instead of meeting across the whole column. A section
without fields keeps its action at the end of the heading's line. A narrow
column, a dialog, or a phone keeps the heading above the fields. A repeated object such
as a source, a proxy, a folder rule, or a user may be a card or a table row.
Settings, System, and Cleanup pages share the [content column](#app-shell), section spacing,
field rhythm, and destructive-action placement. No form, table, or section
defines its own width.

A page of operations lists them in sections like settings sections, one row
each. At rest a row holds only what answers "what is this, does it run on its
own, how is it, and can I start it": a name, a line naming its automatic
starts (none for a manual operation), a state, and one quiet run control. No row
is the page's primary action. The state names idle, queued, running with its
progress, and how and when the last run ended; a failed or waiting outcome
keeps its status color on the row and leads to the run's details. A running
operation shows so on its row, wherever the run was started. An operation that
covers the whole library cannot be started again until its run ends; one that
acts on a target accepts another target meanwhile, so the page never blocks
work the backend would queue. What it does, its options, and its schedules
open below the row on demand, one operation at a time, and the primary Run sits with the
options it will use. A new operation is a new row in a section, not a new
destination or a card.

A settings switch or choice saves as soon as it changes, and a typed field
saves when its edit finishes. Its section heading shows the save state. A
Save button belongs only to a form whose fields must change together, such as
a password change or a policy editor. A section with one field does not get a
footer for its own button.

## Helper Text

The layout explains a surface before any sentence does: a heading names its
section, a field's label names what it changes, a control's own value or
option names show its choice, and grouping, order, and empty states show how
the parts relate. A page, tab, section, or field carries no description that
restates its title, explains how to operate an ordinary control, or describes
the layout around it.

A description belongs beside a field only when it states something the
layout cannot show:

- A consequence that is hard to undo, such as data that is moved, replaced,
  or deleted.
- Privacy or security exposure, such as which addresses an account receives
  or which devices the server may reach.
- A constraint that is not visible in the control, such as a minimum that
  depends on another setting.
- A difference between choices that their names do not convey.

A range or format enforced by the control is shown when an entry is rejected,
not before. Empty, loading, and failure states keep their own text, and
content safety, legal acceptance, and destructive confirmations keep the copy
that their decision needs.

## Failure and Recovery

- Preserve the app shell and global player when a route or remote panel fails.
- Render known local metadata before slower media or remote state.
- Loading, empty, unavailable, permission, retryable, and terminal failure are
  distinct states; do not collapse all of them into one toast.
- A transient toast reports an event. A failure that still blocks the task needs
  a persistent inline state with a Retry or recovery action.
- User-facing errors are concise and sanitized; what stays in protected
  diagnostics is listed in
  [Errors, Logs, and Diagnostics](security.md#errors-logs-and-diagnostics).

## Semantic UI Boundaries

Accessible roles, names, labels, and native semantics are the primary UI
contract. For complex app-owned regions such as Work detail, the global player,
or an operation's row, an explicit stable semantic marker may define the region
for browser tests and controlled automation.

Markers describe business roles, not current styling or visible copy. Utility
classes, DOM ancestry, generated identifiers, and translated text are not stable
structural APIs. Add markers selectively instead of annotating every wrapper.

## App Shell

The shell keeps listening and managing apart. At rest it shows listening
destinations and no administration controls:

- The desktop sidebar emphasizes the browse destinations: the collections
  (Library, Favorites, Circles, Voice Actors), then below a divider Record, For
  you, and Discover. The account's own
  pages (Insights, Tags, Settings) sit in a collapsible Personal group and
  administration pages (Workflows, Metadata, Translation, Cleanup, System) in a
  collapsible Manage group. Both groups behave alike: closed by default, the
  choice remembered on the device, open while one of their pages is current,
  and absent for an account that can open none of their pages. About closes
  the list, below a divider.
- Settings holds only the signed-in account's settings. Instance settings are
  the System page, shown to administrators and, read-only, to Demo. Deleting
  local work folders, cache files, and database records is the Cleanup page, a
  page of destructive operations apart from the settings.
- The account panel behind the avatar holds the languages and
  authentication. Where the sidebar is shown, it also holds Discover, Insights,
  and Tags as shortcut tiles that repeat the sidebar's entries. A layout
  without the sidebar lists the sidebar's pages there instead, About included,
  with the Manage pages behind one entry, and no tile.
- The header shows the page title without a description. Its tray holds Quick
  actions, Notifications, and Appearance, and the avatar carries no role text.
- A phone header holds at most three actions: Notifications, Appearance, and
  the avatar.
- A new destination or shell action joins an existing container (a sidebar
  group, the account panel, or Quick actions) rather than adding a persistent
  button, and Quick actions reaches every destination the viewer can open.

A page takes one of two widths, chosen by what it holds:

- The browse destinations (Library, Favorites, Record, Circles, Voice Actors,
  and Discover) are collection grids and fill the page.
- Every other page, the Personal and Manage pages and About, is one shared
  content column, centered in the page. Its tab row and section hairlines span
  the column, not the page.

A new page takes one of these widths rather than defining its own.

[Frontend](../architecture/frontend.md) describes how the shell implements
these rules.

## Secondary Navigation

A page with several views or sections takes one of two forms, and the same form
looks and works the same on every page:

- The views of a page are tabs along the top: a hairline under the row and a
  line under the open tab (Discover, Metadata, Workflows, Settings, System,
  and Cleanup). The page's own controls may share the row at its end. Settings,
  System, and Cleanup tabs carry an icon beside the name. A row too narrow to name every
  such tab shows icons and names only the open one, and a row that still does
  not fit scrolls sideways.
- An open-ended set of destinations, such as shelves, is a list beside the
  page, always with a text label (Favorites). Its entries are an icon, a name,
  and optional trailing detail such as a count, with a bar and a tint on the
  open one.

Both forms keep each destination's name as its accessible name, move with
arrow keys, and keep the open destination in view. They offer no control for
their own placement or labels and read no stored preference for either. A list
beside the page may instead be hidden whole: Favorites puts a toggle at the
start of its header row, the works take the freed width while the header still
names the open shelf, and the choice is remembered on the device. Phones show
the shelves as a row of chips and have no such toggle.

## Responsive Expectations

Desktop:

- Sidebar navigation with the browse destinations and the collapsible Personal
  and Manage groups, also as an icon rail.
- Source-aware work detail with a cover-tinted Hero that draws no frame of its
  own (cover, identity, tags with inline personal tags, a stat strip set off by
  a hairline instead of a box and only as wide as its figures, and
  bottom-aligned Hero actions), then the Directory as the main column. A side
  column holds the description, Credits, and Source info, in that order: what
  the work is, who made it, then the facts and actions of the shown source. It
  sits beside the Directory on wide screens and follows it on narrower ones,
  and it scrolls with the page, so the cards after a long description stay
  reachable. Source info lists the selected source's actions inline at every
  width.
- The Directory opens on its source tabs, or the name of its only source, with
  the source and name controls at the end of that row; it has no heading or
  summary line of its own. A folder has no Play all: opening a track plays the
  folder in order from that track, so its first track plays the whole folder.
  Only a folder whose first track is a video, which opens in the viewer
  instead, shows a quiet Play folder control in its contents toolbar; the
  Hero's action stays the page's one primary button.
- The work detail Hero has one primary action: Resume when the work has saved
  playback, otherwise Play for the folder the Directory opens on. When nothing
  can play, its place says why instead of showing a disabled button. Mark,
  your rating, and List are quiet controls beside it, without a border or a
  fill of their own. List keeps that look in and out of a list: beside its
  icon it names the list the work was added to most recently, with `+N` for
  any others, so where the work is saved shows without opening it. A long
  name truncates, and a work in no list shows the icon alone. A quiet
  Metadata button follows and opens the metadata editor. The work's local
  files entries (Manage files, Manage lyrics, Edit display names, Translate
  with AI) follow the local source's actions in Source info. Each entry, like
  each source action, shows only to a viewer allowed to use it, so a listener
  sees no management control. The metadata-language and
  directory-edition chips appear only when there is another choice.
- Circle and voice actor detail open with a compact summary shaped like the
  work detail Hero: a cover tint with no frame, the portrait, the name and
  aliases, and the personal tag chips with their editor under the name. One
  quiet line above the name carries a circle's maker code followed by its
  availability counts, or a voice actor's catalog size and availability
  counts (a voice actor shows no internal id); a count of zero is left out,
  and a circle leaves the catalog's size to its Works tab. A quiet row of
  Favorite, Subscribe, the catalog refresh, and More sits beside them; wide
  layouts set that row at the summary's top right, so the summary stays about
  as tall as the portrait. These pages have no primary action. The catalog
  refresh reads First pull until the catalog was pulled once and Refresh
  after that, names the last sync in its tooltip, and while a refresh runs
  shows its progress and opens the run. The rest of catalog management (Retry
  metadata, the catalog sync dialog, and alias management) waits in More
  beside the personal cover choice. Each catalog control appears only for a
  viewer allowed to use it, and sync state and failed sources show only to
  that viewer.
- Persistent lower-right player dock with full, compact, and draggable mini
  modes.
- The page always reserves the classic scrollbar gutter, so content width does
  not depend on whether the page scrolls.

Mobile:

- Bottom navigation.
- System and Cleanup tabs that do not fit fold into one row of icons that
  names only the open tab; tab rows scroll sideways and a page's controls move
  below its tabs.
- Work detail places the Hero actions directly below the title and circle, on
  one horizontally scrollable row, so Play stays on the first screen however
  long the credits and tags run: the primary action, then Mark, your rating,
  List, and Manage as icons, with List naming its list as on desktop. The Info
  tab shows the description, Credits, and Source info, which lists the
  selected source's actions, in the side column's order.
- Circle and voice actor detail keep the summary's order, with the counts and
  the icon action row below the portrait and name. The works toolbar puts a
  circle's tabs on their own row, then one row with the result caption and
  Search, the order, the filter, and View, whose sheet holds the display
  options and selection. Search opens its field full width above that row.
- The native server connection form keeps the address on its own full-width
  row, with protocol and port below. Controls remain inside a 320px viewport
  without horizontal scrolling and retain at least 44px touch targets.
- Viewport-bounded popovers or sheets for filters and source picking.
- Phone browse toolbars keep search behind a Search icon, since it is used
  less than the order and filters: Library, Favorites, Circles, Voice Actors,
  and the works of a circle or voice actor. The icon opens the field above the
  controls and focuses it; the field stays open while it holds a query,
  including one restored from history or set by a link, and closing it clears
  the query so a hidden field never narrows the results.
- The phone Library toolbar puts the source menu, the result count and page,
  and Search, Recently played, and View as icons on one row. The row below
  holds what shapes the results, the labeled order with its reshuffle and the
  Quick mark filter; the order's name truncates before the row overflows a
  360px screen. Search conditions are part of the query, so the field stays
  open while any is set.
- The phone Circles and Voice Actors lists put the sideways-scrolling view
  chips and, at the row's end, Search and page size on one row.
- The phone Favorites shelf puts, below its shelf row, whose selected chip
  names the open shelf in place of a header: the labeled sort with Search,
  Filters, and the view utilities at the row's end, then the Quick mark chips
  in a horizontally scrollable row.
- Text inputs, textareas, and selects use at least 16px text on coarse
  pointers so iOS WebKit never zooms into a focused control. The viewport keeps
  pinch zoom; fine-pointer layouts keep their compact control text.
- Player page optimized for one-handed listening.
- Dynamic viewport and safe-area insets protect fixed controls, sheets, and
  dialogs in portrait and landscape.
- Horizontal scroll strips clip vertical overflow, so a vertical swipe that
  starts on one scrolls the page.
- Desktop side panels become viewport-bounded sheets or stacked task surfaces;
  they must not shrink the listening controls below their touch contract.
