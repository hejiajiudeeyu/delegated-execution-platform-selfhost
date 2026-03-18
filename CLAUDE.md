# CLAUDE.md

This repository is the operator-facing self-hosted platform surface for delegated execution.

## Start Here

Read in this order before changing behavior:

1. `README.md`
2. `docs/current/guides/release-surface.md`
3. `docs/current/guides/deployment-guide.md`
4. `docs/current/guides/public-stack-operator-guide.md`
5. `docs/current/guides/release-process.md`
6. `docs/current/guides/product-readiness-boundary.md`

## Repository Boundary

This repository owns:

- platform API
- relay
- platform console gateway
- Dockerfiles, images, and compose entrypoints
- operator environment templates and deployment docs

This repository does not own:

- protocol truth-source definitions
- end-user `delexec-ops` UX

## Development Rules

- Optimize for Docker images and compose as the primary operator installation path.
- Treat `deploy/public-stack`, `deploy/platform`, and `deploy/relay` as the supported deployment profiles.
- Keep npm packages here available for builds and validation, but not as the normal operator install path.
- If a change alters protocol semantics, release `@delexec/contracts` first and then update this repository.

## Validation

Run after meaningful changes:

```bash
npm install
npm test
npm run test:service:packages
npm run test:deploy:config
npm run test:release:docs
npm run test:public-stack-smoke
```

## Release Rule

The primary release artifacts are GHCR images and compose deployment materials, not npm installation of platform services.
