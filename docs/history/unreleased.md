# Unreleased

- The Library on phones has a new toolbar and optional compact cards. Desktop
  layouts are unchanged.
  - Search is always visible instead of opening from a button. Sources and
    Quick mark filters are rows of chips, and the sort button names the current
    order and opens the orders and direction in a popover.
  - The result count and current page appear above the works and replace the
    top pager on phones; the bottom pager is unchanged.
  - A Continue listening strip lists recently played works with their
    progress. It starts collapsed and replaces the history button on phones.
  - **Compact cards** in display options, off by default, shows one column as
    rows with the cover beside the facts and two columns as short tiles, for
    Local, Tracked, and remote sources.

- Large temporary files live in `.kikoto-tmp` inside the cache root instead of
  the system temporary directory, which the bundled Compose files bound to a
  64 MiB `/tmp`:
  - **Compact database** no longer fails with `database or disk is full` once
    the database outgrows `/tmp`.
  - A Kikoeru database upload larger than `/tmp` is received in full instead
    of failing partway.
  - Compaction needs free space on the cache volume of about the database
    size. Startup empties `.kikoto-tmp`. No Compose change is needed.

- The bundled `docker-compose.yml` adds back the `DAC_OVERRIDE` capability.
  With every capability dropped, the container's root user could not write to
  a mounted folder that belongs to another host user. On a Linux host with
  such a media library, deleting a work and Fetch failed with a permission
  error, and a folder closed to other users could not be scanned.

  Upgrade: copy `cap_add` into a custom Compose file that has `cap_drop: ALL`.
  The Demo Compose file is unchanged.
