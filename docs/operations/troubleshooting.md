# Troubleshooting

## The Frontend Does Not Open

- Confirm Docker Compose is running.
- Check that port `7655` is not already in use.
- Refresh the published `latest` image and recreate the stack with
  `docker compose up -d`.

## The Backend Is Unhealthy

- Check `http://127.0.0.1:7655/health` (the published host port; inside the
  container the backend listens on `7659`).
- Confirm the `config/` mount is writable.
- Check the backend container logs.

## Local Works Do Not Appear

- Confirm files are under the configured data root.
- Check local scan depth.
- Run a local library scan to refresh local presence.
- Confirm folders contain supported product codes.

## Deleting Or Fetch Fails With A Permission Error

- On a Linux host, check who owns the mounted folder. A custom Compose file
  that drops all capabilities without `cap_add: [DAC_OVERRIDE]` cannot write
  to a folder that belongs to another user; see
  [container isolation](docker.md#container-isolation).
- Copy `cap_add` from the bundled `docker-compose.yml`, or give the root user
  (uid 0) write access to the folder.

## Remote Sources Fail

- Check the source endpoint in Settings.
- Run or wait for a source availability check.
- Confirm the source supports Kikoeru-compatible APIs.
- Remember that source outages should not affect local or cached playback.

## Metadata Is Missing

- Confirm local scan detected the work code.
- Run the independent metadata sync workflow, or explicitly enable
  `Follow-up run` when starting or scheduling a local scan.
- Check Activity for `metadata_sync` failures.
- Some provider products may be removed or unavailable; those should appear as
  reviewable workflow candidates rather than fatal scan failures.

## Related Docs

- [Getting started](../user/en/getting-started.md)
- [Reliability](reliability.md)
- [Workflows](../user/en/workflows.md)
