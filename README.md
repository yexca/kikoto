<p align="center">
  <img src="docs/assets/kikoto-readme-icon.png" width="128" height="128" alt="Kikoto logo">
</p>

<h1 align="center">Kikoto</h1>

<p align="center">
  A local-first personal audio library, source browser, and player.
</p>

<p align="center">
  <a href="docs/README.md">Documentation</a> ·
  <a href="https://github.com/yexca/kikoto/releases">Releases</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="PRIVACY.md">Privacy</a>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="docs/readme/README.zh-Hans.md">简体中文</a> ·
  <a href="docs/readme/README.zh-Hant.md">繁體中文</a> ·
  <a href="docs/readme/README.ja.md">日本語</a> ·
  <a href="docs/readme/README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="https://github.com/yexca/kikoto/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/yexca/kikoto"></a>
  <a href="https://kikoto.yexca.net"><img alt="Live demo" src="https://img.shields.io/badge/demo-kikoto.yexca.net-0f766e"></a>
  <a href="https://hub.docker.com/r/yexca/kikoto"><img alt="Docker image" src="https://img.shields.io/badge/docker-yexca%2Fkikoto-2496ed?logo=docker&amp;logoColor=white"></a>
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/github/license/yexca/kikoto"></a>
</p>

<p align="center">
  <img src="docs/assets/kikoto-showcase.png" width="1200" alt="Kikoto library, source browser, and player showcase">
</p>

Kikoto combines DLsite-style metadata, local folders, rebuildable cache, and
Kikoeru-compatible remote file sources under one unified work model. It ships
as a self-hosted web application with a responsive player and an Android client.

> [!IMPORTANT]
> Kikoto is under active development. Back up `config/` and `data/` before an upgrade, and review the [security model](docs/operations/security.md) before exposing an instance to a network.

> [!NOTE]
> **Custom workflows have been removed.** Workflows are now built-in only. The
> former custom editor is replaced by preset workflows (Follow a circle, Follow
> a series, Follow a voice actor) that expose a small validated parameter set.
> Upgrading deletes user-authored definitions and their triggers; their run
> history stays readable in Activity.

## Key Features

- **One library, multiple locations.** Local, cached, tracked, and remote files
  remain availability states of one work instead of separate library entries.
- **Local library discovery.** Scan supported work-code folders and keep local
  presence current through startup and filesystem-triggered workflows. Run
  metadata synchronization independently when enrichment is needed.
- **Remote source workflows.** Browse compatible sources, Track their directory
  trees, Cache selected media, or Fetch reviewed files into the local library.
- **Listening continuity.** Use a persistent player with queue, lyrics,
  playback speed, sleep timer, source fallback, Media Session, and PWA support.
- **Responsive and Android-ready.** Use the same library on desktop and mobile,
  with native Android media controls and audio-focus integration.
- **Inspectable background work.** Follow scans, metadata sync, Fetch, cleanup,
  retries, and review candidates in Workflows and its Activity panel. Browse
  saved metadata and resolve metadata or missing-source issues in Metadata.
- **Personal and administrative state.** Keep favorites, tags, listening state,
  playback progress, account-backed folder and recommendation preferences,
  roles, source configuration, and cache policy in SQLite.

## Quick Start

On Windows, beginners can place [`kikoto-helper.cmd`](kikoto-helper/kikoto-helper.cmd)
in a deployment folder and run it. The first screen selects English or
Simplified Chinese and downloads only the selected language helper beside the
command file. It then checks Docker Desktop, downloads the versioned Compose
files, creates the runtime directories, configures the administrator password,
manages additional media-folder mappings, and provides start, stop, upgrade,
status, logs, and configuration-backup actions. Existing `.env` and Compose
files are kept; the helper does not overwrite them during re-runs.

The helper automatically prepares missing deployment files and requires an
administrator password on first setup. Later password changes can recreate the
service to apply the new configuration; restarting alone does not reload `.env`.
Service management also offers explicit recreation, container removal, and the
local image version. Removing containers keeps host-mounted files.

Folder management requires Docker Compose 2.24.4 or newer. Single-folder mode
mounts the selected directory at `/data`. Multiple-folder mode keeps the host
`data/` mount at `/data` for downloads and mounts only the selected directories
below it; it creates no persistent volume. The “Other → Multiple-folder repair”
action restores that host mount for deployments created by older helper versions.

### 1. Prepare the deployment directory

