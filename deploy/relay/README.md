# Relay Deployment

1. `cp .env.example .env`
2. `docker compose up -d --build`
3. Check `http://127.0.0.1:${PORT:-8090}/healthz`

This profile deploys the shared transport relay used by caller and responder controllers.
