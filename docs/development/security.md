# Secure Development

Security changes must preserve Kikoto's product boundaries as well as prevent a
technical exploit. Read [Core boundaries](../architecture/core-boundaries.md),
the repository [Security Policy](../../SECURITY.md), and
[Runtime security](../operations/security.md) before changing authentication,
sources, media access, filesystems, or outbound networking.

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
  origin.
- When an untrusted hostname is allowed, validate all resolved addresses and
  connect to the same validated address to close DNS-rebinding time-of-check /
  time-of-use gaps.
- Bound connection and response time, metadata body size, media destination
  size, concurrency, and retry count. Stream large bodies instead of buffering
  them.
- Cancellation must release response bodies, files, and request-gate lanes.

Do not apply a blanket "block every private IP" rule: that would break the
intentional local-NAS use case. Model the explicitly configured private origin
separately from source-returned or redirected destinations.

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

## Filesystem Operations

- Resolve paths below the intended root and reject absolute paths, volume
  changes, traversal, and containment failures.
- Use `Lstat` or an equivalent no-follow check before destructive operations.
  A symlink or junction encountered during deletion requires a safe stop or a
  review flow, not recursive traversal.
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
  unless a specific job requires a later authenticated Git operation.
- Pin Docker build stages by tag and digest. Public-distribution Compose files
  may default to `latest` only when the release workflow updates that tag;
  document a reviewed version or digest for reproducible deployments. Treat a
  mutable tag as a convenience entry point, not the deployment trust anchor.
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
