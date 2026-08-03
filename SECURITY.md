# Security Policy

Kikoto is a local-first personal audio library and media server. This policy
describes which versions receive security fixes and how to report a
vulnerability privately.

Deployment and runtime hardening guidance is documented in
[docs/operations/security.md](docs/operations/security.md).

## Supported Versions

Security fixes target the latest tagged release.

| Version | Support |
| --- | --- |
| Latest tagged release matching [VERSION](VERSION) | Supported |
| `main` after the latest release | Reports accepted; development code |
| Older releases and unofficial builds | Not supported |

Please reproduce an issue against the latest release or current `main` when
practical.

## Security Model

Kikoto has several intentional trust boundaries:

- In production mode, anonymous users may browse library metadata and play
  media exposed by the instance. Unauthorized mutation, access to another
  user's private state, privilege escalation, or access outside the configured
  media roots is not intended.
- Development mode authenticates requests as the configured root user. It must
  not be exposed to untrusted networks.
- Demo mode intentionally exposes read-only showcase surfaces, including
  sanitized administration and workflow views. It must reject state-changing
  requests and must not expose media that fails the Demo content policy.
- Administrators are trusted to configure remote source endpoints. Requests
  caused by untrusted input or redirects that escape the configured source
  trust boundary remain security-relevant.
- The configured `/config`, `/data`, and `/cache` mounts are trusted local
  inputs. Path traversal or unintended filesystem access caused through the
  API, metadata, remote sources, or workflows is in scope.

## Reporting a Vulnerability

Do not open a public issue, discussion, or pull request for an undisclosed
vulnerability.

Use [GitHub Private Vulnerability Reporting](https://github.com/yexca/kikoto/security/advisories/new).

Include:

- The affected version, commit, image digest, or Android version.
- The runtime mode and relevant deployment topology.
- The required account role or other prerequisites.
- Minimal reproduction steps using synthetic data.
- The expected and actual behavior.
- The security impact and any suggested mitigation.

Do not attach real SQLite databases, passwords, session tokens, private source
URLs, personal media paths, or media files. Redact logs and workflow records
before submitting them.

## Examples of In-Scope Reports

- Authentication, session, RBAC, or cross-user authorization bypasses.
- Anonymous or Demo users performing unauthorized mutations.
- Demo content-policy bypasses.
- Path traversal, unsafe filesystem publication, or deletion outside configured
  roots.
- Server-side request forgery outside the configured remote-source boundary.
- Credential, session, private endpoint, or local-path disclosure.
- Cross-site scripting, command injection, or unsafe metadata/media handling.
- Compromise of official release artifacts or the release process.

## Generally Out of Scope

- Intended anonymous read-only library and playback access.
- Exposing development mode to an untrusted network.
- Traffic interception when an operator deliberately deploys over cleartext
  HTTP without a trusted VPN or reverse proxy.
- Issues requiring prior control of the host, SQLite database, or runtime
  mounts without crossing an additional Kikoto boundary.
- Vulnerabilities that exist only in third-party services and do not arise from
  Kikoto's integration.
- Social engineering, physical attacks, denial-of-service testing, or automated
  scanner output without a demonstrated security impact.

## Response and Disclosure

We aim to acknowledge a report within five business days and provide an
initial assessment within ten business days. Remediation time depends on
severity and complexity.

Please allow coordinated remediation before public disclosure. When
appropriate, the fix, release notes, and GitHub security advisory will be
published together. Reporter credit is offered unless anonymity is requested.

## Safe Harbor

Research conducted consistently with this policy is considered authorized, and
the project maintainers will not initiate legal action against it.

Good-faith research is welcome when it:

- Uses accounts, instances, and data you own or are authorized to test.
- Stops after obtaining the minimum evidence needed.
- Avoids privacy violations, persistence, data destruction, service
  degradation, and third-party systems.
- Keeps the issue private during coordinated remediation.

Kikoto does not currently operate a paid bug-bounty program.
