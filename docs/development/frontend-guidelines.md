# Frontend Guidelines

## Principles

- Load remote source availability and trees separately from local known state,
  and render the local state first. Failure and loading behavior is in
  [Failure and Recovery](design.md#failure-and-recovery).
- Keep controls compact and predictable, and use icons for common actions.
- Preserve playback across navigation.
- Keep app, domain, shared, and primitive dependencies directed downward, as
  described in [Code Organization](../architecture/frontend/structure.md#code-organization).
- Prefer accessible roles and labels, with stable semantic markers only for
  complex app-owned surfaces ([Semantic UI Boundaries](design.md#semantic-ui-boundaries)).
- Keep hook dependency lists complete. When an effect must not re-run for a
  value, read it through `useStableCallback` or a ref instead of leaving it out
  of the list.

## Styling

The frontend uses React, TypeScript, Vite, Tailwind CSS, local shadcn-style
components, and lucide-react icons. Colors, states, and touch targets follow
[Semantic Tokens](design.md#semantic-tokens).

## Documentation

Update product docs when a user-visible workflow or surface changes.
