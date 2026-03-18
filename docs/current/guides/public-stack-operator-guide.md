# Public Stack Operator Guide

This guide is the operator-facing quickstart for exposing the current platform stack on a public host.

## What It Includes

`deploy/public-stack` currently bundles:

- `platform-api`
- `postgres`
- `relay`
- `platform-console-gateway`
- `caddy` edge ingress

It is the recommended starting point when you want a single public ingress shape rather than composing `deploy/platform` and `deploy/relay` manually.

## Before You Start

Prepare:

- a Linux host with Docker and Docker Compose
- a public DNS name or stable public IP
- open ports `80` and `443`
- a persistent volume policy for PostgreSQL, relay, and gateway data
- a strong `PLATFORM_ADMIN_API_KEY`

Current limitation:

- `platform-console` frontend is not bundled into `public-stack` yet
- the stack exposes the operator gateway API under `/gateway/*`

## Quickstart

1. Copy `deploy/public-stack/.env.example` to `deploy/public-stack/.env`
2. Set:
   - `PUBLIC_SITE_ADDRESS`
   - `PLATFORM_ADMIN_API_KEY`
   - `IMAGE_REGISTRY` and `IMAGE_TAG` if pulling published images
3. Start the stack:

```bash
docker compose -f deploy/public-stack/docker-compose.yml --env-file deploy/public-stack/.env up -d
```

4. Verify public health:

```bash
curl -fsS "${PUBLIC_SITE_ADDRESS%/}/healthz"
curl -fsS "${PUBLIC_SITE_ADDRESS%/}/platform/healthz"
curl -fsS "${PUBLIC_SITE_ADDRESS%/}/relay/healthz"
curl -fsS "${PUBLIC_SITE_ADDRESS%/}/gateway/healthz"
```

## Public Routes

- `/platform/*` -> `platform-api`
- `/relay/*` -> `relay`
- `/gateway/*` -> `platform-console-gateway`

## Bootstrap And Visibility Defaults

Current defaults are production-oriented:

- `ENABLE_BOOTSTRAP_SELLERS=false`
- no pre-approved demo sellers are exposed

If you need prewired demo actors, use `deploy/all-in-one` instead of turning `public-stack` into a demo profile.

## Operator Bootstrap Checklist

After the stack is healthy:

1. initialize the gateway local secret store
2. store `PLATFORM_ADMIN_API_KEY` through the gateway session flow
3. verify an authenticated proxy call succeeds
4. create or approve the first real seller and subagent
5. confirm the catalog stays empty until both seller and subagent are `approved + enabled`

Minimal gateway flow:

```bash
BASE="${PUBLIC_SITE_ADDRESS%/}"
TOKEN=$(curl -fsS -X POST "$BASE/gateway/session/setup" \
  -H 'content-type: application/json' \
  -d '{"passphrase":"change-me-now"}' | jq -r '.token')

curl -fsS -X PUT "$BASE/gateway/credentials/platform-admin" \
  -H 'content-type: application/json' \
  -H "x-platform-console-session: $TOKEN" \
  -d "{\"api_key\":\"$PLATFORM_ADMIN_API_KEY\"}"

curl -fsS "$BASE/gateway/proxy/v1/admin/subagents" \
  -H "x-platform-console-session: $TOKEN"
```

## Smoke Validation

Recommended checks:

- deploy config resolution:
  - `npm run test:deploy:config`
- source-build public stack smoke:
  - `npm run test:public-stack-smoke`
- published-image smoke:
  - run the `Published Images Smoke` workflow

`public-stack-smoke` validates:

- edge ingress health
- platform / relay / gateway route health
- gateway session setup
- admin credential persistence through the gateway
- at least one proxied admin API call

Current default image namespace in this repository is:

- `ghcr.io/hejiajiudeeyu`
