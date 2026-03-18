# Ops Deployment

This compose profile is for local development, demo, and advanced self-managed use.
It is no longer the primary install path for the end-user ops client.

For end-user buyer/seller install, prefer:

1. `npm install`
2. `npm run ops -- bootstrap --email you@example.com --platform http://127.0.0.1:8080`
2. If you want a custom worker instead of the built-in example, use:
   `npm run ops -- add-subagent --type process --subagent-id local.echo.v1 --cmd "node worker.js"`
3. `npm run ops -- doctor` / `npm run ops -- debug-snapshot`

This path starts a local supervisor that manages buyer and optional seller together, and in local transport mode it launches relay as a separate process instead of importing relay source directly.
Runtime logs are written to `~/.delexec/logs` and can be inspected from `ops-console` or `debug-snapshot`.
`ops-console` now provides a setup wizard for the local buyer/seller onboarding flow, so end users do not need to memorize the full step order.

Relay launch note:
- `ops` prefers an external relay process boundary now
- set `OPS_RELAY_BIN` and optional `OPS_RELAY_ARGS` when you want the supervisor to launch a custom relay command
- when runtime transport is `relay_http`, the supervisor uses the configured remote relay endpoint and does not need to manage a local relay process

Compose profile behavior:
- `buyer-controller` is always on
- `relay` is always on
- `seller-controller` is optional and starts only when you enable the `seller` profile

Docker Compose Quick Start:
The following steps apply only to the compose profile under `deploy/ops`.
1. `cp .env.example .env`
2. Set `PLATFORM_API_BASE_URL`
3. Start buyer mode: `docker compose up -d --build`
4. Enable local seller later: `docker compose --profile seller up -d seller-controller`

Compose API key bootstrap:
1. Start `platform-api`
2. Run `npm run ops:auth -- register --email you@example.com --platform http://127.0.0.1:8080`
3. The command writes `~/.delexec/.env.local` with:
   - `PLATFORM_API_BASE_URL`
   - `BUYER_PLATFORM_API_KEY`
   - `PLATFORM_API_KEY`
   - `BUYER_CONTACT_EMAIL`
4. Restart `buyer-controller` if it was already running so it picks up the new env file

Notes:
- Use `BUYER_PLATFORM_API_KEY` after registering the buyer account
- user-facing setup should prefer the unified `ops` supervisor instead of directly managing `seller-controller`
- The intended UX is a single user console where buyer is default and seller is an opt-in role
- Current protocol baseline uses request-scoped `delivery-meta` with `task_delivery` and `result_delivery`; email-mode results are pure JSON bodies with optional signed artifact metadata
