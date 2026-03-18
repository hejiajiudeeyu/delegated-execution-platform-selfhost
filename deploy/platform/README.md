# Platform Deployment

1. `cp .env.example .env`
2. Set at least:
   - `TOKEN_SECRET`
   - `PLATFORM_ADMIN_API_KEY`
   - `IMAGE_REGISTRY` / `IMAGE_TAG` if you are pulling published images
   - `TRANSPORT_BASE_URL` when the platform must issue relay-backed delivery metadata or run hidden review tests
3. `docker compose up -d --build`
4. Check `http://127.0.0.1:${PORT:-8080}/healthz`

This profile deploys `platform-api` with PostgreSQL on a single host.

Important defaults:

- `deploy/platform` is production-oriented and now defaults to `ENABLE_BOOTSTRAP_SELLERS=false`
- it does **not** expose a pre-approved demo seller unless you explicitly opt in
- for local/demo bootstrap sellers, prefer `deploy/all-in-one` or set:
  - `ENABLE_BOOTSTRAP_SELLERS=true`
  - `BOOTSTRAP_SELLER_ID`
  - `BOOTSTRAP_SUBAGENT_ID`
  - `BOOTSTRAP_TASK_DELIVERY_ADDRESS`
