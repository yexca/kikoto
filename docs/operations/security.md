# Security

Kikoto is a personal media server that requires sign-in by default. A super
administrator can deliberately expose read-only Library browsing and playback
to anonymous clients. Authentication always protects personal state,
configuration, and mutating operations; once anonymous access is enabled, it no
longer makes the complete Library or its media private. Use network access
controls when an instance must be private.

For privately reporting a vulnerability, see the repository
[Security Policy](../../SECURITY.md).

## Network Exposure

The default Compose mapping publishes port `7655` on every host interface. If
the instance should be reachable only from the Docker host, bind it explicitly:

```yaml
ports:
  - "127.0.0.1:7655:7659"
```

For LAN or remote use, restrict access with a host firewall, trusted VPN, or
authenticated reverse proxy. CORS controls browser origins; it is not a network
firewall or an authentication mechanism for non-browser clients.

## Runtime Modes

- `production` uses normal session authentication, requires an explicit
  non-default `KIKOTO_ROOT_PASSWORD`, and starts with anonymous access disabled.
- `development` authenticates every request as the configured root user. Use it
  only on a trusted local development machine.
- `demo` is an isolated read-only showcase. It exposes sanitized read surfaces,
  rejects non-read HTTP methods, and filters local content to verified all-ages,
  permanently free works. Never reuse production config, cache, or data
  directories for a public Demo.

The Demo container has a read-only root filesystem and data mount. Its isolated
`/config` and `/cache` mounts remain writable for SQLite state and accepted
cover assets, so they must contain only sanitized Demo data.

## Authentication and Cookies

Use a long, unique root password. The configured root password is authoritative:
changing `KIKOTO_ROOT_PASSWORD` and restarting Kikoto replaces the stored root
credential and revokes existing root sessions.

A super administrator can change **Anonymous access** under
`Maintenance -> Access` in production or development. The setting is stored in
SQLite and recorded in the audit log. In production it takes effect without a
restart. When disabled, unauthenticated clients can reach only health,
authentication bootstrap, and runtime-setting endpoints before the frontend
presents the sign-in page. That unauthenticated runtime response contains only
the deployment mode and access-policy state, not operational settings. When enabled,
unauthenticated `GET` and `HEAD` requests may browse and play Library content;
state-changing methods still require an authenticated account and permission.
Development exposes the same control for production-feature debugging, but its
automatic root identity means every development request remains authenticated.
Demo mode neither exposes nor uses the setting.

Browser sessions use HttpOnly, SameSite cookies. When HTTPS terminates at a
reverse proxy, set:

```dotenv
KIKOTO_SESSION_COOKIE_SECURE=true
```

List each exact trusted browser origin in `KIKOTO_ALLOWED_ORIGINS` when the
browser origin differs from the API origin. Also list the public HTTPS origin
when TLS terminates at a reverse proxy and the proxy connects to Kikoto over
HTTP. Do not use an open or reflected origin policy at the proxy.

## HTTPS and Android

The Android client permits cleartext HTTP for trusted local-NAS deployments and
stores a bearer session for the configured server. Use HTTPS or a trusted VPN
across shared, wireless, or public networks. Clearing the configured server in
the app also clears its stored session.

## Runtime Secrets and Private Data

Keep credentials and real source details outside the repository. Use local
environment variables or mounted configuration files. Kikoto does not yet
provide a dedicated encrypted credential store for remote-source secrets.

Do not commit:

- `.env` files with real values.
- SQLite databases.
- Remote source URLs with private tokens.
- Session cookies or bearer tokens.
- Local media.

Treat `/config/kikoto.db` as sensitive. It contains password hashes, active
session state, user preferences, private source configuration, workflow history,
and local media metadata. Restrict host permissions and include it in protected
backups.

## Remote Sources and Outbound Requests

Administrators can configure HTTP(S) source endpoints, and compatible sources
can return media and cover URLs that Kikoto requests from the server. Configure
only trusted sources, prefer HTTPS, and use host or network egress rules when
the Kikoto container must not reach private infrastructure.

The administrator-configured endpoint and source-returned URLs have different
trust levels:

- A configured endpoint may intentionally be a private LAN or NAS address. It
  is trusted operator configuration and should not be editable by an untrusted
  account.
- Media, cover, and other URLs returned by that endpoint are remote input. Do
  not assume they remain on the configured origin merely because the source
  itself is trusted.

The outbound transport accepts only HTTP(S) URLs without embedded credentials.
Every redirect hop is checked and credentials are removed on an allowed origin
change. DNS answers are validated as a complete set and the connection is made
to one of those same validated addresses. Built-in public metadata destinations
reject private and reserved addresses, while administrator-configured source
origins retain the intentional private-LAN exception.

Remote sources use public-host compatibility mode by default: source-returned
media, cover, and text URLs may use a different origin, but unconfigured
destinations must resolve only to public addresses. Enable **Restrict outbound
hosts** on a source when it should stay on the configured API, public-site, and
fallback origins. Strict sources may also list exact public hostnames or a
leading wildcard such as `*.media.example.invalid`; that wildcard permits
subdomains only and does not permit `media.example.invalid` itself. Additional
allowed hosts never receive the private-LAN exception.

The hardened outbound transport does not inherit ambient `HTTP_PROXY`,
`HTTPS_PROXY`, or `NO_PROXY` settings. Supporting a proxy would require an
explicitly configured proxy trust boundary that preserves destination and DNS
validation.

Container or host egress rules remain useful defense in depth, especially on a
host that can reach cloud metadata endpoints or unrelated private services. Do
not treat source configuration as safe input from an untrusted tenant.

When diagnosing remote access, do not paste an authenticated URL into a public
issue. Record the configured-origin and redirect relationship using reserved
domains or sanitized host labels instead.

## Filesystem and Container Boundaries

Kikoto expects `/config`, `/cache`, and `/data` to be dedicated runtime mounts.
Do not mount a host root, home directory, Docker socket, or unrelated sensitive
tree into those locations. Avoid symbolic links that leave the configured data
or cache roots.

The production image currently runs as the container root user. Limit the
container's host access through narrow bind mounts and host filesystem
permissions. The Demo stack additionally drops Linux capabilities, enables
`no-new-privileges`, and uses a read-only root filesystem.

## Logs and Diagnostics

Server logs and workflow Activity may contain local paths, configured endpoint
details, and upstream errors. Redact them before sharing a bug report or support
request. Never attach a real database, session token, source credential, or
media file to a public issue.

## Related Docs

- [Configuration](configuration.md)
- [Docker](docker.md)
- [Security Policy](../../SECURITY.md)
- [Contributing](../../CONTRIBUTING.md)
