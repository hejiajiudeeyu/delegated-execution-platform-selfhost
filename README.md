# delegated-execution-platform-selfhost

Self-hosted platform, relay, and operator console for delegated execution.

Deploy the platform with Docker Compose to provide a Hotline catalog, request routing, Responder registry, and an operator web console for your team or organization.

> 中文版：[README.zh-CN.md](README.zh-CN.md)

---

## Quick Deploy

```bash
# Pull the latest compose entrypoint and env template
docker compose -f deploy/public-stack/docker-compose.yml up -d
```

Configure your environment by copying and editing the template:

```bash
cp deploy/platform/.env.example deploy/platform/.env
# Edit .env with your domain, secrets, and SMTP settings
```

---

## Platform Control Console

The **Platform Control** web console is available after deployment at the gateway URL. It gives operators a real-time view of platform health and all registered entities.

![Platform Overview](docs/screenshots/overview.png)

The Overview page shows:

- **Platform API** reachability status
- Live metrics: total requests, active Responders, active Hotlines, requests in the last hour
- **Platform Admin credentials** — configure your Admin API Key to enable full operator access

---

## Responder Management

Browse all registered Responders, inspect their status, and approve or suspend access from a single list view.

![Responder Management](docs/screenshots/responders.png)

*Place `docs/screenshots/responders.png` in the screenshots directory to show this section.*

---

## Hotline Review Queue

Review incoming Hotline registration requests before they are published to the catalog. Approve or reject submissions from the Review queue.

![Review Queue](docs/screenshots/reviews.png)

*Place `docs/screenshots/reviews.png` in the screenshots directory to show this section.*

---

## Hotline Management

View and manage all Hotlines registered on the platform, including their status, owner, and capability tags.

![Hotline Management](docs/screenshots/hotlines-admin.png)

*Place `docs/screenshots/hotlines-admin.png` in the screenshots directory to show this section.*

---

## Repository Responsibility

This repository owns the operator-facing self-hosted deployment surface:

- platform API, relay, Platform Control gateway, and deployable platform images
- Dockerfiles, `docker compose` entrypoints, and operator environment templates
- image build/smoke workflows and operator deployment documentation
- platform-side persistence and server-side integration wiring

This repository does not own the protocol truth source or the end-user `delexec-ops` client experience.

## AI Collaboration

- `CLAUDE.md` defines the repository-specific development and validation rules.
- `AGENTS.md` gives a minimal routing and ownership summary for AI coding agents.

## Public Product Surface

The intended end-user entry for this repository is a Docker-based deployment flow:

- an official `docker compose` entrypoint
- one `.env` template
- one operator deployment guide

The internal npm packages exist to support builds, tests, and image assembly. They are not the primary installation path for operators.

## Shared Dependencies

This repository consumes a small set of published shared packages:

- `@delexec/contracts`
- `@delexec/runtime-utils`
- `@delexec/sqlite-store`

## Release Model

- Primary operator-facing release artifact: Docker images plus `docker compose`
- Internal development artifacts: workspace npm packages such as `@delexec/platform-api`, `@delexec/transport-relay`, and `@delexec/postgres-store`

See also: `docs/current/guides/release-surface.md`

## How To Develop Here

- Start here when the change affects operator deployment, server-side APIs, relay behavior, platform persistence, or image/compose delivery.
- Keep the operator product boundary simple: the primary supported path is Docker images plus `docker compose`, not npm installation of server packages.
- Treat `deploy/public-stack`, `deploy/platform`, and `deploy/relay` as the supported deployment surfaces.

Recommended change flow:

1. If the change alters protocol semantics, update `delegated-execution-protocol` first and consume the released `@delexec/contracts`.
2. Implement platform and deployment changes here.
3. Run platform CI, package checks, deploy config checks, and public-stack smoke.
4. Release Docker images and compose artifacts as the operator-facing deliverable.

When working through the fourth-repo workspace, prefer the top-level `corepack pnpm install` plus `corepack pnpm run sync:local-contracts` flow before cross-repo validation.
