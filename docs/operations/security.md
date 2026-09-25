# Security

Kikoto is a personal media server that requires sign-in by default. A super
administrator can deliberately expose read-only Library browsing and playback
to anonymous clients. Authentication always protects personal state,
configuration, and mutating operations; once anonymous access is enabled, it no
longer makes the complete Library or its media private. Use network access
controls when an instance must be private.

For privately reporting a vulnerability, see the repository
[Security Policy](../../SECURITY.md).

This document is for operators. For vulnerability reporting, use the
[Security Policy](../../SECURITY.md); for implementation rules, use [Secure
Development](../development/security.md).

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

- `production` uses normal session authentication, creates its first
  administrator through a one-time setup token unless the root account is
  environment-managed, and starts with anonymous access disabled.
- `development` authenticates every request as the configured root user. Use it
  only on a trusted local development machine.
- `demo` is an isolated read-only showcase. It exposes sanitized read surfaces,
  rejects non-read HTTP methods, and filters local content to verified all-ages,
  permanently free works. Never reuse production config, cache, or data
  directories for a public Demo.

The Demo container has a read-only root filesystem and data mount. Its isolated
`/config` and `/cache` mounts remain writable for SQLite state and accepted
cover assets, so they must contain only sanitized Demo data.

## Administrator Setup and Recovery

`KIKOTO_ROOT_ACCOUNT_MODE` selects who owns the root administrator:

- `setup`, the default, creates the first administrator in the web app and
  manages it there like any other account. The rest of this section describes
  this mode.
- `environment` makes `KIKOTO_ROOT_USERNAME` (default `root`) and
  `KIKOTO_ROOT_PASSWORD` define the root account on every start. See
  [Environment-managed root account](#environment-managed-root-account).

A new production instance has no administrator. Until one exists, Kikoto
writes a one-time setup token to its log at startup and to `setup-token` beside
the database, which is `config/setup-token` with the default Compose mounts.
The web app then shows **Set up Kikoto**, and creating the first administrator
requires that token. A client that can reach the port but cannot read the
server log or the config directory therefore cannot claim the instance. The
token changes on every start until setup completes and is deleted afterward;
later setup requests are rejected. Every new password must have at least 8
characters and must not be a value from the documentation.

To reset a forgotten administrator password, run the reset command in the
running container:

```sh
docker compose exec kikoto /app/kikoto admin reset-password
```

It prints a new random password for the initial administrator. Pass
`--username NAME` for another account, or `--password-stdin` to supply the
password on standard input. The account becomes an enabled super
administrator and is signed out everywhere, and the reset is recorded in the
audit log.

The reset never guesses its target. When the initial administrator has been
deleted, or an upgraded instance has none recorded, it stops, lists the
existing super administrators, and asks for `--username`. A named account must
already exist, so a mistyped name cannot create a new super administrator. The
only exception is `root`, which is created when it does not exist; use
`--username root` if no usable administrator is left. The account you reset
becomes the recorded initial administrator when the previous one is gone.

When a shell in the container is unavailable, for example in some NAS
interfaces, use the one-shot environment reset. Set the switch and a new
password in `.env`:

```dotenv
KIKOTO_ROOT_PASSWORD_RESET=true
# Enter a new password of at least 8 characters after the equals sign.
KIKOTO_ROOT_PASSWORD=
```

Run `docker compose up -d` to recreate the service and sign in. Then set
`KIKOTO_ROOT_PASSWORD_RESET=false`, clear `KIKOTO_ROOT_PASSWORD`, and run
`docker compose up -d` again. `KIKOTO_ROOT_USERNAME` selects the account and
follows the same rules as `--username`: when it is empty the initial
administrator is reset, startup stops if none is recorded, and only `root` is
created when missing. Each username and password
pair is applied only once, so a restart with the switch still enabled does not
undo a password changed later in Settings. Kikoto logs a warning while the
switch stays enabled, and ignores `KIKOTO_ROOT_PASSWORD` with a warning when the
switch is off. Anyone who can inspect the container environment can read that
password, so remove it after use.

### Environment-managed root account

For unattended or scripted deployments, set the root account in `.env`:

```dotenv
KIKOTO_ROOT_ACCOUNT_MODE=environment
KIKOTO_ROOT_USERNAME=root
# Enter a password of at least 8 characters after the equals sign.
KIKOTO_ROOT_PASSWORD=
```

Every start makes that account an enabled super administrator with the
configured password, so no setup token is issued. A changed password replaces
the stored one and signs the account out everywhere; an unchanged one leaves
its sessions alone. Kikoto refuses to start when the password is missing,
shorter than 8 characters, or a documentation value. In the app, that
account's password, role, and enabled state cannot be changed and it cannot be
deleted, so the app and the environment never disagree. To change its password,
edit `KIKOTO_ROOT_PASSWORD` and run `docker compose up -d`.

`KIKOTO_ROOT_PASSWORD_RESET` is ignored with a warning in this mode, and the
reset command refuses the environment-managed account; other accounts can
still be reset with `--username`. Switching back to `setup` keeps the account
and its current password, and the account becomes manageable in the app. The
password stays readable to anyone who can inspect the container environment.

## Authentication and Cookies

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

### Sign-in Throttling

Failed sign-ins are throttled in memory and reset when the process restarts.
After 5 failures for one username from one client, 20 failures from one client
across any usernames, or 50 failures for one username across all clients, that
client or username receives `429 Too Many Requests` with a `Retry-After`
header. The first lockout lasts one minute and doubles with each further
failure, up to 15 minutes for one client and username or 30 minutes otherwise.
A locked sign-in is rejected without checking the password, even when the
password is correct. A successful sign-in clears the username counters but not
the client counter. Unknown usernames are counted and timed like real ones, so
neither a lockout nor the response time reveals whether an account exists.

Passwords are hashed with Argon2id using 19 MiB of memory and two passes per
check. By default at most eight checks run at once, about 152 MiB in total;
set `KIKOTO_LOGIN_CONCURRENCY` to change that limit. A sign-in that cannot
start a check within five seconds receives a retryable `503` instead of
queueing without bound. A password stored with older, more expensive
parameters still works and is rehashed with the current parameters after the
next successful sign-in. Until that happens, verifying that password takes longer than
verifying the password of an account that does not exist.

Kikoto identifies the client by its direct peer address and groups IPv6 clients
by `/64`. Behind a reverse proxy every request arrives from the proxy, so all
clients would share one throttle. List the proxy address or network in
`KIKOTO_TRUSTED_PROXIES`, for example:

```dotenv
KIKOTO_TRUSTED_PROXIES=192.0.2.10
```

Kikoto then reads `X-Forwarded-For` only from those peers and uses the nearest
address that is not itself a trusted proxy. Configure the proxy to append the
connecting address to `X-Forwarded-For`, and never list an address range that
untrusted clients can connect from directly, because they could then choose
their own throttle key.

### Cookies

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
