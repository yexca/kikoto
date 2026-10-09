# Getting Started
[English](../en/getting-started.md) · [简体中文](../zh-Hans/getting-started.md) · [繁體中文](../zh-Hant/getting-started.md) · [日本語](../ja/getting-started.md) · [한국어](../ko/getting-started.md)

## Requirements

- Docker and Docker Compose.
- Optional for local development:
  - Go 1.26.9.
  - Node.js 24.19.0 with npm 11.17.0.

## Run With Docker

Download `docker-compose.yml` into an empty directory, then pull and start the
latest published Docker Hub image. No password is needed before startup:

```sh
docker compose up -d
```

The default image is `yexca/kikoto:latest`, which the release workflow updates
for each public release. `docker compose up -d` pulls missing images and always
pulls `latest`; `docker compose restart` reuses the current container image.
When upgrading a fixed version, update `KIKOTO_IMAGE` to the desired tag or
digest before running `docker compose up -d`. For a reproducible
deployment, set `KIKOTO_IMAGE` in `.env` to a reviewed version or
digest:

```sh
KIKOTO_IMAGE=yexca/kikoto@sha256:d51500d0155694908e392e6f936c24610eac23e16072bcef7b03c229d89953ca docker compose up -d
```

Open:

- Frontend: `http://127.0.0.1:7655`

On first start the frontend shows **Set up Kikoto**. Enter the one-time setup
token from `docker compose logs kikoto` or `config/setup-token`, then choose the
administrator username and password. To reset a forgotten password, see
[Administrator setup and recovery](../../operations/security.md#administrator-setup-and-recovery).

The production Compose stack publishes the web application and API together on
port `7655`. Port `7659` is the container's internal backend port; it is
published separately only by the development Compose stack.

The default runtime mounts are:

- `./config:/config`
- `./cache:/cache`
- `./data:/data`

For a public read-only instance, use `deploy/compose/demo.yml`. It pulls the
published image and uses separate `./demo` mounts. Put candidate work folders
under `./demo/data`; the dedicated startup workflow verifies and indexes only
all-ages, permanently free works. See [Docker](../../operations/docker.md#demo-stack).

## Android Client

Signed Android APKs are attached to the project GitHub Releases.
The client compares its version with the connected server. An older client
offers the matching Release, while a newer client identifies the server as the
component to update. Network failures retain a separate Reconnect action.

Kikoto does not silently install Android packages. Opening a Release and
installing its APK remains an explicit user-confirmed Android system flow.

## iOS Client

Each GitHub Release also includes an unsigned iOS IPA,
`kikoto-<version>-unsigned.ipa`. iOS cannot install it as downloaded; a
sideloading tool re-signs it with your own Apple account during installation.
Like the Android client, it compares its version with the connected server.

## First Library Setup

1. Put supported audio work folders under `data/`, or mount each storage disk
   as a folder of `data/` (see below).
2. Start the Docker stack and open the frontend.
3. After the administrator account exists, **Set up your library** opens:
   - Choose **Standard** (the whole `data/` directory is one library) or
     **Storage pools** (each selected first-level folder of `data/` is its own
     disk or cloud drive), and in pool mode the **Fetch pool** that receives
     new Fetches. A later mode or Fetch-pool change asks for confirmation and
     moves affected files while the site is in maintenance.
   - Scan the library. The scan discovers local works without waiting for
     provider metadata.
   - If an upgrade preserved earlier custom workflows, review them. Kikoto can
     convert exact preset matches into disabled triggers; unmatched definitions
     can be exported. Fresh installs and upgrades without custom workflows skip
     this step.
   - Optionally start metadata sync, which runs in the background.
   - Decide whether scans run on startup and when folders change. Both start
     off on a new install; they can be turned on later in Workflows.

**Later** closes the setup until the next visit. An instance upgraded from an
earlier release keeps the standard layout and its scan triggers, but sees this
setup to choose whether to move into storage pools. Moving into pools runs a
new local scan before the remaining setup steps. During a move, administrators
see progress; other users see a maintenance notice. A failed move can be
retried after checking the disks.

### Storage Pools

Mount each disk or cloud drive as its own folder of the data directory, for
example:

```yaml
volumes:
  - ./config:/config
  - ./cache:/cache
  - ./data:/data
  - /mnt/disk1:/data/disk1
  - /mnt/cloud:/data/cloud
```

Kikoto writes a `.kikoto-pool` marker into each selected folder. When a disk is
not mounted, its folder is empty and has no marker, so the pool is shown as
offline and scans leave its works unchanged instead of reporting them missing.
Fetch stages and publishes inside the pool that receives the files, so each
publication is a rename on one disk. Choose a Fetch pool in Settings -> Library
before fetching; until then Fetch explains what to configure.

## Validate The Build

The commands below validate a source checkout. For the complete and consistent
repository checks, prefer the corresponding [Makefile](../../../Makefile) targets.

Backend (source checkout only):

```sh
cd backend
go test ./...
```

Frontend (source checkout only):

```sh
cd frontend
npm ci --strict-allow-scripts
npm run build
```

## Next Reading

- [Configuration](../../operations/configuration.md)
- [Docker](../../operations/docker.md)
- [Library](library.md)
- [Sources](sources.md)
