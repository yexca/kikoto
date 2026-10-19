# Secure Development

Security changes must preserve Kikoto's product boundaries as well as prevent a
technical exploit. Read [Core boundaries](../architecture/core-boundaries.md),
the repository [Security Policy](../../SECURITY.md), and
[Runtime security](../operations/security.md) before changing authentication,
sources, media access, filesystems, or outbound networking.

This document is for contributors changing the codebase. Operators should use
[Runtime security](../operations/security.md), and vulnerability reporters
should use the repository [Security Policy](../../SECURITY.md).

## Trust Boundaries

- Production requires authentication by default. Anonymous Library browsing and
  playback are intentional only while a super administrator has enabled the
  instance setting; do not describe that configured read access as an
  authorization bypass.
- Personal state, administrative configuration, and mutations require the
  appropriate authenticated permission.
- Development mode is trusted-local only. Demo mode is a separate, fail-closed
  read-only showcase with isolated runtime data.
- `/config`, `/data`, and `/cache` are trusted operator mounts, but paths derived
  from API input, metadata, remote sources, or workflow state remain untrusted.
- An administrator-configured remote endpoint may intentionally be private.
  URLs and redirects returned by that endpoint do not automatically inherit the
  same trust.

## Outbound HTTP

Every new direct outbound request path must document its allowed destination
boundary and include tests for it.

- Accept only HTTP(S) and reject embedded URL credentials.
- Give source-returned URLs an explicit policy: configured origins only,
  configured origins plus a reviewable host allowlist, or the declared
  public-host compatibility mode. An unconfigured destination must never
  inherit the configured origin's private-address exception.
- Reject redirects by default. When redirects are required, apply the complete
  URL, origin, DNS, and address checks again at every hop.
- Never forward authorization, cookies, or proxy authorization to a different
  origin. Once a redirect changes origin, keep them removed for the rest of
  the chain; the HTTP client may otherwise restore initial headers.
- When an untrusted hostname is allowed, validate all resolved addresses and
  connect to the same validated address to close DNS-rebinding time-of-check /
  time-of-use gaps.
- Preserve these checks when a proxy is configured. Resolve locally and send
  only the validated numeric destination through CONNECT or SOCKS, retaining
  the original HTTP Host and HTTPS certificate verification. A proxy's private
  endpoint exception grants no additional destination permission.
- Bound connection and response time, metadata body size, media destination
  size, concurrency, and retry count. Stream large bodies instead of buffering
  them.
- Cancellation must release response bodies, files, and request-gate lanes.

Do not apply a blanket "block every private IP" rule: that would break the
intentional local-NAS use case. Model the explicitly configured private origin
separately from source-returned or redirected destinations.

### Kikoeru account import

`POST /api/user-data/kikoeru/account` sends a user's Kikoeru token or password
to one destination and reads that user's reviews and playlists:

- The destination is either a configured Kikoeru-compatible source's API URL,
  which keeps the operator's private-address exception, or a URL the user
  enters. A user-entered URL is untrusted: it may resolve to a private or
  reserved address only for accounts with `sources:write` or when the
  administrator enables `kikoeru_import_private_addresses`.
- The policy allows only that origin, and the account client refuses every
  redirect, so the login body and bearer token cannot reach another origin.
- Credentials, a manual URL, or a database upload require an explicit risk
  acknowledgement in the request. Credentials are held only for the request and
  never persisted or logged; the page and API report only sanitized error
  classes, and an upstream 401 becomes 422 so it cannot end the Kikoto session.
- Each response is limited to 8 MiB, each request to 30 seconds, the whole read
  to 3 minutes, and page and item counts to the transfer limits. At most two
  account or database reads run at once.

### Remote metadata fallback

Explicit detail-editor refreshes and Fetch for edit previews from a selected
source use this same transport and persistence boundary, bypass cached
descriptions, and require `metadata:sync`. They validate the source's enabled
state and declared metadata capability at submission and execution. A preview
keeps the bounded validated response privately for a short period and writes
only when the user applies it; no file presence, media location, or catalog
crawl is created by the preview.

