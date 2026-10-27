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

## Merging Into main

A branch reaches `main` either as one squash commit or through a merge commit
that keeps its commits. Keep the commits only when they are worth reading,
reverting, or bisecting on their own:

- **Squash** when the branch is one logical change, or when its commits record
  how the work went rather than separate steps: work in progress, review
  fixes, fixups, reverts of the branch's own attempts, or commits that do not
  pass validation alone. A single-commit branch is squashed too. The squash
  commit uses the [commit format](#commit-format), describes the whole change,
  and summarizes its parts in the body.
- **Create a merge commit** when every commit on the branch is a
  self-contained step with its own message that passes validation alone, and
  the steps are useful apart, such as a refactor or migration followed by the
  behavior that depends on it, or independent fixes delivered together. The
  merge commit is `merge(<scope>): integrate <summary>` with a short body.

Decide by the branch as a whole. Catch-up merges from `main` and conflict
resolutions never justify keeping history; a squash folds them away. When only
some commits are separate steps and the rest cannot be folded into them first,
squash the branch.

Bring the branch up to date with `main` and validate it before either merge.
Locally, a squash is `git merge --squash <branch>` followed by a signed
`git commit`, and a merge commit is `git merge --no-ff <branch>`; on GitHub,
use **Squash and merge** or **Create a merge commit** by the same rule. A
squashed branch is not an ancestor of `main`, so confirm
`git diff main <branch>` is empty before deleting it with `git branch -D`.

## Release Notes

A release note shows its area titles and folds the changes under each one, so
a reader sees what the release touches before expanding any detail. Its parts
appear in this order:

1. Upgrade notes as GitHub alerts (`> [!IMPORTANT]`, `> [!NOTE]`,
   `> [!WARNING]`), when the release has any.
2. A short summary paragraph.
3. One folded block per user-facing area.
4. A `## Known Issue` section, when the release has one.

Only the area blocks are folded. Upgrade notes, the summary, and known issues
stay expanded because a reader must not miss them. Each area is a `<details>`
block whose summary is the area title, in place of a `##` heading:

```markdown
<details>
<summary><strong>Library and work detail</strong></summary>

- One change per bullet.

</details>
```

Keep the blank line after `<summary>` and the one before `</details>`; GitHub
renders the list as literal text without them.

Group changes by user-facing area. The usual areas are:

- Library and work detail.
- Sources and remote fetch.
- Metadata and scans.
- Playback.
- Operations and reliability.
- Development and docs.

Name an area after what the release changes when none of these fits.

`docs/history/unreleased.md` holds the pending changes in the same area blocks
under its heading. Add a pending change as a bullet in the block of its area,
and create the block when the area has none.

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
3. Move the area blocks of `docs/history/unreleased.md` into
   `docs/history/<tag>.md`, add the upgrade notes and summary above them as
   described in [Release Notes](#release-notes), leave `unreleased.md` with
   only its heading, and add the new page to the
   [history index](../history/index.md).
4. Run the validation targets, commit, and push the commit to `main`.
5. After `Full` succeeds for that commit, push the tag described in
   [Version Source](#version-source).

## Version Source

`VERSION` is the single source for the application semantic version and uses
the `v<major>.<minor>.<patch>` format. Vite reads it directly, release builds
inject it into the Go backend, Android derives `versionName` from it, and the
iOS build passes it without the `v` prefix as both bundle versions.
Android derives its default monotonic `versionCode` as
`major * 1,000,000 + minor * 1,000 + patch`.

The release tag must exactly match `VERSION` and point to a commit on `main`.
The `full` validation tier described in
[Continuous Integration](testing.md#continuous-integration) runs on that same
commit in `Full`, so the release workflow does not repeat it. Before building
images or app packages, the release workflow requires a successful `Full` run
for the tagged commit. Every build job depends on that check, so a commit whose
`Full` run failed, was cancelled, or has not finished stops the release before
publication work begins. Once `Full` succeeds, rerunning the failed jobs of the
release resumes it; start `Full` on the tag from the Actions page when the
commit has no run of its own.

## Publication Order

A release is published as one unit so users are never offered a version whose
image, APK, or IPA is missing:

1. The production image, the signed APK, and the unsigned IPA are built in
   parallel. The IPA uses `make ios-build` on a macOS runner and needs no Apple
   signing secrets; sideloading tools re-sign it at install time. The image is
   built for `linux/amd64` and `linux/arm64` without pushing, so no registry
   tag moves yet. Its build stages run natively and cross-compile; only the
   arm64 runtime stage runs under QEMU. Because the validation tiers exercise
   only the amd64 image, a native arm64 runner builds the arm64 image and runs
   `make production-smoke` against it in the same job.
2. After all builds succeed, the APK and IPA are attached to a draft GitHub
   Release.
3. The image is then pushed for both platforms to Docker Hub and GHCR under
   multi-platform tags for the full version, its `major.minor` series, and
   `latest`, reusing the build cache from step 1.
4. The draft is published last.

A failure in any build leaves registry tags, including `latest`, unchanged. The
in-app update check reads published GitHub Releases rather than tags, so pushing
a tag or holding a draft does not announce an update. Rerunning a failed
release resumes from the same order; an existing Release is updated in place.
