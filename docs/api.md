# API Reference

The backend listens on port `7659` in the default Docker stack.

## Health

```http
GET /health
```

Returns service health.

## Auth

```http
GET /api/auth/me
```

Returns the current authentication state. In dev mode this returns the configured root super administrator.

```http
POST /api/auth/login
```

Logs in with JSON credentials and sets an HttpOnly session cookie.

```json
{
  "username": "root",
  "password": "change-me"
}
```

```http
POST /api/auth/logout
```

Deletes the current session cookie.

## Users

```http
GET /api/users
POST /api/users
PATCH /api/users/{id}
DELETE /api/users/{id}
```

Manages local user accounts, roles, enabled state, and passwords.

Requires `users:manage`. Administrators can manage normal users and administrators. Only super administrators can grant or modify the `super_admin` role.

## Works

```http
GET /api/works
```

Returns the current library work list with metadata, availability counts, cover URL, and DLsite URL when available.

Requires `library:read`.

```http
GET /api/works/{code}/source-availability
```

Checks local, cache, remote aggregate, and configured compatible source
availability for a product code through a backend workflow.

Requires `library:read`.

```http
GET /api/works/{code}/resolve
```

Resolves a product code to the canonical work route when the code is part of a
translated product-code family.

Requires `library:read`.

```http
GET /api/works/{id}
```

Returns work detail, including metadata, known translated editions, media items,
and file locations. Translated editions include local-media availability so the
frontend can show playable and unavailable editions separately.

Requires `library:read`.

```http
PATCH /api/works/{id}/user-state
```

Updates the current user's work state. Supported `listeningStatus` values are `none`, `want_to_listen`, `listening`, `finished`, `relisten`, and `paused`.

```json
{
  "listeningStatus": "want_to_listen"
}
```

Requires `library:read`.

```http
GET /api/favorite-lists
```

Returns the current user's favorite lists.

Requires `library:read`.

```http
GET /api/works/{id}/favorite-lists
```

Returns favorite-list membership for one work.

Requires `library:read`.

```http
PUT /api/works/{id}/favorite-lists
```

Replaces favorite-list membership for one work.

```json
{
  "listIds": [1, 2]
}
```

Requires `library:write`.

## Circles

```http
GET /api/circles
```

Returns known circle or maker summaries with catalog, playable, local, remote,
missing, stale, rating, note, sync state, and source counts.

Requires `library:read`.

```http
GET /api/circles/{externalId}
```

Returns one circle or maker detail by external id, including catalog works and
source tags.

Requires `library:read`.

```http
PATCH /api/circles/{externalId}/user-state
```

Updates the current user's rating, note, or favorite state for the circle.

Requires `library:write`.

```http
POST /api/circles/{externalId}/refresh
```

Runs a circle metadata and catalog refresh workflow.

```json
{
  "scope": "all",
  "mode": "incremental",
  "productMode": "available"
}
```

`scope` may be `all`, `catalog`, `work`, or `source`. `all` runs catalog
refresh, work metadata sync, then source matching. `mode` may be `incremental`
or `full`. `productMode` may be `available` or `all`.

Requires `metadata:sync`.

## Voices

```http
GET /api/voices
GET /api/voices/{personId}
PATCH /api/voices/{personId}/user-state
PUT /api/voices/{personId}/tags
```

Lists voice actors, loads voice detail pages, and stores favorite, rating, note,
and user tag state.

Requires `library:read`; write operations require the current user's library
state permissions.

```http
GET /api/voices/{personId}/alias-candidates
POST /api/voices/{personId}/aliases
DELETE /api/voices/{personId}/aliases/{aliasId}
GET /api/voices/{personId}/merge-reviews
POST /api/voices/{personId}/merge-candidates/{sourcePersonId}
POST /api/voices/{personId}/merge-reviews/{reviewId}/undo
```

Supports voice alias review, duplicate person merge, and merge undo.

```http
DELETE /api/circles/{externalId}/catalog/{code}
```

Removes a stale catalog row from a circle after user confirmation.

Requires `metadata:sync`.

## Assets

```http
GET /api/assets/covers/{file}
```

