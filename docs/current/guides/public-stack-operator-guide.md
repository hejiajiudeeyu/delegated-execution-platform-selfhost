# Public Stack Operator Guide

This guide is the operator-facing quickstart for exposing the current platform stack on a public host.

## What It Includes

`deploy/public-stack` currently bundles:

- `platform-api`
- `postgres`
- `relay`
- `platform-console-gateway`
- `platform-console` static UI served by `platform-console-gateway`
- `caddy` edge ingress

It is the recommended starting point when you want a single public ingress shape rather than composing `deploy/platform` and `deploy/relay` manually.

## Before You Start

Prepare:

- a Linux host with Docker and Docker Compose
- a public DNS name or stable public IP
- open ports `80` and `443`
- a persistent volume policy for PostgreSQL, relay, and gateway data
- a strong `PLATFORM_ADMIN_API_KEY`

Operator surface:

- `platform-console` static UI is bundled into `public-stack` through
  `platform-console-gateway`
- the stack exposes the operator UI under `/console/`
- the stack exposes the operator gateway API under `/gateway/*`

## Quickstart

1. Copy `deploy/public-stack/.env.example` to `deploy/public-stack/.env`
2. Set:
   - `PUBLIC_SITE_ADDRESS`
   - `PLATFORM_ADMIN_API_KEY`
   - `IMAGE_REGISTRY` and `IMAGE_TAG` if pulling published images
     - use a concrete release tag such as `v0.1.x`; do not rely on `latest` for a first public install
     - the release workflow publishes `latest` only for `v*` release tags
     - check published tags with:
       `curl -fsS https://ghcr.io/v2/hejiajiudeeyu/rsp-platform/tags/list`
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
curl -fsS "${PUBLIC_SITE_ADDRESS%/}/console/"
```

## Public Routes

- `/platform/*` -> `platform-api`
- `/relay/*` -> `relay`
- `/gateway/*` -> `platform-console-gateway`
- `/console/*` -> `platform-console-gateway` static console assets

## Bootstrap And Visibility Defaults

Current defaults are production-oriented:

- `ENABLE_BOOTSTRAP_RESPONDERS=false`
- no pre-approved demo responders are exposed

If you need prewired demo actors, use `deploy/all-in-one` instead of turning `public-stack` into a demo profile.

## Operator Bootstrap Checklist

After the stack is healthy:

1. open `${PUBLIC_SITE_ADDRESS%/}/console/`
2. initialize the gateway local secret store
3. store `PLATFORM_ADMIN_API_KEY` through the gateway session flow
4. verify an authenticated proxy call succeeds
5. create or approve the first real responder and hotline
6. confirm the catalog stays empty until both responder and hotline are `approved + enabled`

Minimal gateway flow:

```bash
BASE="${PUBLIC_SITE_ADDRESS%/}"
TOKEN=$(curl -fsS -X POST "$BASE/gateway/session/setup" \
  -H 'content-type: application/json' \
  -d "{\"passphrase\":\"change-me-now\",\"bootstrap_secret\":\"$PLATFORM_CONSOLE_BOOTSTRAP_SECRET\"}" | jq -r '.token')

curl -fsS -X PUT "$BASE/gateway/credentials/platform-admin" \
  -H 'content-type: application/json' \
  -H "x-platform-console-session: $TOKEN" \
  -d "{\"api_key\":\"$PLATFORM_ADMIN_API_KEY\"}"

curl -fsS "$BASE/gateway/proxy/v2/admin/hotlines" \
  -H "x-platform-console-session: $TOKEN"
```

## Lost Passphrase Recovery

If the console passphrase is lost, the encrypted store can be reset from the browser without SSH:

1. open `${PUBLIC_SITE_ADDRESS%/}/console/`, go to `Settings -> Session & Unlock`
2. expand `Lost passphrase? Reset the gateway store`
3. enter the deployment-held `PLATFORM_CONSOLE_BOOTSTRAP_SECRET`, a new passphrase, and type `RESET` to confirm

The reset is destructive: secrets encrypted with the old passphrase — including the saved
`PLATFORM_ADMIN_API_KEY` — cannot be preserved and must be re-entered under
`Settings -> Gateway Credentials` afterwards. Equivalent API call:

```bash
curl -fsS -X POST "$BASE/gateway/session/recover" \
  -H 'content-type: application/json' \
  -d "{\"passphrase\":\"new-pass-here\",\"bootstrap_secret\":\"$PLATFORM_CONSOLE_BOOTSTRAP_SECRET\",\"confirm_reset\":true}"
```

Keep the console passphrase in the deployment handoff so recovery stays an exception, not the normal unlock path.

## Alerts

Without this configured, the platform never tells you anything: every problem
waits until you happen to open the console. Set it up in
`Settings -> Alerts`, which needs no SSH.

**Webhook** — the platform POSTs one JSON object per alert to a URL you
control (a Feishu/WeCom bot, Bark, ntfy, or your own script). Set a signing
secret and each POST carries `x-delexec-signature: sha256=<hmac>` over the raw
body, so the endpoint can reject anything that is not from this platform.
Alerts fire when a problem appears, again every `renotify_hours` while it is
still open, and once more when it clears — silence after an alert always means
resolved, never forgotten. Use `Send a test alert` before you need it: a
configuration that has never delivered anything should not be trusted.

Alerts are derived from the same attention feed the console home page shows.
They are not a second opinion about what counts as a problem.

**Liveness ping (dead man's switch)** — the alert loop runs inside
platform-api, so it cannot report platform-api being down. Point
`liveness_url` at an external heartbeat monitor (Healthchecks.io, an Uptime
Kuma push monitor, a BetterStack heartbeat); the platform GETs it on a
schedule and the monitor alarms when the pings stop. **This is the only part
of the setup that covers a platform outage** — the 2026-07-04 incident lasted
5.5 hours and was found by walking into it. Configure both legs, not just the
webhook.

Delivery failures are recorded and shown on the same page. A red row there
means alerts are not reaching you, which is operationally the same as having
no alerts at all.

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
- bundled `/console/` route reachability
- gateway session setup
- admin credential persistence through the gateway
- at least one proxied admin API call

Current default image namespace in this repository is:

- `ghcr.io/hejiajiudeeyu`

The public-stack image set is:

- `rsp-platform`
- `rsp-relay`
- `rsp-gateway`

These three GHCR packages must be public before anonymous operator pulls can work.
The `rsp-caller` and `rsp-responder` images are not part of the public-stack release path; they are only referenced by legacy/internal compose profiles.
