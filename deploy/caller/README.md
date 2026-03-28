# Caller Deployment

1. `cp .env.example .env`
2. Set `PLATFORM_API_BASE_URL` to your platform endpoint
3. Set `TRANSPORT_BASE_URL` to your relay endpoint
4. `docker compose up -d --build`
5. Check `http://127.0.0.1:${PORT:-8081}/healthz`

This profile deploys `caller-controller` as a standalone service with SQLite by default and requires an external relay service.
