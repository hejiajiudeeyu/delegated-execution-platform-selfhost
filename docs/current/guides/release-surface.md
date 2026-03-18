# Platform Release Surface

This repository is operator-facing through Docker images and `docker compose`.

## Primary Product Surface

Normal operators should interact with this repository through:

- published GHCR images
- `deploy/public-stack/docker-compose.yml`
- `deploy/platform/docker-compose.yml`
- `deploy/relay/docker-compose.yml`

## Internal npm Packages

This repository still contains workspace packages such as:

- `@delexec/platform-api`
- `@delexec/transport-relay`
- `@delexec/postgres-store`

These packages exist to support:

- repository-local builds
- service package smoke checks
- image assembly and validation

They are not the primary operator installation path.

## Release Policy

1. Release `@delexec/contracts` first when protocol changes are involved.
2. Upgrade published shared dependencies consumed by this repository.
3. Release GHCR images for `rsp-platform`, `rsp-gateway`, and `rsp-relay`.
4. Validate the matching compose path through source-build and published-image smoke.

## Development Rule

When deciding where to invest UX and documentation effort, optimize for the compose-driven operator flow, not npm installation of platform services.
