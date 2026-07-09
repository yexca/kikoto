# Kikoto Documentation

This is the public documentation for Kikoto. It is organized by reader task:
understanding the product, running it, changing it, and reviewing design
decisions.

## Start Here

- [Overview](overview.md)
- [Getting started](getting-started.md)
- [Configuration](operations/configuration.md)
- [Troubleshooting](operations/troubleshooting.md)

## By Area

- [Architecture](architecture/index.md): system boundaries, modules, data, and
  workflow model.
- [Product specs](product/index.md): user-visible screens and behavior.
- [Operations](operations/configuration.md): runtime configuration, Docker,
  reliability, security, and troubleshooting.
- [Development](development/local-dev.md): local setup, testing, migrations, and
  contribution workflow.
- [Decisions](decisions/index.md): durable architecture decision records.
- [History](history/index.md): public historical notes and release-oriented
  summaries.

## Reading Paths

New users should read:

- [Overview](overview.md)
- [Getting started](getting-started.md)
- [Sources](product/sources.md)
- [Playback](product/playback.md)

Developers should read:

- [Core boundaries](architecture/core-boundaries.md)
- [Backend](architecture/backend.md)
- [Frontend](architecture/frontend.md)
- [Testing](development/testing.md)
- [Commit and release](development/commit-and-release.md)

Operators should read:

- [Docker](operations/docker.md)
- [Configuration](operations/configuration.md)
- [Database](operations/database.md)
- [Reliability](operations/reliability.md)
- [Security](operations/security.md)

## Documentation Rules

- User-visible behavior belongs in [Product specs](product/index.md).
- System boundaries belong in [Architecture](architecture/index.md).
- Runtime instructions belong in [Operations](operations/configuration.md).
- Local developer workflow belongs in [Development](development/local-dev.md).
- Durable design choices belong in [ADRs](decisions/index.md).
