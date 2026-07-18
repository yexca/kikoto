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

Store each release note at `docs/history/<tag>.md`, for example
`docs/history/v0.2.0.md`. The release workflow derives this path from the tag,
requires the file to exist, and uses it as the GitHub Release body. Rerunning a
release also synchronizes the existing Release body with the tracked file. The
file starts directly with the release body and does not repeat the tag as a
level-one heading; the filename and GitHub Release title already identify the
version.

## Version Source

`VERSION` is the single source for the application semantic version and uses
the `v<major>.<minor>.<patch>` format. Vite reads it directly, release builds
inject it into the Go backend, and Android derives `versionName` from it.
Android derives its default monotonic `versionCode` as
`major * 1,000,000 + minor * 1,000 + patch`.

The release tag must exactly match `VERSION` and point to a commit pushed to
`main`. The release commit and tag may be pushed together: the release workflow
waits up to 30 minutes for that commit's `main` CI run to appear and complete
successfully before publishing images or APKs. A failed, cancelled, or timed-out
CI run stops the release; the release workflow does not create a replacement CI
run.