Place [`docker-compose.yml`](docker-compose.yml) in an empty directory. Create a
`.env` file beside it with a strong, unique root password:

```dotenv
KIKOTO_ROOT_PASSWORD=replace-with-a-long-random-password
```

Use [`.env.example`](.env.example) for optional settings, including the image,
root username, scan depth, cookie security, and container paths. Compose reads
`.env` automatically; shell environment variables take precedence. See
[Compose configuration](docs/operations/docker.md#configure-with-env) for defaults
and how to apply changes.

Create the three host directories used by the default Compose stack:

```sh
mkdir config cache data
```

### 2. Add local media

Place supported work folders under the host `data/` directory. See the
[User Guide](docs/user/index.md) for library layout and scan rules.

### 3. Start Kikoto

```sh
docker compose up -d --pull always
```

`docker compose restart` reuses the current container image.
`docker compose up -d` uses Compose's default pull policy, which pulls missing
images and always pulls the `latest` tag. Use `--pull always` when upgrading a fixed tag too.
For a reproducible deployment, set `KIKOTO_IMAGE` in `.env` to a
reviewed release tag or image digest and update it deliberately during an
upgrade. Back up `config/` and `data/` before upgrading; existing databases are
migrated on startup and are never rebuilt from the fresh-install baseline.

Open <http://127.0.0.1:7655>.

Sign in with the configured root username (default `root`) and
`KIKOTO_ROOT_PASSWORD`. Production instances require sign-in by default. A
super administrator can optionally enable read-only anonymous Library browsing
and playback under `Maintenance -> Access`.

The production Compose stack serves the web application and API on the same
host port. Port `7659` is exposed separately only by the development stack.

The default mapping listens on every host interface. Bind it to loopback, use a
trusted VPN, or configure a protected reverse proxy when the instance should
not be reachable from the surrounding network. See
[Docker](docs/operations/docker.md) and [Security](docs/operations/security.md)
for deployment options, including the isolated read-only Demo stack.

## Runtime Data

| Host path | Container path | Purpose | Back up? |
| --- | --- | --- | --- |
| `./config` | `/config` | SQLite state and optional first-run source configuration | Yes |
| `./data` | `/data` | Original media, fetched media, and durable Fetch review/rollback state | Yes |
| `./cache` | `/cache` | Rebuildable covers and media cache | Usually no |

Do not commit any of these runtime directories. They may contain private media,
account state, source endpoints, workflow diagnostics, or credentials.

## User documentation

The [User Guide](docs/user/index.md) covers library layout and scanning, remote
sources, playback, work details, workflows, and settings. The [Operations
docs](docs/operations/configuration.md) cover deployment, configuration,
database, reliability, and troubleshooting.

## Documentation

| Goal | Start here |
| --- | --- |
| Use Kikoto | [User Guide](docs/user/index.md) |
| Install and scan a first library | [Getting Started](docs/user/en/getting-started.md) |
| Understand user-visible behavior | [Product Specs](docs/user/en/index.md) |
| Configure and operate an instance | [Operations](docs/operations/configuration.md) |
| Understand data and system boundaries | [Architecture](docs/architecture/index.md) |
| Review design and security contracts | [Design](docs/development/design.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md) |
| Find every public document | [Documentation Index](docs/README.md) |

## Development and Contributing

Development setup, validation commands, migrations, and release procedures live
under `docs/development/` so this README can stay focused on installation and
product behavior.

- [Local Development](docs/development/local-dev.md)
- [Testing](docs/development/testing.md)
- [Contributing](CONTRIBUTING.md)
- [Agent Guide](AGENTS.md)

## Security and Privacy

Production instances require sign-in by default. When a super administrator
enables anonymous access, Library browsing and playback become intentionally
public to anyone who can reach the instance; mutations and personal or
administrative state still require authentication. Use network controls when
the collection itself must remain private. Report a suspected vulnerability
through the private process in [SECURITY.md](SECURITY.md) and review
[PRIVACY.md](PRIVACY.md) before sharing logs or diagnostics.

## Acknowledgements

Kikoto's former workflow canvas drew on the interaction design of
[ComfyUI](https://github.com/comfyanonymous/ComfyUI). Kikoto never included or
adapted ComfyUI source code; that canvas was an independent React
implementation built with the MIT-licensed `@xyflow/react` library and has
since been retired.

## License

Copyright (C) 2026 yexca. Kikoto is free software licensed under the
[GNU Affero General Public License v3.0](LICENSE) and comes without warranty.
