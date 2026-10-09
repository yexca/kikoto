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

## Release Steps

1. Set `VERSION` to the release tag.
2. From `backend/`, run the baseline generator in release mode:

   ```sh
   go run ./cmd/schema-baseline -migrations ./migrations -version-file ../VERSION -release
   ```

   It writes `migrations/baseline/<schema>_<VERSION>.sql` when the numbered
   chain is newer than the highest released baseline and deletes every
   development baseline in `migrations/compat/`. Update the
   [Release To Schema Map](migrations.md#release-to-schema-map) and the
   accepted-ledger table in the same change.
3. Move the content of `docs/history/unreleased.md` into
   `docs/history/<tag>.md`, leave `unreleased.md` with only its heading, and
   add the new page to the [history index](../history/index.md).
4. Run the validation targets, commit, and push the tag described in
   [Version Source](#version-source).

## Version Source

`VERSION` is the single source for the application semantic version and uses
the `v<major>.<minor>.<patch>` format. Vite reads it directly, release builds
inject it into the Go backend, Android derives `versionName` from it, and the
iOS build passes it without the `v` prefix as both bundle versions.
Android derives its default monotonic `versionCode` as
`major * 1,000,000 + minor * 1,000 + patch`.

The release tag must exactly match `VERSION` and point to a commit pushed to
`main`. Before publishing images or app packages, the release workflow looks up
the ordinary `CI` workflow run for that exact commit on `main`. If that run is
still in progress, release waits for it; a successful conclusion permits the
release builds, while a failed, cancelled, or timed-out run stops the release
before publication work begins. This reuses the commit's existing CI result
instead of running the full validation suite a second time.

## Publication Order

A release is published as one unit so users are never offered a version whose
image, APK, or IPA is missing:

1. The production image, the signed APK, and the unsigned IPA are built in
   parallel. The IPA uses `make ios-build` on a macOS runner and needs no Apple
   signing secrets; sideloading tools re-sign it at install time. The image is
   built without pushing, so no registry tag moves yet.
2. After all builds succeed, the APK and IPA are attached to a draft GitHub
   Release.
3. The image is then pushed with its version tags and `latest`, reusing the
   build cache from step 1.
4. The draft is published last.

A failure in any build leaves registry tags, including `latest`, unchanged. The
in-app update check reads published GitHub Releases rather than tags, so pushing
a tag or holding a draft does not announce an update. Rerunning a failed
release resumes from the same order; an existing Release is updated in place.
