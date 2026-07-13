# Frontend

On mobile, the app header reserves fixed space for Search and a viewport-bounded
overflow menu. Theme, Activity, account, and native connection actions remain
available through that menu without widening the header.

The frontend is a React application focused on library browsing, work detail,
remote source management, and playback.

## Stack

- React.
- TypeScript.
- Vite.
- Tailwind CSS.
- Local shadcn-style primitives.
- lucide-react icons.

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
- Prefer icons for compact controls and reserve text buttons for clear commands.
- Keep playback global so navigation does not interrupt the current queue.
- Use the shared work-collection layout and work-card view model whenever a
  surface presents works. Page-specific filters and statistics may differ, but
  grid/masonry behavior and responsive column choices should remain aligned.
- Persist work-collection layout as one shared browser preference, rather than
  separate page-local selections.
- Keep scroll state per browser history entry. A push navigation starts at the
  top, while browser back/forward restores the originating entry after its
  content has rendered. Retry only deep history restoration, and cancel pending
  retries as soon as the user expresses scroll intent. Page-level cleanup must
  not overwrite another entry's saved position.
- For collection-to-detail navigation, persist shareable filters in the URL and
  keep ephemeral selection/focus anchors in the originating history entry.
