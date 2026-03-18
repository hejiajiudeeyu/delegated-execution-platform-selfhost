# delegated-execution-platform-selfhost

Self-hosted platform, relay, deploy configs, and operator surfaces for delegated execution.

This repository contains the platform-side apps and self-hosted deployment materials split from the original monorepo.

## Public Product Surface

The intended end-user entry for this repository is a Docker-based deployment flow:

- an official `docker compose` entrypoint
- one `.env` template
- one operator deployment guide

The internal npm packages in this repository exist to support builds, tests, and image assembly. They are not the primary installation path for operators.

## Shared Dependencies

This repository consumes a small set of published shared packages:

- `@delexec/contracts`
- `@delexec/runtime-utils`
- `@delexec/sqlite-store`

## Release Model

- Primary operator-facing release artifact: Docker images plus `docker compose`
- Internal development artifacts: workspace npm packages such as `@delexec/platform-api`, `@delexec/transport-relay`, and `@delexec/postgres-store`
