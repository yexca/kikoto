# ADR-0005: Custom Work Codes

## Status

Accepted.

## Context

A work is identified by its `primary_code`, and a local folder belongs to a
work because its name carries that code. Every scan path relies on this: full
and incremental scans discover work folders by name, a known folder is checked
by the code in its name, and a scan marks a work it does not find missing.
Some library folders hold audio that has no catalog code, so they never become
works.

Binding such a folder to a work in the database would need every scan path to
recognize a second kind of folder identity, and the binding would be lost when
the folder is renamed or moved outside Kikoto.

## Decision

Give a folder without a catalog code a custom work code and write the code into
the folder's name.

- A custom work code is `KT` followed by eight digits. It is a work code like
  the catalog prefixes, so the work stays one `primary_code`. The scanner
  finds the folder by name only in the bracketed form Kikoto writes, such as
  `[KT00000001]`, and a remote source never addresses a custom work, since
  the code exists only in this library.
- Kikoto assigns the numbers from `custom_work_code_counter` and never assigns
  a number twice. It skips a number that a work or a folder name already uses.
- Creating a custom work renames the folder by appending the code in brackets,
  such as `Example Work [KT00000001]`. The rename stays inside the folder's
  parent, on the same filesystem. Before the first custom work, an
  administrator accepts a notice describing the rename; the server records the
  acceptance and refuses creation without it.
- A custom work has no provider identity: DLsite metadata sync and DLsite links
  skip it, and its metadata is what the user edits.

## Consequences

- Scans, folder locations, cleanup, and the watcher need no custom-work rule.
- The library folder must be writable to create a custom work.
- A custom code identifies a work only in the library that assigned it.
  Personal data moved to another library matches whichever work carries the
  same code there.
- A folder name that contains `KT` and digits outside that bracketed form names
  no work, so words such as `Projekt 2024` do not become works.