Metadata sync run and trigger options can select that same source for existing
works. Codes are validated, normalized and limited to 100 for explicit lists;
fallback orders are limited to 16 enabled, capable sources. Submission and
execution validate capability, and the single executor requests one work at a
time through the same bounded transport. Source selection, fallback order and
bonus detection are persisted with the run and retained by retries. The run
does not mutate the legacy stored projection policy or file availability.

The opt-in fallback asks administrator-configured remote sources for one work
after DLsite reports it as not found:

- The destination is the source's configured API origin. Redirects are followed
  only between the source's configured origins (API, public site, fallback);
  the shared source policy validates every hop, pins the validated address,
  strips credentials on an origin change, and keeps the configured private-origin
  exception for those origins only. A cover URL from the response goes through
  the existing remote cover path, so an unconfigured private origin is refused.
- Each source gets one `workInfo` request with a 30-second bound and a 2 MiB
  response limit, through the paced crawl lane; cancellation releases the lane
  and records no outcome. Retryable DLsite failures never trigger a request.
- The response is untrusted. It must decode within the remote snapshot bounds
  and name the requested code; nothing is applied otherwise. Each edition
  collection is limited to 32 entries, and sibling titles to 2048 bytes.
  Edition codes and declared languages supply metadata references only; a
  source-local id or relationship without a title creates no work or request.
- Run output, Activity, and the API expose source codes, display names and
  fixed outcomes only. Detailed upstream errors stay in protected logs.

### Lyrics files

`POST /api/works/{id}/lyrics-edit/plan` previews and
`POST /api/works/{id}/lyrics-edit` applies an edit of the lyrics Kikoto
manages in one local work folder: lyrics files of that folder are copied into a
language's lyrics folder, or moved there when the request's `folderMode` or,
without one, the administrator's `lyrics_folder_files_mode` setting says
`move` (managed lyrics that change language always move), files of another local folder of the family are
copied there, files a configured compatible source offers for a family
edition are downloaded there, and managed lyrics are deleted. Both require
`downloads:manage`; applying also requires `library:write` when the request
assigns tracks. The preview never changes a file.

- The target must be an active local folder of the requested work on an
  online storage pool. A local source must be another active local folder of
  the same family, and a remote code must be an edition of the family. The
  edition's tree is read through the remote snapshot cache; it is not stored
  as a work, presence, or media location.
- Every path is resolved below its folder or in the edition's tree, and every
  path component of a local file must be a regular directory or file, so a
  link inside a folder cannot read or move a file from outside it. A source
  folder is not changed.
- Each added file must be a `.lrc`, `.vtt`, `.srt`, `.ass`, `.ssa`, or `.txt`
  file and declares its language, one of the languages a lyrics assignment
  accepts or the empty language for every language; a language is never
  inferred. The language selects the folder inside `lyrics_kikoto`: `ja`,
  `en`, `zh-hans`, `zh-hant`, `ko`, or `fallback` for every language. The
  names carry no work code, so a scan never takes a folder for a work of its
  own. A file keeps its path below its source, without the language's lyrics
  folder it may already be in.
- Kikoto writes only into a `lyrics_kikoto` folder it created and marked with
  `.kikoto-lyrics`. An unmarked folder of that name, a name that differs only
  in case, or a file in its place refuses the edit with
  `lyrics_folder_blocked` and changes nothing, so a folder a work ships is
  never filled, emptied or reorganized as managed lyrics.
- A file to delete must be a lyrics file in a language's lyrics folder of the
  target's marked `lyrics_kikoto` folder. Deletion runs the media cleanup
  checks, including the symbolic-link review, when the edit is applied.
- A remote file's source-returned URL must be HTTP(S) without credentials and
  pass the source's outbound policy before any request; redirects are validated
  at every hop by the shared source transport, and only configured origins keep
  the private-address exception. Downloads use the source's download lane with
  a 30-second bound per file and at most 200 downloads per request.
