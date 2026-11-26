# Frontend Agent Guide

The root [`AGENTS.md`](../AGENTS.md) invariants apply here. The
[frontend architecture index](../docs/architecture/frontend.md) lists its topic
pages; open only the page a change needs.

## Dependency Direction

```text
app and pages -> features/<domain>, player -> shared (components, hooks, lib) -> components/ui
```

- App and page layers compose features and the player, which never import
  them back; navigation a feature or the player needs lives in `lib`. Sibling
  features talk through composition or an extracted shared contract, not each
  other's internals. Oxlint's `kikoto/dependency-direction` fails imports
  that break the direction; never add to its `crossFeatureAllowance`.
- Promote a domain only once it owns a real page or flow plus several cohesive
  files. Extract incrementally; no repository-wide moves.
- Keep UI, state models, and transport separate when that makes behavior
  independently testable. Do not add unrelated orchestration to large page
  files.
- A feature with several outside consumers exposes a small explicit public
  entry instead of deep imports.
- Details: [Code Organization](../docs/architecture/frontend/structure.md#code-organization).

## UI Contracts

- Follow the [design contract](../docs/development/design.md). Preserve the
  global player across navigation and contain page failures so one remote or
  media error never discards known local state; see
  [Failure Boundaries](../docs/architecture/frontend/structure.md#failure-boundaries).
- Avoid helper labels and explanatory text; let the layout explain the surface.
  When a description still belongs:
  [Helper Text](../docs/development/design.md#helper-text).
- Use semantic design tokens. Status color communicates availability or
  intent, never source identity:
  [Semantic Tokens](../docs/development/design.md#semantic-tokens).

## Tests

- Browser tests use accessible roles, names, and labels. Add an authored
  semantic marker only for a complex app-owned surface with no accessible
  boundary; utility classes and incidental DOM ancestry are never a contract.
  See [Assertions and Locators](../docs/development/testing.md#assertions-and-locators).
- Pure visual assertions only protect a documented layout, accessibility, or
  responsive contract.
- Fixture work codes:
  [Synthetic Fixture Data](../docs/development/testing.md#synthetic-fixture-data).
- Layers and runners: [Frontend](../docs/development/testing.md#frontend).

## Which Section To Open

| Change | Section |
| --- | --- |
| A page or surface | [Major Surfaces](../docs/architecture/frontend/surfaces.md), then the user page under `docs/user/en/` |
| Interaction, focus, gestures | [Interaction Principles](../docs/architecture/frontend/interaction-principles.md) |
| Visual hierarchy, density, actions | [Action Hierarchy](../docs/development/design.md#action-hierarchy), [Information Density](../docs/development/design.md#information-density) |
| Shell, navigation, layout breakpoints | [App Shell](../docs/development/design.md#app-shell), [Secondary Navigation](../docs/development/design.md#secondary-navigation), [Responsive Expectations](../docs/development/design.md#responsive-expectations) |
| Error and retry states | [Failure and Recovery](../docs/development/design.md#failure-and-recovery) |
| Titles and languages | [Multilingual title presentation](../docs/architecture/frontend/metadata-editor.md#multilingual-title-presentation) |
| Playback reports | [Playback Reports](../docs/architecture/frontend/playback-reports.md) |
| Styling stack, hooks | [Frontend Guidelines](../docs/development/frontend-guidelines.md#principles) |
