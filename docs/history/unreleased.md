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

- The bundled `docker-compose.yml` adds back the `DAC_OVERRIDE` capability.
  With every capability dropped, the container's root user could not write to
  a mounted folder that belongs to another host user. On a Linux host with
  such a media library, deleting a work and Fetch failed with a permission
  error, and a folder closed to other users could not be scanned.

  Upgrade: copy `cap_add` into a custom Compose file that has `cap_drop: ALL`.
  The Demo Compose file is unchanged.
