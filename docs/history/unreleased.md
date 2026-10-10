# Unreleased

- Large temporary files live in `.kikoto-tmp` inside the cache root instead of
  the system temporary directory, which the bundled Compose files bound to a
  64 MiB `/tmp`:
  - **Compact database** no longer fails with `database or disk is full` once
    the database outgrows `/tmp`.
  - A Kikoeru database upload larger than `/tmp` is received in full instead
    of failing partway.
  - Compaction needs free space on the cache volume of about the database
    size. Startup empties `.kikoto-tmp`. No Compose change is needed.
