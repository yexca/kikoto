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
  <a href="README.zh-Hans.md">简体中文</a> ·
  <a href="README.zh-Hant.md">繁體中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a>
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

## Known Issues

> [!WARNING]
> **Android 10 keyboard layout (APK).** Current APK builds are affected on
> Android 10, and later APK releases should also be considered affected until
> the upstream Capacitor fix is released and adopted by Kikoto. On affected
> devices, opening the software keyboard can leave an Android system-rendered
> area between the app and the keyboard, reducing the usable app area to roughly
> 6–20% of the screen. Opening Kikoto in a web browser is not affected.
> Investigation points to Android 10 IME insets being applied twice by
> Capacitor's SystemBars
> handling ([#8525](https://github.com/ionic-team/capacitor/issues/8525),
> [#8466](https://github.com/ionic-team/capacitor/issues/8466), and
> [#8528](https://github.com/ionic-team/capacitor/pull/8528)). Use Kikoto in a
> browser on affected Android 10 devices until that upstream fix is available.

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
  retries, review candidates, and recovery in Workflows and Activity.
- **Personal and administrative state.** Keep favorites, tags, listening state,
  playback progress, roles, source configuration, and cache policy in SQLite.

## Quick Start

### 1. Prepare the deployment directory

Place [`docker-compose.yml`](docker-compose.yml) in an empty directory. Create a
`.env` file beside it with a strong, unique root password:

```dotenv
KIKOTO_ROOT_PASSWORD=replace-with-a-long-random-password
```

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

Normal restarts reuse the installed image. Run the same command with
`--pull always` when upgrading so the default `latest` tag is refreshed before
the service starts. For a reproducible deployment, set `KIKOTO_IMAGE` to a
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
| Review design and security contracts | [Design](DESIGN.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md) |
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

The workflow canvas interaction design was informed by
[ComfyUI](https://github.com/comfyanonymous/ComfyUI). Kikoto does not include
or adapt ComfyUI source code; its canvas is an independent React implementation
built with the MIT-licensed `@xyflow/react` library.

## License

Copyright (C) 2026 yexca. Kikoto is free software licensed under the
[GNU Affero General Public License v3.0](LICENSE) and comes without warranty.
