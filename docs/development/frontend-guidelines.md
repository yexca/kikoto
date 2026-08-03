# Frontend Guidelines

## Principles

- Render local known state first.
- Load remote source availability and trees separately.
- Keep controls compact and predictable.
- Use icons for common actions.
- Preserve playback across navigation.
- Avoid making remote source failures block local views.
- Keep app, domain, shared, and primitive dependencies directed downward.
- Prefer accessible roles and labels; use stable semantic markers only for
  complex app-owned surfaces that lack an accessible boundary.
- Contain page failures inside the app shell so playback continuity survives.

## Styling

The frontend uses React, TypeScript, Vite, Tailwind CSS, local shadcn-style
components, and lucide-react icons.

Use semantic theme roles rather than hard-coded status colors. Keyboard focus
must stay visible, and mobile actions must provide pressed feedback and a large
touch target without depending on hover.

## Documentation

Update product docs when a user-visible workflow or surface changes.

See [Frontend architecture](../architecture/frontend.md),
[Testing](testing.md), and [Secure development](security.md).
