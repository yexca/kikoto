# Navigation, History, and Scroll

How browse workspaces are retained and resumed, how Back, the in-app back
stack, and detail ownership work, and how scroll and browse state follow
history entries.

## Workspaces

- Treat each mobile bottom-navigation destination as a resumable workspace.
  Switching destinations restores that destination's last stable list or detail
  route, history state, back stack, and scroll position for the current server
  and user; dialogs, pending mutations, and other transient overlays are not
  resumed.
- Retain every visited primary browse workspace (Library, Favorites, Circles,
  and Voice Actors) on both layouts so returning to a destination never reloads
  its rendered list. Each workspace has its own loading boundary, and the other
  route pages share one apart from them, so a route page that suspends never
  hides a retained workspace. The current location's page chunk starts loading
  with the app; the other workspaces, the command palette, and every route page
  the navigation offers load when the shell is idle (`app/routePageChunks`). A
  loaded chunk renders without suspending: React holds a shown Suspense fallback
  for at least 300ms, which would otherwise delay the page and the requests its
  effects start. An inactive workspace is hidden, cancels unfinished
  detail/list work, and pauses polling.
- A page owns its loading placeholder, because only the page knows its layout.
  The shell draws no placeholder shape while a page chunk loads; a slow chunk
  shows the shared refresh indicator. A page's first-data placeholder has the
  footprint of what it is about to show: a work collection uses its grid, card
  mode, and columns, and a settings tab uses the shape of its sections. Its
  pulsing blocks are `Skeleton` (`components/ui/skeleton.tsx`). Every loading
  placeholder carries `skeleton-reveal` (`styles.css`), through `Skeleton`'s
  `reveal` or on the container around its blocks: it keeps its footprint but
  stays hidden for its first 200ms, so a fast answer replaces a blank directly
  instead of flashing a placeholder. An empty result is shown
  only once the first page has answered.
- Keep destination switches proportional to the workspaces that change. A
  workspace that stays hidden skips shell-driven renders, and browse list items
  are memoized with stable item handlers so a page render does not re-render
  unchanged cards.
- Retain a visited list when opening a detail route from it: a circle, a voice
  actor, or a work opened from any page. Detail URLs do not reinitialize list
  controls or fetch a replacement collection. Returning reveals the loaded
  cards and restores the originating history entry's filters and page before
  list effects may write or fetch.

## Back and Detail Ownership

- The native shells navigate like a tabbed app rather than a browser
  (`lib/browserHistory`). The WebView keeps a single history entry, and that
  entry's state carries an in-app back stack of bounded entries. A push stacks
  the entry it leaves and replaces the current one; a change of tab, scope,
  filter, or page within one browse list replaces the list entry without
  stacking it (`app/workspaceNavigation`); a destination switch resumes the
  destination's own stack and is never a Back step; a push that opens a page
  of another browse workspace, such as a circle link in a Library work, starts
  that workspace with no stack and no return to the entry it leaves, so Back
  never restores another workspace's entry over its saved place.
  Returning to a stacked entry restores its state and scroll and dispatches
  `popstate`, so pages restore it the way they restore browser Back. Browsers
  keep browser history, whose Back button the app cannot remove.
- A work detail entry belongs to the page it was opened from. The work URL
  stays the canonical `/<primary_code>`; the history entry records its owner
  when it is created (`lib/appRoutes`), a work opened from another work
  inherits that work's owner, and a direct link belongs to Library. The owner
  decides which navigation item is current, which list Back falls back to, and
  which destination resumes the entry.
- A queued track records the page it was queued from and, when that was a work
  detail, its location, because a track of another edition carries that
  edition's code rather than the work the listener opened. On the
  bottom-navigation layout the Full player's cover leads back there
  (`lib/playingWorkNavigation`): the origin destination resumes its own entry
  when it still shows the work and otherwise opens the work as its own. In a
  browser Back returns to where the cover was tapped; with an in-app back
  stack the work starts its destination's stack, so Back goes up to that
  destination's list. On wide layouts, and for a track with no recorded
  origin, the work opens in the current page.
- Tapping the active destination from a detail route, including a work opened
  from it, returns to that workspace's last list state. A Record folder, or a
  file open over one, is such a detail, and Record's list is its root. Each
  destination resumes only the entries it owns, so a work opened from
  Favorites, Circles, or Voice Actors resumes under that destination and never
  replaces Library's saved destination.
- Detail-page Back returns to the entry that opened the detail on both layouts,
  including Favorites and nested creator routes. A resumed mobile detail uses
  its captured return entry; a direct link falls back to its workspace list.
  With an in-app back stack, Back with nothing stacked replaces the detail with
  that return rather than adding an entry. Tapping the active bottom-navigation
  destination remains workspace Up, which pops the destination's back stack to
  its nearest list entry, or replaces the detail with the list and clears the
  stack when none is stacked.
- The Android back button and the iOS left-edge swipe share one back order
  (`app/nativeBack`): command palette, sign-in, the topmost dialog, sheet, or
  popover, the player's own panels and full view, then the in-app back stack.
  With nothing stacked, a detail goes up to its destination's list. At any other
  destination's root the Android button opens Library, and at the Library root
  it asks for a second press before leaving the app; the iOS swipe stops at a
  destination's root and never leaves it or the app. The swipe comes
  from an app-local native edge recognizer, offered only where that plugin is
  registered, and yields when it starts on the Compact or Mini player, a
  slider, or a horizontally scrollable region. While the Android WebView shows
  an element fullscreen, the back button leaves fullscreen before this order.

## Scroll and Browse State

- Browse workspaces share the window scroll position. When a retained workspace
  becomes active, the shell applies that history entry's scroll offset before the
  first paint; a resumed workspace does not replay its own stored list offset.
- Keep scroll state per history entry and per in-app back stack entry. A push
  navigation starts at the top, while browser back/forward or an in-app Back
  restores the originating entry after its content has rendered. The shell observes content height for up to ten seconds
  for deep restoration and cancels all pending frames and observers on user
  scroll intent or navigation. Scroll writes belong to a unique history entry;
  delayed writes and page-level cleanup must not overwrite another entry's
  saved position, even when both entries share a URL.
- A Library page, page-size, sort, filter, or search change returns to the start
  of the new results once they render. Compact layouts jump to the page top
  after any scroll still running from the user's gesture settles, because
  WebKit abandons a long programmatic smooth scroll when the list is replaced
  or touch momentum continues; desktop smoothly brings the results anchor into
  view. The shared `collectionResultsScroll` owns this rule.
- For collection-to-detail navigation, keep only shareable semantic filters in
  the URL. Store complete browse state plus selection/focus anchors in the
  originating history entry and use session state as a refresh/new-entry
  fallback. Continue to parse legacy explicit browse parameters.
