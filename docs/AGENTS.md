# Documentation Agent Guide

These rules cover every public Markdown file: `docs/`, the root `README.md`
and its translations, `CONTRIBUTING.md`, and the agent guides. Where each
topic belongs is in [Documentation Rules](README.md#documentation-rules).

## Writing Rules

Docs describe the current system and its current decisions, not how it got
there.

- Write in present tense. Do not narrate change: no "previously", "no longer",
  "now", "as before", "was removed", "migration NNN adds", version-dated
  asides, PR/issue/commit references, or before/after comparisons.
- When behavior changes, rewrite the affected section as if it had always been
  this way instead of appending a paragraph. Search for and remove every
  statement the change contradicts, including user pages, operations pages,
  and translations.
- Compatibility that still runs is current behavior. State it as a rule
  ("`/maintenance` redirects to Settings"), not as a story.
- State each rule or fact in one place and link to it instead of restating it.
- Reference docs contain no TODOs, plans, roadmaps, or dated measurement logs.

## History

History belongs only in `docs/history/` (release notes, with pending changes
and per-release upgrade steps in `unreleased.md`) and in the context of ADRs in
`docs/decisions/`. Release notes and `unreleased.md` fold each area's changes
under its title; follow
[Release Notes](development/commit-and-release.md#release-notes).

## Translations

When an English user page under `user/en/` or the root `README.md` changes,
update the matching locale pages in the same change; the `doc-locale-sync`
skill in [`.claude/skills/`](../.claude/skills/README.md) has the procedure. If
a translation cannot be updated, remove the stale passage rather than leave it
contradicting the English page.

## Validation

Run `make frontend-docs`. Public examples use reserved domains and synthetic
identifiers, as the root [`AGENTS.md`](../AGENTS.md#release-and-handoff)
requires.
