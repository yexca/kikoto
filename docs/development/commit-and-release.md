# Commit And Release

## Commit Format

Use:

```text
<type>(scope): <description>
```

Examples:

```text
feat(sources): add source health gate
fix(player): restore progress seek
docs(readme): reorganize public docs
```

## Release Notes

Release notes should group changes by user-facing area:

- Library and work detail.
- Sources and remote fetch.
- Metadata and scans.
- Playback.
- Operations and reliability.
- Development and docs.

## Version Source

`VERSION` is the single source for the application semantic version and uses
the `v<major>.<minor>.<patch>` format. Vite reads it directly, release builds
inject it into the Go backend, and Android derives `versionName` from it.
Android derives its default monotonic `versionCode` as
`major * 1,000,000 + minor * 1,000 + patch`.

The release tag must exactly match `VERSION`. Push the release commit to
`main`, wait for CI to succeed, and only then create the version tag. The
release workflow verifies that the tagged commit has a successful `main` CI
run before publishing images or APKs.
