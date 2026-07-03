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

## Works

```http
GET /api/works
```

Returns the current library work list with metadata, availability counts, cover URL, and DLsite URL when available.

Requires `library:read`.

```http
GET /api/works/{id}
```

Returns work detail, including metadata and media items with file locations.

Requires `library:read`.

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

## File Sources

```http
GET /api/file-sources
```

Returns configured file sources.

Requires `sources:write`.

## Workflows

```http
GET /api/workflow-runs
```

Returns recent workflow runs.

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

## Error Shape

Errors are JSON objects with an `error` field:

```json
{
  "error": "message"
}
```
