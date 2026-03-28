# All-In-One Deployment

1. `cp .env.example .env`
2. `docker compose up -d --build`
3. Check:
   - `http://127.0.0.1:8080/healthz`
   - `http://127.0.0.1:8081/healthz`
   - `http://127.0.0.1:8082/healthz`

This profile starts PostgreSQL, platform, caller, and responder together for local integration and demos.
Current runtime behavior uses request-scoped `delivery-meta`; in email mode, responder returns a pure JSON result body and optional file artifacts as attachments validated by caller-controller.
