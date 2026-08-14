# Frontend

On mobile, the app header is a compact tool bar ordered as Quick actions,
Notifications (when authenticated), Appearance, and account. Quick actions
opens the searchable Command Palette in a bottom sheet; Notifications,
Appearance, and account use anchored popovers. Appearance owns mode, style, and
color choices; the account surface owns Activity, account settings, native
connection actions, and authentication actions. On desktop, Quick actions and
the same command palette remain a centered surface while the header popovers
stay anchored to their triggers.

`MobileSheet` is the shared bottom-sheet primitive. It animates in from the
bottom and out toward the bottom, supports Escape and outside dismissal, and
accepts a downward drag on its handle to close. Its default layer is
transparent so sheet content does not add a backdrop mask. The shared
`MobileSheetHeader` and `MobileSheetBody` keep command and advanced-refresh
sheets on the same bordered header and compact scrolling body treatment. Mobile
command and advanced-refresh sheets rely on sheet dismissal rather than an
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

## Stack

- React.
- TypeScript.
- Vite.
- Tailwind CSS.
- Local shadcn-style primitives.
- lucide-react icons.

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

## Major Surfaces

- Library.
- Work detail.
- Favorites.
- Circles.
- Voice actors.
- Settings.
- Workflows.
- Activity.
- Users.
- Global player dock.

## Interaction Principles

- Render known local state first.
- Load slower source availability and remote trees separately.
- Keep source failures local to the affected source.
- Keep work-summary and directory states independent. A media-stage failure
  must not discard an already rendered detail shell.
- Prefer icons for compact controls and reserve text buttons for clear commands.
- Keep playback global so navigation does not interrupt the current queue.
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
- Tapping the active Library, Circles, or Voice Actors destination from its
  detail route returns to that workspace's last list state. Work detail routes
  remain part of Library regardless of the workspace that opened them.
- Distinguish Android client-old, server-old, and network-disconnected states;
  version actions open signed GitHub Releases and never imply silent install.
- Use the shared work-collection layout and work-card view model whenever a
  surface presents works. Page-specific filters and statistics may differ, but
  grid behavior and responsive column choices should remain aligned.
- Treat a compact detail-page back control as Up navigation. Work, Circle, and
  Voice actor detail use the current server-and-user-scoped list location for
  their own bottom-navigation destination instead of returning to another
  destination; wide layouts retain the source-aware browser-history return.
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
  content has rendered. Retry only deep history restoration, and cancel pending
  retries as soon as the user expresses scroll intent. Page-level cleanup must
  not overwrite another entry's saved position.
- For collection-to-detail navigation, keep only shareable semantic filters in
  the URL. Store complete browse state plus selection/focus anchors in the
  originating history entry and use session state as a refresh/new-entry
  fallback. Continue to parse legacy explicit browse parameters.
- Reserve a directory-shaped skeleton with stable height while media is being
  indexed or loaded, then replace it in place without a separate loading card.
- Build Tree rows and playback queues from one folder-first natural ordering.
- Treat Resume as the only persisted-position entry point. Ordinary track
  selection starts at zero, while an active source fallback carries the current
  in-memory time to the replacement location.

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

## Related Docs

- [Frontend guidelines](../development/frontend-guidelines.md)
- [Testing](../development/testing.md)
- [Secure development](../development/security.md)
