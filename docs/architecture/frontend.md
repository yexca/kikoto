# Frontend

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
