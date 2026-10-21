---
name: doc-locale-sync
description: Update the translated Kikoto docs after an English user page under docs/user/en/ or the root README.md changes.
---

# Doc Locale Sync

English pages are canonical; the rule for translations is in
[Documentation](../../../AGENTS.md#documentation).

1. Find the counterparts. `docs/user/translations.json` lists the English
   source pages and the locales; each locale has the same filename under
   `docs/user/<locale>/`. `README.md` maps to
   `docs/readme/README.<locale>.md`.
2. Translate every changed section from the English page into each locale.
   Use the app's localized UI names from `frontend/src/i18n/surfaces/` and
   `frontend/src/i18n/resources/`, also inside code spans that name UI text.
   Keep links, code, and identifiers unchanged, and check links to headings,
   whose anchors follow the localized heading text.
3. When a passage cannot be translated, remove the stale passage from that
   locale rather than leave it contradicting the English page.
4. Translations of different locales are independent; when the agent can
   delegate, one translation subagent per locale works well.
5. Run `make frontend-docs`. Its locale check confirms that every page exists
   in every locale, not that the content matches, so compare the changed
   sections yourself before handing off.
