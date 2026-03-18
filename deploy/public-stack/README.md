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

- `deploy/public-stack` is production-oriented and defaults to `ENABLE_BOOTSTRAP_SELLERS=false`
- if you need prewired demo actors, prefer `deploy/all-in-one`
- the gateway uses `DELEXEC_HOME=/var/lib/delexec-ops` inside the container and can read `PLATFORM_ADMIN_API_KEY` from env as a legacy secret source
- first-time `/gateway/session/setup` calls are blocked unless the caller is local or presents `PLATFORM_CONSOLE_BOOTSTRAP_SECRET`
- this compose file is registry-only; it does not depend on local source build context
- for public DNS names, let `caddy` terminate TLS via `PUBLIC_SITE_ADDRESS`
- smoke entrypoint: `npm run test:public-stack-smoke`