Serves cached cover images from the configured cache root.

## Media Streaming

```http
GET /api/media/{id}/stream
```

Streams an available local media file location. The endpoint supports HTTP range requests through Go file serving, which enables browser seeking.

Requires `playback:use`.

```http
PATCH /api/media-items/{id}/progress
```

Persists playback progress for the current user and logical media item.

```json
{
  "positionSeconds": 123.5,
  "durationSeconds": 456.0,
  "completed": false
}
```

Requires `playback:use`. Saving progress automatically moves a work from `none` or `want_to_listen` to `listening`.

## File Sources

```http
GET /api/file-sources
POST /api/file-sources
PATCH /api/file-sources/{id}
DELETE /api/file-sources/{id}
```

Lists and manages configured file sources.

Requires `sources:write`.

```http
GET /api/library-sources
```

Returns enabled and disabled compatible remote sources visible from Library.

Requires `library:read`.

```http
GET /api/remote-sources/{id}/works
GET /api/remote-sources/{id}/works/{code}
POST /api/remote-sources/{id}/works/{code}/fetch-plan
POST /api/remote-sources/{id}/works/{code}/fetch
POST /api/remote-sources/{id}/works/{code}/sync
POST /api/remote-sources/{id}/works/{code}/cache
```

Browses a configured compatible remote source and syncs a selected remote work
into the unified local database through the remote source sync workflow.
Detail, fetch planning, fetch, and cache endpoints operate on selected works
without creating duplicate work identities. Fetch first materializes selected
remote files under `/cache/media/<source_code>/<code_prefix>/<code_group>/<work_code>/`,
then promotes them into the local data tree.

Requires `library:read`.

## Settings

```http
GET /api/settings
PATCH /api/settings
```

Returns and updates administrator-managed settings, including local scan depth
and remote sync/cache options.

```http
GET /api/runtime-settings
```

Returns user-visible runtime settings needed by Library, such as whether remote
interest actions should pull work information automatically.

## Workflows

```http
GET /api/workflow-definitions
POST /api/workflow-definitions
PATCH /api/workflow-definitions/{id}
DELETE /api/workflow-definitions/{id}
```

Lists and manages editable user workflow definitions. System definitions are
read-only.

Requires `workflows:run`.

```http
GET /api/workflow-triggers
POST /api/workflow-triggers
PATCH /api/workflow-triggers/{id}
DELETE /api/workflow-triggers/{id}
```

Lists and manages persisted non-manual workflow triggers.

Requires `workflows:run`.

```http
GET /api/workflow-runs
GET /api/workflow-runs/{id}
```

Returns recent workflow runs. The detail endpoint returns node run records for
Activity diagnostics.

Requires `workflows:run`.

```http
POST /api/workflow-runs/local-scan
```

Runs the local folder scan workflow.

Requires `workflows:run`.

```http
POST /api/workflow-runs/dlsite-sync
```

Runs DLsite metadata sync for detected works.

Requires `metadata:sync`.

```http
POST /api/workflow-runs/remote-bulk
```

Runs a parent bulk remote workflow for one configured compatible source.

```json
{
  "action": "sync_fetch",
  "sourceId": 1,
  "codes": ["RJ000001", "RJ000002"]
}
```

`action` may be `sync`, `fetch`, or `sync_fetch`. Legacy `save` and
`sync_save` payloads are accepted as compatibility aliases. The response includes the
parent run id, child run ids, synced count, and fetched count.

Requires `workflows:run`.

```http
POST /api/workflow-runs/remote-popular
```

Runs the built-in popular remote collection workflow for a configured
compatible source. The workflow discovers popular works from the source API and
then either tracks them or fetches them into the local library.

```json
{
  "action": "track",
  "sourceId": 1,
  "limit": 100
}
```

`action` may be `track` or `fetch`. `sourceId` is optional; when omitted, the
highest-priority enabled compatible source is used. `limit` defaults to 100 and
is capped at 100.

Requires `workflows:run`.

## Error Shape

Errors are JSON objects with an `error` field:

```json
{
  "error": "message"
}
```
