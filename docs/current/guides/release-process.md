# Release Process

This repository uses a minimal L0 release process.

The repository is still a monorepo, but pre-split release validation now has a dedicated protocol-package lane in addition to the implementation image lanes.

## Goals

- produce versioned container images for `platform`, `buyer`, `seller`, and `relay`
- produce a release-shaped protocol package for `@delexec/contracts`
- validate both source-build compose paths and image-based compose paths
- validate that protocol templates/docs can be consumed from a packed artifact instead of a monorepo-relative path
- keep the release bar small enough for L0 while preserving repeatability

## Image Tags

Recommended tags:

- immutable: git SHA
- release: `vX.Y.Z`
- optional moving tag: `latest` on release tags

## CI Expectations

- `CI` runs protocol, client, and platform lanes, with packaging and smoke gates mapped to future three-repo ownership
- `CI` also runs a local image-based smoke against `deploy/all-in-one` using release-shaped image coordinates
- `CI` runs a naming-boundary check so legacy names cannot leak back outside the approved migration documents
- `Published Images Smoke` is the GHCR-facing validation path for already-published images
- `Images` builds release images on pull requests and can push them on release tags or manual dispatch
- `CI` checks that the current repository version has a matching release note file and compatibility matrix entry
- `compose-smoke` classifies failures so image pull/network issues can be distinguished from service health or scenario failures
- `compose-smoke` uses an isolated compose project per run and pre-cleans that project before startup, reducing local/CI cross-run contamination
- `compose-smoke` retries transient image-pull startup failures a small number of times before classifying the run as `image_pull_failed`

## Recommended Release Steps

1. cut a version tag such as `v0.1.0`
2. run the protocol package check and confirm `@delexec/contracts` still packs, installs, and exposes bundled templates/docs
3. run the packaged-service check and confirm `platform` / `buyer` / `seller` / `relay` tarballs still install and boot in a clean room
4. run the packaged-e2e check and confirm the full e2e suite still passes with installed tarball commands injected through `E2E_*_CMD`
5. let the `Images` workflow publish `rsp-platform`, `rsp-buyer`, `rsp-seller`, and `rsp-relay`
6. ensure `docs/archive/releases/vX.Y.Z.md` exists and `docs/archive/releases/compatibility-matrix.md` includes the tag
7. verify the matching `Published Images Smoke` workflow passed against GHCR
8. update any external deployment environment to the released `IMAGE_TAG`
9. ensure the current readiness boundary still matches `docs/current/guides/product-readiness-boundary.md`

## Compose Smoke Failure Classes

- `image_pull_failed`: base image or registry/network pull problem
  - includes Docker Hub auth/token fetch failures such as `failed to fetch oauth token`, `failed to authorize`, or registry EOF during image resolution
- `port_conflict`: local port allocation problem
- `compose_up_failed`: generic compose start failure
- `service_runtime_failed`: containers started but entered `unhealthy/exited/restarting`
- `health_check_timeout`: services did not become healthy in time
- `postgres_crud_check_failed`: database booted but failed basic CRUD
- `register_failed` / `catalog_failed` / `buyer_remote_request_failed` / `ack_not_ready` / `buyer_result_not_ready`: business-path regression

## Compatibility Note

For L0, compatibility is tracked at the repository release level:

- one repository version maps to one image tag set
- mixed-version deployments are not yet part of the support promise
- the compatibility matrix is recorded in `docs/archive/releases/compatibility-matrix.md`

## Protocol Package Note

Pre-split packaging rules for `@delexec/contracts`:

- the package name is already frozen as `@delexec/contracts`
- the package must stay independently `npm pack`-able from the monorepo root
- the packed artifact must include `templates/manifest.json` and the protocol doc snapshot under `protocol-docs/`
- client/platform-side code should converge on consuming the packaged protocol artifact instead of reading `docs/templates` directly

## Pre-Split Compatibility Gate

Pre-split release validation now has three packaging gates:

- `npm run test:protocol:package`
- `npm run test:service:packages`
- `npm run test:e2e:packages`

Together they verify:

- the protocol artifact is installable and exports bundled templates/docs
- the implementation service artifacts are installable and bootable
- the end-to-end flow passes when services are started from installed tarball commands instead of source entrypoints
