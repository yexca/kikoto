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
- Import a helper that already exists instead of redefining it per file. A
  helper that several consumers share lives in the lowest layer they have in
  common, and a copy that differs on purpose is named for the difference.
  `make duplicate-helper-check` reports a function name that a second file
  defines.

## Async Effects

An effect that loads data or registers a listener asynchronously cancels it
through `lib/effectScope.ts`, never through its own flag or `AbortController`:

- `startLoad(load, handlers)` runs one load and returns the cancel function
  for the effect to return. The load receives a signal and passes it to every
  API call. `onSuccess`, `onError`, and `onSettled` run only while the load is
  current, so they hold no `cancelled` checks.
- `createEffectScope()` holds every load and listener of an effect that
  repeats, such as a refresh on an event or a poll: `scope.load` runs a load,
  with `delayMs` for a poll interval, and `scope.listen` holds a listener
  that registers asynchronously, such as a native plugin's, removing it even
  when it registers after cleanup. The effect returns `scope.cancel`.
- `useLatestLoad` runs a load that several triggers start, such as mounting, a
  poll, and a refresh after an action, instead of a request counter in a ref.
  Only the latest load reports; a newer one or unmounting cancels it, and
  `run` resolves once its load settles so an action can await its refresh.
- `useDebouncedRequest` sends a request once its key has held still, keeps the
  last result, and reports whether that result answers the current key. It
  serves previews of an edit that is still changing.

A cancelled load never reports a result or a failure. The transport already
rejects a call whose signal aborted or whose session changed, so passing the
signal is what keeps stale data out; after an await that takes no signal, call
`signal.throwIfAborted()` before setting state. The promise `scope.load`
returns settles even for a dropped load, for the rare cleanup that must follow
it, such as ending a "loading more" state. `useStableCallback` reads a value
that must not restart the effect.

Plain-text reads go through `getText` in `lib/apiTransport.ts`, including a
remote source's text preview (`getTextPreview`), so they share the session
fencing in [Failure Boundaries](../architecture/frontend/structure.md#failure-boundaries).

Oxlint enforces this: `kikoto/no-effect-cancel-flag` and
`kikoto/no-effect-abort-controller` report the hand-rolled forms, and
`kikoto/no-hook-deps-suppression` reports a disabled hook dependency rule. The
rules live in `frontend/oxlint-plugin-kikoto.mjs`.

## Styling

The frontend uses React, TypeScript, Vite, Tailwind CSS, local shadcn-style
components, and lucide-react icons. Colors, states, and touch targets follow
[Semantic Tokens](design.md#semantic-tokens).

## Documentation

Update product docs when a user-visible workflow or surface changes.
