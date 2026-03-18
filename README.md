# delegated-execution-platform-selfhost

Self-hosted platform, relay, deploy configs, and operator surfaces for delegated execution.

This repository contains the platform-side apps and self-hosted deployment materials split from the original monorepo.

## Public Product Surface

The intended end-user entry for this repository is a Docker-based deployment flow:

- an official `docker compose` entrypoint
- one `.env` template
- one operator deployment guide

The internal npm packages in this repository exist to support builds, tests, and image assembly. They are not the primary installation path for operators.

## Repository Responsibility

This repository owns the operator-facing self-hosted deployment surface:

- platform API, relay, platform console gateway, and deployable platform images
- Dockerfiles, `docker compose` entrypoints, and operator environment templates
- image build/smoke workflows and operator deployment documentation
- platform-side persistence and server-side integration wiring

This repository does not own the protocol truth source or the end-user `delexec-ops` client experience.

## Shared Dependencies

This repository consumes a small set of published shared packages:

- `@delexec/contracts`
- `@delexec/runtime-utils`
- `@delexec/sqlite-store`

## Release Model

- Primary operator-facing release artifact: Docker images plus `docker compose`
- Internal development artifacts: workspace npm packages such as `@delexec/platform-api`, `@delexec/transport-relay`, and `@delexec/postgres-store`

## How To Develop Here

- Start here when the change affects operator deployment, server-side APIs, relay behavior, platform persistence, or image/compose delivery.
- Keep the operator product boundary simple: the primary supported path is Docker images plus `docker compose`, not npm installation of server packages.
- Treat `deploy/public-stack`, `deploy/platform`, and `deploy/relay` as the supported deployment surfaces; legacy profiles are secondary.

Recommended change flow:

1. If the change alters protocol semantics, update `delegated-execution-protocol` first and consume the released `@delexec/contracts`.
2. Implement platform and deployment changes here.
3. Run platform CI, package checks, deploy config checks, and public-stack smoke.
4. Release Docker images and compose artifacts as the operator-facing deliverable.
