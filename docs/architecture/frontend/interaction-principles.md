# Interaction Principles

The cross-surface interaction rules for failures, secondary navigation, mobile
layout, work collections and cards, client storage scopes, recommendations, and
directory ordering.

## Failures and Navigation Forms

The general principles (known local state first, separate remote loading,
compact icon controls, global playback) are in
[Frontend Guidelines](../../development/frontend-guidelines.md#principles).

- Keep source failures local to the affected source.
- Keep work-summary and directory states independent. A media-stage failure
  must not discard an already rendered detail shell.
- Give secondary navigation one of two forms, both from `components/ui/sub-nav`:
  `SubNavTabs` along the top of a page for its views (Discover, Metadata,
  Workflows, Translation, Tags, Settings, and System), and a list beside the
  page for an open-ended set of destinations (the Favorites shelf list composes
  `SubNavColumn` and `subNavItemClassName` around its own entries). Tabs
  that all carry an icon show it beside the name; `SubNavTabs` measures the
  named row and, where the row is too narrow for it, folds the tabs to icons
  that name only the open one before it scrolls sideways. Both forms keep
  every destination's label as its accessible name, move and select with the
  arrow keys, Home, and End, and keep the open destination in view. They offer
  no options for their own placement or labels, and read no stored
  preference.

## Mobile Layout

- Treat bottom navigation, safe areas, Compact player placement, page clearance,
  and update notices as one fixed-surface layout contract.
- Size mobile search and modal layers against the visual viewport. The frontend
  hides bottom navigation and player surfaces during text entry so focused
  controls and scrollable results remain visible without relying on Android
  activity resize behavior.

## Work Collections and Cards

- Use the shared work-collection layout and work-card view model whenever a
  surface presents works. Page-specific filters and statistics may differ, but
  grid behavior and responsive column choices should remain aligned.
- Persist work-collection column settings as one shared browser preference,
  rather than separate page-local selections.
- Keep provider tags to two measured card rows with an overflow popover. Card
  summaries use Circle / Series, DL sales, segmented rating, known available
  alternate-language state, and a compact playback-history indicator when a
  persisted cursor exists.
- The simple card is the `simple` layout of the compact work card
  (`components/work-card/CompactWorkCard`), which every surface with a card
  mode reaches. Its details, including the footer a
  surface passes, mount on the card's first pointer or focus event, so a page
  of resting cards measures no tags and holds no action controls. The
  `.work-card-simple` rules in `styles.css` decide when mounted details show:
  on hover for a fine pointer, while a control inside the card reports
  `aria-expanded="true"`, or while the card sets `data-details-open`, which it
  does for its toggle and for keyboard focus inside it. Keyboard focus is card
  state because a control that a `:focus-visible` rule hides while focus moves
  cannot take the focus. A control that opens a popover from a card footer
  sets `aria-expanded`. A view model's `mark` puts the quick mark on
  the simple card's cover.

## Client Storage

Browser storage is read and written only through `lib/clientStorage`, and
Oxlint's `kikoto/no-direct-storage` rejects `localStorage` and
`sessionStorage` anywhere else outside tests. Every key names its scope when
it is built:

| Scope | Key | Holds |
| --- | --- | --- |
| Device | `deviceKey` | Pure display preferences such as theme, layout, and player Dock mode, and the native server address and session that choose the server |
| Server | `serverKey` | Per-device conveniences for one server's lists and workflows, such as ranking orders and workflow run options |
| Account | `accountKey`, or `accountScopeKey` with a handed-down storage scope | Anything that carries the account: player queue and preferences, video positions, Library and Favorites browse restoration, source visibility, and the anonymous locale |

- The account scope is the configured server identity and current user, or
  the anonymous principal (`lib/clientStorageScope`); in-memory work media
  uses the same scope. When unsure, a value is account-scoped.
- `localStore` keeps a value across visits and `sessionStore` for one browser
  tab or native-app launch. Reads return null for storage that is missing,
  blocked, or unreadable, and a refused write leaves the choice in memory for
  the visit.
- A key's format is its saved data. Changing a key's scope or name moves the
  saved value with `carryOver` on read, or states why the value may reset.
- Demo mode may change local display preferences even though server-backed
  account and administration state remains read-only.

## Recommendations

- Keep the recommendation client-session id in server-and-user-scoped session
  storage. Navigation and reloads in one browser tab reuse it; a newly opened
  tab or native-app cold launch creates a new id and stable recommendation seed.
  Manual reshuffle changes the browse seed without replacing the session id.
- Pass the list's opaque `recommendationContext` with its session when opening
  an explanation. Query ordering adjustments appear only for an applicable
  context; ordinary badges and candidate-tail explanations still show actual
  frozen affinity. `recommendation_context_expired` (HTTP 410) retries the
  explanation with the original session and without the context, then omits
  ordering adjustments. Identity, generation, and other failures remain visible.
  Demo explanations label their score as randomly generated and omit preference
  contributions and ranking adjustments. Optional badge failure has an inline
  retry and preserves the cards. A failed recommendation-sort preparation keeps
  the last loaded cards alongside its retry state. The global player remains
  mounted throughout.

## Directory Presentation

- Reserve a directory-shaped skeleton with stable height while media is being
  indexed or loaded, then replace it in place without a separate loading card.
- Build Tree rows and playback queues from one folder-first natural ordering.
  Every list of file and folder names sorts with `naturalNameCompare`
  (`lib/naturalNameOrder.ts`), which compares digit runs by value and reads a
  kanji numeral after 第 as its number. A Record folder listing arrives in
  the same order from the server's `internal/naturalorder` and keeps it.

## Design and Semantic Contracts

Theme roles, status color, control states, and elevation follow
[Semantic Tokens](../../development/design.md#semantic-tokens) and
[Visual Direction](../../development/design.md#visual-direction); browser-test
markers follow
[Semantic UI Boundaries](../../development/design.md#semantic-ui-boundaries).