- A request names at most 2,000 added and 2,000 deleted files. A copied or
  downloaded file is at most 2 MiB, the files collected for one request at
  most 128 MiB, and a request is bounded by 2 minutes. Copies and downloads
  are staged in `.kikoto-staging` on the target's pool before the folder
  changes; a moved file moves by renames on that filesystem.
- A file already at a target is a conflict the request must decide: keep the
  existing file, replace it, keep both under a free name, or rename the
  incoming file inside its lyrics folder. A file with the same content is left
  alone, and a target that the same request deletes is replaced. An apply
  whose plan still has a conflict, or whose target changed after the plan,
  changes nothing and answers `409`.
- A failure while moving files puts the moved files that did not reach their
  target back where they were. An edit that has started completes when the
  client disconnects, bounded by the 2-minute request limit, and the work
  folder is rescanned even when the edit stopped partway, so the folder and its
  index agree. Directories the edit emptied are removed.
- Errors expose fixed messages only. Upstream URLs, local paths, and detailed
  failures stay in protected logs.

### Speech transcription

Speech recognition requests go only to the administrator-configured service
origin, with its private-address exception, through the shared outbound
transport and the `other` proxy route.

LLM and ASR configuration requires an accepted external service notice. The
server refuses provider, service and policy saves and model discovery until
an administrator accepts it, so the notice does not depend on the client.

- A same-machine local deployment derives its host from the server's host
  gateway and stores only a port; an address in the request body is
  discarded. Other origins must be HTTP(S) without credentials, a path, or a
  query.
- Every redirect is refused, and the key is sent only as a bearer token to the
  configured origin.
- A Kikoto Helper rejection is read up to 64 KiB only for its error code,
  which maps to a fixed failure code; the helper's message is never shown.
  LLM translation requests to a helper follow the same rule.
- Model discovery has a 20-second bound. A chunk request has a 30-minute
  bound, which also bounds the wait for response headers, because a service
  answers only once the chunk is transcribed. Responses are buffered to at
  most 4 MiB; a declared or streamed larger body is refused.
- Uploads are bounded by construction: at most five minutes of 16 kHz mono
  16-bit PCM per request, decoded by ffmpeg from a local, available audio
  location with a 2-minute bound and a byte limit on its output. Tracks longer
  than 12 hours are refused.
- Audio is sent only for a work the LLM content policy allows for that
  service, using the shared `contentpolicy` assessment and receive maximum
  independently of the declared data boundary. Unknown and blocked works are
  refused; audio classification uses metadata without inspecting audio bytes. The policy, the service
  configuration, the requester's permissions and the audio file version are
  rechecked before every chunk.
- Publication stages the file in `.kikoto-staging` on the work folder's
  storage pool and renames it into the language's lyrics folder through plain
  directories, inside a `lyrics_kikoto` folder Kikoto created and marked; an
  unmarked one is refused with `lyrics_folder_blocked`. It never replaces a
  file: a different file under the track's name moves the transcription to a
  numbered name.
- Activity and API errors expose fixed failure codes only; upstream errors,
  endpoints and paths stay in protected logs.

### Folder edit

`POST /api/works/{id}/folder-edit/plan`,
`POST /api/works/{id}/folder-edit/merge-check`, and
`POST /api/works/{id}/folder-edit` change one active local folder of a work.
All three require `downloads:manage`,
plus `remote:fetch` when the request names a remote file; apply also requires
`library:write` when it assigns lyrics to tracks. A Fetch that carries a
follow-up requires `downloads:manage` on top of the Fetch permissions, plus
`library:write` when the follow-up assigns lyrics, and names at least one file
of the edition, since an empty selection fetches every file. Its follow-up is
planned against the folder the Fetch publishes before the Fetch is queued, is
refused while another Fetch of the work runs, and later runs as a folder edit
of that folder under every rule below.
`POST /api/works/{id}/folder-edit/sources/check` requires `downloads:manage`
and `remote:track`. It contacts only configured sources, through the shared
remote-source transport, asks only about editions of the requested work's
family, and stops before the next edition when the request is cancelled.

