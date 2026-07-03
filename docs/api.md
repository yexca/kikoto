# API Reference

The backend listens on port `7659` in the default Docker stack.

## Health

```http
GET /health
```

Returns service health.

## Works

```http
GET /api/works
```

Returns the current library work list with metadata, availability counts, cover URL, and DLsite URL when available.

```http
GET /api/works/{id}
```

Returns work detail, including metadata and media items with file locations.

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

## File Sources

```http
GET /api/file-sources
```

Returns configured file sources.

## Workflows

```http
GET /api/workflow-runs
```

Returns recent workflow runs.

```http
POST /api/workflow-runs/local-scan
```

Runs the local folder scan workflow.

```http
POST /api/workflow-runs/dlsite-sync
```

Runs DLsite metadata sync for detected works.

## Error Shape

Errors are JSON objects with an `error` field:

```json
{
  "error": "message"
}
```
