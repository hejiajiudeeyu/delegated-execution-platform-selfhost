# Release Process

This repository uses a minimal self-hosted platform release process.

## Goals

- produce versioned container images for `platform`, `buyer`, `seller`, and `relay`
- produce versioned container images for `platform`, `gateway`, and `relay`
- validate the operator-facing `public-stack` compose path in both source-build and published-image modes
- keep the release bar small enough for L0 while preserving repeatability

## Image Tags

Recommended tags:

- immutable: git SHA
- release: `vX.Y.Z`
- optional moving tag: `latest` on release tags

## CI Expectations

- `CI` runs the platform lane plus a source-build `public-stack` compose smoke
- `Published Images Smoke` is the GHCR-facing validation path for already-published images
- `Images` builds release images on pull requests and can push them on release tags or manual dispatch
- `CI` checks that the current repository version has a matching release note file and compatibility matrix entry

## Recommended Release Steps

1. cut a version tag such as `v0.1.0`
2. run the platform integration checks
3. run the packaged-service check and confirm `platform-api` and `relay` tarballs still install and boot in a clean room
4. run the source-build `public-stack` smoke and confirm the operator ingress path still works
5. let the `Images` workflow publish `rsp-platform`, `rsp-gateway`, and `rsp-relay`
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

## Operator Release Boundary

This repository is compose-first:

- the primary operator artifact is `deploy/public-stack/docker-compose.yml`
- npm packages in this repository support build and validation, not the main operator install path
- the image matrix is `rsp-platform`, `rsp-gateway`, and `rsp-relay`