- The target must be an active local folder of the requested work on an online
  storage pool. A local source must be another active local folder of the same
  family. Each requested path is resolved below it, and every path component
  must be a regular directory or file, so a link inside the folder cannot read
  from outside it. The source folder is not changed. The run checks the
  target's pool again before it indexes the folder, so an unmounted pool never
  marks the folder's files missing.
- A remote code must be an edition of the requested work's family, and its
  source an enabled compatible source. The edition's tree is read through the
  remote snapshot cache; it is not stored as a work, presence, or media
  location. Each requested path must be a file of that tree.
- A removed file must be a local location of the requested work inside the
  target folder. Applying the edit runs the destructive-path checks of media
  cleanup, including the symbolic-link review, and records the file's size and
  modification time on disk; the run deletes it only while it is still that
  version.
- An addition with a declared language must be a lyrics text file of at most
  2 MiB. It lands in the language's folder inside a `lyrics_kikoto` folder
  Kikoto created and marked; an unmarked one is refused with
  `lyrics_folder_blocked`, and a renamed lyrics file stays in its language's
  folder. An assignment names an added lyrics file of the plan and an audio
  media item of the work or an audio path below the folder, at most once per
  audio file and language.
- Target paths stay inside the target folder. A target that exists is kept
  when it has the same size and is otherwise a conflict, which apply rejects
  until a decision resolves it. Two files of the result never share a path,
  compared without letter case or Unicode composition. A removed or moved file
  frees only its own path, decided by file identity on disk, so a different
  file whose path differs only in letter case or composition is never taken
  for it. The run publishes and moves files with a rename that refuses an
  existing target where the filesystem supports one, and replaces an existing
  file only where a decision chose to and while it has the size the plan saw. A moved file must be a
  local location of the requested work inside the target folder, lands only on
  a path that is free or that the edit frees, and neither leaves nor enters
  `lyrics_kikoto`; neither does a created folder or a placed addition. At most
  1000 folders are created at once.
