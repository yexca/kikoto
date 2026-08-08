<p align="center">
  <img src="frontend/public/kikoto-icon-192.png" width="128" height="128" alt="Kikoto logo">
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
  <a href="https://github.com/yexca/kikoto/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/yexca/kikoto/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/yexca/kikoto/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/yexca/kikoto"></a>
  <a href="https://hub.docker.com/r/yexca/kikoto"><img alt="Docker pulls" src="https://img.shields.io/docker/pulls/yexca/kikoto"></a>
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/github/license/yexca/kikoto"></a>
</p>

Kikoto combines DLsite-style metadata, local folders, rebuildable cache, and
Kikoeru-compatible remote file sources under one unified work model. It ships
as a self-hosted web application with a responsive player and an Android client.

> [!IMPORTANT]
> Kikoto is under active development. Back up `config/` and `data/` before an upgrade, and review the [security model](docs/operations/security.md) before exposing an instance to a network.

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

Place supported work folders under the host `data/` directory. See
[Library Layout and Scan Rules](#library-layout-and-scan-rules) for accepted
folder names.

### 3. Start Kikoto

```sh
docker compose pull
docker compose up -d
```

Open <http://127.0.0.1:7655>.

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

## Library Layout and Scan Rules

Kikoto identifies a work from a directory name containing a supported code. The
match is case-insensitive and follows these rules:

- Prefix: `RJ`, `BJ`, `VJ`, or `CC`.
- Number: 5 to 8 digits.
- Optional separator between the prefix and number: one space, `_`, or `-`.
- Additional text may appear before or after the code.

The following tree uses synthetic identifiers:

```text
data/
├── RJ00000 Example Work/
│   ├── 01 Introduction.flac
│   └── cover.jpg
└── collection/
    └── VJ_00000 Example Edition/
        └── main.wav
```

The default Compose scan depth is 4. Administrators can set a value from 1 to 8
under Maintenance. For nested matching directories, Kikoto selects the deepest
non-overlapping candidate. Duplicate codes are retained for Activity review.
Fetch transaction directories named `.kikoto-staging`, `.kikoto-backup`, and
`.kikoto-trash` are excluded from discovery.

For compatible remote sources using a source-separated save template, Kikoto
claims a Fetch-managed root under `/data`. Fetch registers published files
directly, so changes below a claimed Fetch root do not trigger the native folder
watcher. Startup and manual scans still inspect the complete data tree. Kikoto
writes a machine ownership marker and a multilingual `README.md` in each
claimed root; store manually managed works elsewhere in the data directory. A
non-empty, unclaimed directory at the same path blocks the first Fetch and
appears in the Fetch review instead of being silently adopted.

Recognized audio extensions include MP3, M4A, FLAC, WAV, WMA, OGG, Opus, and
AAC. Video, image, text, and other files remain visible in the directory tree
with their corresponding media kind when recognized.

The default Startup workflow scans the library after service startup. A native
directory watcher queues the same scan while Kikoto is running, and a manual
scan remains available from Workflows. The scan records folder presence and
does not wait for metadata synchronization, so the local library becomes usable
sooner. Manual, Startup, and interval scans can opt into a disabled-by-default
`Follow-up run` that queues an independent metadata sync after the scan has
finished. Detailed local media trees are indexed when needed.

## Remote Sources

Kikoto supports two configuration paths for new compatible remote sources.

### Administration UI

For normal operation, sign in as an administrator and open:

```text
Maintenance -> Library -> Remote sources -> Add source
```

The UI manages source identity, priority, enabled state, API endpoint, optional
fallback, work-link template, health checks, and resolved save-path previews.

### First-run configuration file

For automated deployment, copy
[`config/remote-sources.example.yml`](config/remote-sources.example.yml) to
`config/remote-sources.yml` and replace the reserved example values locally:

```yaml
sources:
  - display_name: Example Remote
    source_type: kikoeru_compatible
    enabled: true
    priority: 30
    api_url: https://example.invalid/api
    base_url: https://example.invalid
    fallback_url: ""
```

Enable the seed in `.env`:

```dotenv
KIKOTO_REMOTE_SOURCES_ENABLED=true
KIKOTO_REMOTE_SOURCES_FILE=/config/remote-sources.yml
```

The file is a first-run seed: Kikoto ignores it once a compatible remote source
already exists in SQLite. Continue managing sources through the administration
UI after bootstrap. Keep real endpoints and credentials outside the repository.

See [Configuration](docs/operations/configuration.md),
[Sources](docs/product/sources.md), and
[Secure Development](docs/development/security.md) for the complete boundary.

## Browse, Track, Sync, Cache, and Fetch

| Action | What it keeps | Media location |
| --- | --- | --- |
| **Browse** | A live source-scoped catalog or directory view | Remote source only |
| **Track** | The unified work, source relationship, metadata snapshot, and browsable remote directory tree | SQLite and remote locations; no media publication to `/data` |
| **Sync** | A refreshed remote snapshot and directory tree for the selected source | SQLite and remote locations |
| **Cache** | Selected remote media for reusable playback | `/cache`; rebuildable |
| **Fetch** | Reviewed files promoted into the durable local library | `/data`; persistent |

Fetch first builds a plan, resolves file conflicts and source choices, verifies
disk reserve, and then runs as a recoverable workflow. Files are materialized,
staged, verified, published, and registered as local locations. A queued or
running Fetch is unique per canonical work, so repeated requests reuse the same
run instead of downloading the work twice.

Track does not publish media into `data/`; it persists the selected source's
browsable tree so the work remains available in the Tracked view. Cache is for
rebuildable playback material. Fetch is the action that creates durable local
media.

## Documentation

| Goal | Start here |
| --- | --- |
| Install and scan a first library | [Getting Started](docs/getting-started.md) |
| Understand user-visible behavior | [Product Specs](docs/product/index.md) |
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

Anonymous Library browsing and playback are intentional production behavior.
Use network controls when the collection itself must remain private. Report a
suspected vulnerability through the private process in [SECURITY.md](SECURITY.md)
and review [PRIVACY.md](PRIVACY.md) before sharing logs or diagnostics.

## Acknowledgements

The workflow canvas interaction design was informed by
[ComfyUI](https://github.com/comfyanonymous/ComfyUI). Kikoto does not include
or adapt ComfyUI source code; its canvas is an independent React implementation
built with the MIT-licensed `@xyflow/react` library.

## License

Copyright (C) 2026 yexca. Kikoto is free software licensed under the
[GNU Affero General Public License v3.0](LICENSE) and comes without warranty.
