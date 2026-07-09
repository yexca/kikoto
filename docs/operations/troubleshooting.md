# Troubleshooting

## The Frontend Does Not Open

- Confirm Docker Compose is running.
- Check that port `7655` is not already in use.
- Refresh the published image with `docker compose pull`, then restart the
  stack with `docker compose up -d`.

## The Backend Is Unhealthy

- Check `http://127.0.0.1:7659/health`.
- Confirm the `config/` mount is writable.
- Check the backend container logs.

## Local Works Do Not Appear

- Confirm files are under the configured data root.
- Check local scan depth.
- Run a local library scan.
- Confirm folders contain supported product codes.

## Remote Sources Fail

- Check the source endpoint in Settings.
- Run or wait for a source availability check.
- Confirm the source supports Kikoeru-compatible APIs.
- Remember that source outages should not affect local or cached playback.

## Metadata Is Missing

- Confirm local scan detected the work code.
- Run DLsite metadata sync.
- Check Activity for `metadata_sync` failures.
- Some provider products may be removed or unavailable; those should appear as
  reviewable workflow candidates rather than fatal scan failures.

## Related Docs

- [Getting started](../getting-started.md)
- [Reliability](reliability.md)
- [Workflows](../product/workflows.md)