- A merged folder must be another active local folder of the family, neither
  inside the target folder nor holding it, that passes the destructive-path
  checks and holds only plain folders and regular files, at most 20000. Its
  storage pool must be online both when the edit is planned and when the run
  deletes it, as for every
  [library file change](../architecture/workflows.md#library-layout-and-onboarding).
  Apply requires the review of a complete merge check of the same files and
  refuses the edit when they changed since. The review carries the files the
  check reported lost, and apply compares again: a merged file now without a
  copy that the review did not report lost, such as one that can no longer be
  read, refuses the edit. Metadata a NAS or operating system keeps beside files
  (`@eaDir`, `__MACOSX`, `._` files, `.DS_Store`, `Thumbs.db`) is not part
  of the review and is deleted with the folder, under the same link and
  special-file refusal. The plan records the files with
  their sizes and modification times and the files the review reported lost,
  and the run deletes the folder only after the target folder is indexed, only
  while it holds exactly those files, unchanged, and only while each file not
  reported lost still has a copy of the same size and SHA-256 in the target
  folder. The run claims the folder before deleting, so another cleanup or edit
  cannot change it meanwhile, and returns it to the work when the run fails or
  is cancelled. Each deleted file's location turns unavailable with its
  deletion, and a resumed run counts a folder an earlier attempt already
  deleted and recorded as gone as merged. The merge check only reads and hashes files below the merged
  folders and the target folder.
- The job resolves each download address again from the source's tree when it
  runs; the plan response and the stored job carry none. The address must be
  HTTP(S) without credentials and pass the source's outbound policy before any
  request; redirects are validated at every hop by the shared source
  transport, and only configured origins keep the private-address exception.
- Downloads stream through the source's download lane into the run's
  `.kikoto-staging` directory on the target's pool, bounded by the remote
  download limit and the size the listing declares. Like Fetch staging
  cleanup, the run refuses a staging path with a link or reparse point from
  the data root down, so neither staging nor its removal leaves the pool. One
  request adds at most
  5000 files. A file whose size differs from its listing fails the run before
  anything in the folder changes.
- Publication renames each collected file into the folder through plain
  directories, and lands on an existing file only when the plan decided to
  replace it. A cancelled or failed run removes its staging directory; a
  failure that is retried automatically keeps what it collected.
- Responses expose request errors only. Upstream URLs and detailed failures
  stay in protected logs and Activity.

### Remote text preview

`GET /api/media/{id}/text` reads a text file from where the location's bytes
are: a local file from the library, a cached copy from the cache, and a
`remote_stream` location from the URL its source listed for it.
`GET /api/remote-sources/{id}/works/{code}/text` reads a file of the source's
current tree the same way.

- The source must be enabled and compatible. The listed URL is untrusted: it
  must be HTTP(S) without credentials and pass the source's outbound policy
  before any request, and the shared source transport validates every redirect
  hop. A URL outside the source's configured origins is refused without a
  request.
- A read has a 20-second bound and a 512 KiB limit; local and cached files
  share the size limit.
- Both endpoints accept the same files: one the source lists as text, or one
  with a `.txt`, `.md`, `.json`, `.lrc`, `.cue`, `.srt`, `.vtt`, `.ass`, `.ssa`,
  `.csv`, `.log`, `.ini`, `.yaml`, or `.yml` extension.
- Errors expose fixed messages only. Upstream URLs and local paths stay in
  protected logs.

### Remote image proxy

`GET /api/remote-sources/{id}/images/{token}` serves a cover or image file a
remote source returned, for viewers who may not see source addresses (see
[Remote source addresses](#remote-source-addresses)):

- The token is the source-returned URL sealed with AES-GCM under a key that
  exists only in the running process and is bound to the source id. The server
  issues tokens only for URLs it already returned in the same response shape;
  a modified token, a token for another source, or a token from before a
  restart is answered with 404 and makes no request.
- The decrypted URL must be HTTP(S) without credentials and pass the source's
  outbound policy before any request. The shared source transport validates
  every redirect hop, pins the validated address, and keeps the private-address
  exception for the source's configured origins only.
- Each request is bounded to 30 seconds and to the 20 MiB cover limit; a
  declared larger body is refused before reading, and streaming stops at the
  limit. Only JPEG, PNG, and WebP identified from the first bytes are served,
  with `nosniff`, a sandbox CSP, and a private cache lifetime.
- Errors are fixed codes and messages. Upstream errors stay in protected logs.

### Purchase bonus detection

Metadata sync may look up a purchase bonus's parent product (see
[workflows](../architecture/workflows.md#purchase-bonus-detection)):

- Requests use the built-in DLsite metadata client and its shared outbound
  transport: the maker profile pages and `product.json` on the configured DLsite
  origin, never a URL taken from a response.
- The maker id and candidate codes come from DLsite responses and are
  untrusted. The maker id must be two letters and digits and is path-escaped;
  candidate codes must match the work-code pattern and the bonus's prefix.
- Each bonus reads at most 10 profile pages, without series catalogs, and at
  most 5 candidate products, through the syncer's request pacing, retries and
  the client's response limits. A linked bonus adds one parent request per sync.
- Candidate and parent products are scored or merged in memory and never
  stored as works, editions or aliases. A failed lookup records nothing and
  keeps detailed errors in protected logs; job output names only the detected
  parent code.

`POST /api/user-data/kikoeru/database` streams an uploaded Kikoeru SQLite file,
up to 512 MiB, to a temporary file that is deleted when the request ends. The
upload is read under its own 15-minute deadline in place of the server's
request read timeout. The
file is opened read-only and immutable with `trusted_schema` off, only the base
`t_review` table is queried (a view of that name is rejected), and text length
and row count are bounded. The user table's password hashes are never read.

## Authentication and Mutations

- Enforce permissions in the backend; a hidden or disabled frontend control is
  not authorization.
- Treat cookies and bearer sessions as credentials. Do not place them in URLs,
  logs, workflow payloads, or public diagnostics.
- Retry a mutation only when it is idempotent or carries a durable idempotency
  key. A generic client retry layer must not duplicate Fetch, cleanup, account,
  or workflow actions.
- Demo mode must reject state-changing methods before a handler can perform a
  write. Add an explicit Demo regression test for every new mutation surface.
- Check capabilities, never role names. `remote:track` guards every path that
  adds a remote work to the shared Library or removes a tracked source,
  including a sync for a mark or list and a work-level cache request;
  `remote:fetch` guards every path that makes the server download remote files;
  Fetch workflows additionally require `metadata:sync` because preparation may
  refresh and materialize DLsite family metadata. A new handler or background
  path that tracks, caches, or fetches on behalf of a user must check the same
  capability set.

## Remote Source Addresses

An administrator-configured endpoint can be a private address that other
accounts should not learn. While `hide_remote_source_addresses` is on (the
default), a request from an account without `sources:write`, or from an
anonymous reader, must not receive anything from which a source's address can
be inferred:

- Configured API, site, and fallback URLs, and work pages built from them.
- Source-returned cover, stream, and download URLs; serve them through the
  [remote image proxy](#remote-image-proxy), the playback and text routes, or
  `/api/media/{id}/stream` instead of omitting the feature.
- Fetch plan source URLs and upstream `source_url` values on presence records.
- Stored workflow run summaries, node input, output, and errors, events,
  candidates, trigger errors, and notifications. These are redacted at read
  time: URLs with a scheme, IPv4 and bracketed IPv6 addresses, and every
  configured source host name are replaced.

Source display names, codes, and types are not addresses. Demo serves only
synthetic sources and keeps its responses unchanged. A new response field that
carries a remote URL must apply the same rule.

## Filesystem Operations

Serve untrusted library files with an explicit passive inline type or as an
attachment with `nosniff` and a sandbox CSP. Do not infer safe content from an
extension or expose HTML/SVG on the authenticated application origin. Media
subprocesses must restrict their protocol whitelist to `file,pipe` so playlists
cannot create an unchecked outbound path.

- Resolve paths below the intended root and reject absolute paths, volume
  changes, traversal, and containment failures.
- Use `Lstat` or an equivalent no-follow check before destructive operations.
  A symlink or junction encountered during deletion requires a safe stop or a
  review flow, not recursive traversal.
- Creating a custom work renames only a folder the server's own candidate walk
  returned for that request, never a client-supplied path as given. The walk
  stays below the data root in online pools, does not follow links, and the
  rename stays inside the folder's parent. It never replaces an existing
  target: on Linux, macOS, and Windows the rename itself refuses one, and
  elsewhere a check precedes it. The rename holds the `media:cleanup`
  resource, which every running job with that resource, every local scan, and
  every Fetch publication hold too, and the server refuses a configured Fetch
  root, a folder inside or holding one, and a folder an active Fetch or Edit
  files run writes into or merges away. The server refuses creation until an
  administrator accepts the rename notice.
- Keep Fetch staging, rollback backup, and reviewable trash on `/data` so
  publication and rollback use same-filesystem rename semantics.
- Keep `/cache` disposable. It must not become the only owner of a transaction,
  review decision, or user-authored media.
- Bound archive extraction, media probing, transcoding, and file-copy resource
  use.

## Errors, Logs, and Diagnostics

Public API errors use a stable code, a retryability decision, and a short
sanitized message. Detailed errors may be logged or recorded in protected
Activity only when operationally useful.

Before emitting or exporting a value, consider whether it contains:

- A private endpoint or URL query.
- A credential, cookie, or bearer token.
- A host or container path.
- A work identifier or title from a private collection.
- Raw upstream response content.

UI recovery should preserve known local state and the global player. Use an
inline retry state for a blocked task; use a toast for a transient event. A
render error fallback must not display a raw stack or server error to an
anonymous user.

## Dependency and Build Integrity

- Use `npm ci --strict-allow-scripts` for normal installs. Review every new
  install script and record the exact approved package version in
  `package.json#allowScripts`; record optional scripts that are not needed as
  explicit `false` entries. Run both `npm audit --audit-level=moderate` and
  `npm audit signatures` after changing the lockfile.
- Keep the Go patch version aligned across `go.mod`, CI, Make, and Docker.
  After a module update, run `go mod tidy`, `go mod verify`, the backend test
  suite, and `govulncheck ./...`.
- Gradle wrapper distributions require an official
  `distributionSha256Sum`. Android dependency changes also require an
  intentional update of `gradle/verification-metadata.xml`; review every new
  component and checksum before accepting the generated diff.
- Pin third-party GitHub Actions to full commit SHAs and retain the release tag
  as a comment for readability. Checkout steps must not persist credentials
  unless a specific job requires a later authenticated Git operation. Set up
  Node, Go, and the Android toolchain through the composite actions under
  `.github/actions` so each third-party setup action is pinned in one file.
- Pin Docker build stages by tag and digest. Public-distribution Compose files
  may default to `latest` only when the release workflow updates that tag;
  document a reviewed version or digest for reproducible deployments. Treat a
  mutable tag as a convenience entry point, not the deployment trust anchor.
- Do not pin exact Debian package versions in `apt-get install`. The Debian
  archive serves only the current version of each package per suite, so an
  exact pin either breaks the build once that version is superseded or keeps
  resolving an older copy and silently skips security updates. The
  digest-pinned base image fixes the release; the release workflow's SBOM
  records the exact package versions in each published image.
- Dependabot (`.github/dependabot.yml`) proposes weekly updates for GitHub
  Actions in workflows and composite actions, the runtime base image digest,
  Go modules, and frontend npm packages. Action, Go module, and npm version updates wait seven days after
  a release; security updates are not delayed. Review its pull requests like
  any other dependency change, including the install-script and audit steps
  above. It deliberately skips the Go and Node toolchain versions, which must
  be upgraded by hand everywhere they appear, and Gradle dependencies, which
  need a reviewed verification-metadata update.
- Do not add a JAR or AAR to a Capacitor `flatDir` directory without an
  explicit source review and checksum. Those directories do not carry normal
  repository metadata or transitive dependency information.

## Public Fixtures and Documentation

- Use reserved domains such as `example.invalid` and documentation address
  ranges.
- Use generic names such as `Example Remote` and identifiers that are obviously
  synthetic. Never copy a configured source, work record, log, database, or
  personal filesystem path into a fixture.
- A plausible catalog number is not synthetic merely because it was chosen for
  a test. Use the repository-reserved identities in
  [Synthetic Fixture Data](testing.md#synthetic-fixture-data).
- Keep secrets in local environment or mounted configuration. Do not commit an
  `.env` file with real values.
- Do not treat `.gitignore` as a secrecy boundary. Keep deployment credentials
  and private service details in an access-controlled system outside the
  repository workspace whenever possible.
- Review added lines and staged content with a tracked-file privacy scan before
  committing.

## Review Checklist

For a security-relevant change, record:

1. The assets and trust boundary affected.
2. The allowed and denied actor or destination.
3. The failure behavior and whether it fails closed.
4. The smallest regression tests for the boundary.
5. Any operator mitigation that remains necessary.
6. Whether [SECURITY.md](../../SECURITY.md), runtime hardening, or privacy
   documentation must change.

Do not publish exploit details for an undisclosed vulnerability in a normal
issue or pull request. Use GitHub Private Vulnerability Reporting as described
in the Security Policy.

## Related Documentation

- [Backend guidelines](backend-guidelines.md)
- [Frontend guidelines](frontend-guidelines.md)
- [Testing](testing.md)
- [Privacy and data handling](../../PRIVACY.md)
