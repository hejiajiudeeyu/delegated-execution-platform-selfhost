# Public Stack Deployment

This profile is the first operator-oriented bundle for exposing the platform on a public host.

It includes:

- `platform-api`
- `postgres`
- `relay`
- `platform-console-gateway`
- `platform-console` static UI served by `platform-console-gateway`
- `edge` (`caddy`) for public ingress and TLS termination

## Quick Start

1. `cp .env.example .env`
2. Set at least:
   - `PUBLIC_SITE_ADDRESS`
   - `TOKEN_SECRET`
   - `PLATFORM_ADMIN_API_KEY`
   - `PLATFORM_CONSOLE_BOOTSTRAP_SECRET`
   - `IMAGE_REGISTRY` / `IMAGE_TAG`
     - use a concrete release tag such as `v0.1.x` for first public pulls
     - `latest` is only published by the Images workflow when a `v*` release tag is pushed
     - check release tags with:
       `curl -fsS https://ghcr.io/v2/hejiajiudeeyu/rsp-platform/tags/list`
3. `docker compose --env-file .env up -d`
4. Check:
   - `GET ${PUBLIC_SITE_ADDRESS%/}/healthz`
   - `GET ${PUBLIC_SITE_ADDRESS%/}/platform/healthz`
   - `GET ${PUBLIC_SITE_ADDRESS%/}/relay/healthz`
   - `GET ${PUBLIC_SITE_ADDRESS%/}/gateway/healthz`
   - `GET ${PUBLIC_SITE_ADDRESS%/}/console/`
5. Continue with the operator guide:
   - `docs/current/guides/public-stack-operator-guide.md`

## Public Routes

- `/platform/*` -> `platform-api`
- `/relay/*` -> `relay`
- `/gateway/*` -> `platform-console-gateway`
- `/console/*` -> `platform-console-gateway` static console assets

## Notes

- `deploy/public-stack` is production-oriented and defaults to `ENABLE_BOOTSTRAP_RESPONDERS=false`
- if you need prewired demo actors, prefer `deploy/all-in-one`
- the gateway uses `DELEXEC_HOME=/var/lib/delexec-ops` inside the container and can read `PLATFORM_ADMIN_API_KEY` from env as a legacy secret source
- first-time `/gateway/session/setup` calls are blocked unless the caller is local or presents `PLATFORM_CONSOLE_BOOTSTRAP_SECRET`
- this compose file is registry-only; it does not depend on local source build context
- this profile pulls only `rsp-platform`, `rsp-relay`, and `rsp-gateway`; caller/responder container images belong to legacy/internal profiles, not the public-stack path
- before a first anonymous pull, the GHCR packages for `rsp-platform`, `rsp-relay`, and `rsp-gateway` must be public
- for public DNS names, let `caddy` terminate TLS via `PUBLIC_SITE_ADDRESS`
- smoke entrypoint: `npm run test:public-stack-smoke`
