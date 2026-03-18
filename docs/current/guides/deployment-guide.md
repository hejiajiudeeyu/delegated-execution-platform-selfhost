# Deployment Guide

This guide covers the current self-hosted platform deployment shapes for operators.

Current protocol/runtime baseline:

- platform returns request-scoped `delivery-meta` with `task_delivery` and `result_delivery`
- seller result mail uses a pure JSON body; buyer-controller parses and verifies it before exposing it upstream
- file outputs may travel as attachments described by signed `artifacts[]`
- `platform_inbox` is reserved for future evolution and is not implemented in current deployments

## Recommended Install Paths

- operator-facing deployment: prefer `deploy/public-stack`
- lower-level service deployment: use `deploy/platform` and `deploy/relay`
- end-user client installation is no longer the concern of this repository

## Supported Profiles

- `deploy/public-stack`: recommended operator-facing stack
- `deploy/platform`: platform API plus PostgreSQL
- `deploy/relay`: shared transport relay

Profile intent:

- `deploy/public-stack` is the primary operator bundle
- `deploy/platform` is the lower-level control-plane profile
- `deploy/relay` is the lower-level transport profile

## Legacy / Internal Profiles

The following profiles still exist for historical local integration and internal validation, but they are not the primary operator-facing product surface:

- `deploy/ops`
- `deploy/buyer`
- `deploy/seller`
- `deploy/all-in-one`

## Image Distribution

Each supported deploy profile accepts:

- `IMAGE_REGISTRY`
- `IMAGE_TAG`

Default image names:

- `rsp-relay`
- `rsp-platform`
- `rsp-gateway`

## Platform Admin Access

Set `PLATFORM_ADMIN_API_KEY` on the platform deployment if you want a stable operator credential for the local `platform-console-gateway`.

- `platform-console` should talk only to `platform-console-gateway`
- `platform-console-gateway` should use `PLATFORM_ADMIN_API_KEY`
- buyer credentials no longer imply operator access
- a user can still be granted the `admin` role later through the admin role-grant endpoint
- the browser should never persist the operator API key directly; it is stored in the encrypted local secret store and injected by the gateway
- `deploy/platform` should explicitly pass:
  - `PLATFORM_ADMIN_API_KEY`
  - `TRANSPORT_BASE_URL` when relay-backed `delivery-meta` is required
  - `REVIEW_TRANSPORT_BASE_URL` when hidden admin review tests use a dedicated relay path

Current compose files keep both `image` and `build` so local source builds still work. In a registry-backed environment, set `IMAGE_REGISTRY` and `IMAGE_TAG` to the published image coordinates.

Current repository default image namespace:

- `ghcr.io/hejiajiudeeyu`

## Public Stack

`deploy/public-stack` is the recommended starting point when you want a single operator-facing stack with public ingress.

Current first version includes:

- `platform-api`
- `postgres`
- `relay`
- `platform-console-gateway`
- `caddy` edge ingress

Current public routes:

- `/platform/*`
- `/relay/*`
- `/gateway/*`

The full operator bootstrap flow is documented in `docs/current/guides/public-stack-operator-guide.md`.

Recommended smoke validation split:

- source-build operator path: `npm run test:public-stack-smoke`
- published-image operator path: run `Published Images Smoke`

## Relay

The relay is the shared transport runtime used by the platform-facing stack.

- Hidden admin review tests use `REVIEW_TRANSPORT_BASE_URL` if set; otherwise the platform falls back to `TRANSPORT_BASE_URL`
- The relay can run with SQLite persistence via `RELAY_SQLITE_PATH`
- `local://relay/<receiver>/...` delivery addresses resolve to relay receivers

## Seller Signing Keys

Seller signing is optional for local demos but should be treated as required for non-demo deployments.

Configure both variables together:

- `SELLER_SIGNING_PUBLIC_KEY_PEM`
- `SELLER_SIGNING_PRIVATE_KEY_PEM`

Rules:

- Do not provide only one of the two values; startup fails on incomplete key pairs
- Encode multiline PEM values as escaped newlines when using `.env`
- Prefer secret injection from your runtime platform instead of committing PEM values into env files

Example format:

```env
SELLER_SIGNING_PUBLIC_KEY_PEM=-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----
SELLER_SIGNING_PRIVATE_KEY_PEM=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
```

For `platform` bootstrap mode, the matching variables are:

- `ENABLE_BOOTSTRAP_SELLERS`
- `BOOTSTRAP_SELLER_PUBLIC_KEY_PEM`
- `BOOTSTRAP_SELLER_PRIVATE_KEY_PEM`
- `BOOTSTRAP_SELLER_API_KEY`
- `BOOTSTRAP_TASK_DELIVERY_ADDRESS`

Use the same seller identity and key pair on both `platform` and `seller` when running them as separate deployments.
For production-oriented `deploy/platform`, leave bootstrap sellers disabled unless you are intentionally running a prewired demo environment.

## Deployment Recommendations

- `platform`: publish and deploy as a server-side image with managed PostgreSQL
- `public-stack`: prefer this when you want a single public operator bundle with edge ingress
- `buyer`: support both container deployment and direct embedding; use Docker when you want standardized operations
- `seller`: prefer repo-local `npm run ops -- ...` on end-user machines, and use container deployment for operator-managed standalone services

## Release Shape

Recommended image tagging model:

- immutable tag: git SHA
- human tag: release version such as `0.1.0`
- optional channel tag: `latest`

Recommended publish order:

1. publish shared test results
2. publish `rsp-platform`, `rsp-buyer`, `rsp-seller`
3. update deploy examples to the released `IMAGE_TAG`
