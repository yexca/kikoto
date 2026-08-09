# Design

Kikoto should feel like a quiet personal media library and player.

This repository-wide contract governs new and changed UI across the browser and
Android shells.

Sections explicitly labeled as current describe the implementation. The other
rules are constraints for new and changed surfaces and a direction for gradual
convergence; they do not claim that every legacy surface already complies.

## Design Principles

- Listening comes first.
- Library management should be dense but calm.
- Background work should be visible without taking over the product.
- File source state must be understandable at a glance.
- Mobile should not feel like a reduced desktop layout.
- Failures should stay close to the surface that failed and leave playable local
  state intact.

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
  visible icon is smaller.

Keyboard focus must remain clearly visible. Do not remove focus feedback merely
to match pointer styling, and do not rely on hover for a control used on touch.

## Action Hierarchy

- Give each action cluster one obvious primary command at most.
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
- Page-local brand colors, source-specific status colors, or hard-coded light
  and dark palette branches.

## Information Density

Presets may tune shared control heights, card padding, navigation height, and
page rhythm, but they do not change information architecture. Touch targets
retain their accessibility floor on mobile, and dense operational surfaces must
remain scannable in every preset.

Work cards should show browsing-level facts:

- Cover.
- Product code.
- Title.
- Circle.
- External rating metadata when useful.
- Current price or Free state when known.
- Personal favorite, tag, and quick-mark state.
- File availability badges.
- Listening progress.

Work detail pages should show decision-level facts:

- Metadata source.
- Tags and credits.
- Translation relation.
- File tree.
- File locations.
- Cache/download actions.

Use cards for repeated objects, not for every section. Settings and Maintenance
pages should share a consistent content width, section spacing, field rhythm,
and destructive-action placement. Wide diagnostic tables may opt out of the
content cap, but ordinary forms should not define their own page-local width.

## Failure and Recovery

- Preserve the app shell and global player when a route or remote panel fails.
- Render known local metadata before slower media or remote state.
- Loading, empty, unavailable, permission, retryable, and terminal failure are
  distinct states; do not collapse all of them into one toast.
- A transient toast reports an event. A failure that still blocks the task needs
  a persistent inline state with a Retry or recovery action.
- User-facing errors are concise and sanitized. Private endpoints, local paths,
  credentials, and raw upstream bodies belong only in protected diagnostics.

## Semantic UI Boundaries

Accessible roles, names, labels, and native semantics are the primary UI
contract. For complex app-owned regions such as Work detail, the global player,
or a workflow canvas, an explicit stable semantic marker may define the region
for browser tests and controlled automation.

Markers describe business roles, not current styling or visible copy. Utility
classes, DOM ancestry, generated identifiers, and translated text are not stable
structural APIs. Add markers selectively instead of annotating every wrapper.

## Responsive Expectations

Desktop:

- Sidebar navigation.
- Source-aware work detail with cover, metadata matrix, and bottom-aligned Hero
  actions.
- Persistent lower-right player dock with full, compact, and draggable mini
  modes.

Mobile:

- Bottom navigation.
- Viewport-bounded popovers or sheets for filters and source picking.
- Large touch targets.
- Player page optimized for one-handed listening.
- Pressed feedback must not depend on hover availability.
- Dynamic viewport and safe-area insets protect fixed controls in portrait and
  landscape.
- Desktop side panels become viewport-bounded sheets or stacked task surfaces;
  they must not shrink the listening controls below their touch contract.
