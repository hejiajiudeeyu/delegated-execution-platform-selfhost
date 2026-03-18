# Deployment Guide

This guide covers the supported deployment shapes for `platform`, `buyer`, and `seller`.

Current protocol/runtime baseline:

- platform returns request-scoped `delivery-meta` with `task_delivery` and `result_delivery`
- seller result mail uses a pure JSON body; buyer-controller parses and verifies it before exposing it upstream
- file outputs may travel as attachments described by signed `artifacts[]`
- `platform_inbox` is reserved for future evolution and is not implemented in current deployments

## Recommended Install Paths

- `platform` and `relay`: prefer Docker/Compose deployment
- `buyer` and `seller` on an end-user machine: prefer the repo-local `npm run ops -- ...` path until npm publish is explicitly completed
- Docker/Compose remains appropriate for CI, local integration, and advanced standalone deployment

## Supported Profiles

- `deploy/platform`: platform API plus PostgreSQL
- `deploy/public-stack`: platform + postgres + relay + operator gateway + edge ingress
- `deploy/ops`: end-user package with buyer always on and seller as an opt-in local role
- `deploy/relay`: shared transport relay
- `deploy/buyer`: standalone buyer controller, SQLite by default
- `deploy/seller`: standalone seller controller deployment profile for operators and CI
- `deploy/all-in-one`: local integration stack

Profile intent:

- `deploy/platform` is production-oriented and does not enable bootstrap demo sellers by default
- `deploy/public-stack` is the first operator-oriented public ingress bundle
- `deploy/all-in-one` remains the preferred local/demo stack when you want prewired bootstrap actors

## Seller CLI Path

Recommended user path:

1. `npm install`
2. `npm run ops -- bootstrap --email you@example.com --platform http://127.0.0.1:8080`
3. If admin approval is not yet available, approve the seller and subagent, then rerun `npm run ops -- bootstrap`
4. `npm run ops -- doctor` / `npm run ops -- debug-snapshot`

Manual fallback path:

1. `npm install`
2. `npm run ops -- setup`
3. `npm run ops -- auth register --email you@example.com --platform http://127.0.0.1:8080`
4. `npm run ops -- add-example-subagent`
5. `npm run ops -- submit-review`
6. `npm run ops -- enable-seller`
7. `npm run ops -- start`
8. `npm run ops -- run-example --text "Summarize this request."`

This path stores local ops state under `~/.delexec`, starts a local supervisor, and manages relay internally.
Local runtime logs are written under `~/.delexec/logs`, and `ops-console` reads logs and debug snapshot data from the supervisor.
`ops-console` also provides a setup wizard that guides the user through buyer registration, official example installation, review submission, seller enablement, and local example self-call.
`ops-console` now also supports a local passphrase-backed unlock flow. Sensitive local credentials are stored in `~/.delexec/secrets.enc.json` rather than browser storage.
`enable-seller` only enables the local seller runtime. Platform review controls catalog visibility and remote availability; it does not prevent the local runtime from starting.

For coding-agent oriented setup and machine-readable bootstrap output, see:

- [coding-agent-onboarding.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/guides/coding-agent-onboarding.md)
- [end-user-ai-deployment-guide.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/guides/end-user-ai-deployment-guide.md)
- [public-stack-operator-guide.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/guides/public-stack-operator-guide.md)

## Image Distribution

Each deploy profile accepts:

- `IMAGE_REGISTRY`
- `IMAGE_TAG`

Default image names:

- `rsp-relay`
- `rsp-platform`
- `rsp-buyer`
- `rsp-seller`

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

Current limitation:

- `platform-console` frontend itself is not bundled into `public-stack` yet; this stack currently exposes the operator gateway API path and core backend services
- the full operator bootstrap flow is documented in [public-stack-operator-guide.md](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/guides/public-stack-operator-guide.md)

Recommended smoke validation split:

- source-build path: `npm run test:compose-smoke`
- public ingress stack path: `npm run test:public-stack-smoke`
- local release-shaped image path: `npm run test:local-images-smoke`
- published-image GHCR path: `npm run test:published-images-smoke`
- manual GHCR validation workflow: `.github/workflows/published-images-smoke.yml`

Current `compose-smoke` runner:
- creates an isolated compose project name per run unless `COMPOSE_PROJECT_NAME` is explicitly set
- validates `docker compose config` before startup
- performs a same-project pre-cleanup so repeated local runs are less flaky
- prewarms required images before `docker compose up`, separating cache hits from explicit pulls
- retries transient `image_pull_failed` startup failures a small number of times (`COMPOSE_IMAGE_PULL_RETRIES`, default `2`)
- emits distinct failure classes for registry auth, image pull, port conflicts, service runtime failure, health timeout, database boot, and business-path regressions

## Relay

The relay is the shared transport runtime between buyer and seller controllers in deployment mode.

For the end-user ops client, relay is started and managed by the local supervisor by default.
Standalone relay deployment is mainly for CI, local integration, and advanced operator-managed environments.

- Buyer and seller both require `TRANSPORT_BASE_URL`
- Hidden admin review tests use `REVIEW_TRANSPORT_BASE_URL` if set; otherwise the platform falls back to `TRANSPORT_BASE_URL`
- The relay can run with SQLite persistence via `RELAY_SQLITE_PATH`
- `local://relay/<receiver>/...` delivery addresses resolve to relay receivers

## Email Transport

`ops-console` now supports a first-party `email` transport option in addition to `local` and `relay_http`.

Transport selection model:

- `local`: default local supervisor-managed relay path
- `relay_http`: external relay endpoint
- `email`: mailbox-backed transport

For `email`, the supported providers in the current codebase are:

- `emailengine`
- `gmail`

Current implementation scope:

- single mailbox / shared mailbox
- polling-based inbox consumption
- signed JSON payload in message body
- artifacts as email attachments
- secrets stored in local encrypted `~/.delexec/secrets.enc.json` when using the console session flow
- legacy `.env.local` fallback remains for CLI-only/bootstrap compatibility until migrated

## Local Secret Storage

Current local file layout for the end-user install path:

- `~/.delexec/ops.config.json`: non-sensitive local runtime config
- `~/.delexec/.env.local`: compatibility env file, progressively de-sensitive
- `~/.delexec/secrets.enc.json`: encrypted secret store unlocked by a local passphrase

Current implementation uses:

- `scrypt` key derivation
- `AES-256-GCM` encrypted payloads
- short-lived local console sessions on top of the decrypted in-memory secrets

This is the current L0/L9 baseline. It is stronger than plaintext env/browser storage, but it is still not an OS keychain-backed secret manager.

Provider references and versions used by the current implementation:

- EmailEngine: [EmailEngine API docs](https://learn.emailengine.app/docs/email-api)
  - docs page currently labels itself `EmailEngine API 2.62.0`
  - repo implementation uses REST `API v1` endpoints under `/v1`
- Gmail: [Gmail API REST reference](https://developers.google.com/workspace/gmail/api/reference/rest)
  - repo implementation uses `gmail/v1`

Implementation details:

- EmailEngine adapter: [index.js](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/packages/transports/emailengine/src/index.js)
- Gmail adapter: [index.js](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/packages/transports/gmail/src/index.js)
- shared email envelope helpers: [index.js](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/packages/transports/email/src/index.js)

Additional setup references:

- [EmailEngine integration notes](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/guides/integrations/emailengine.md)
- [Gmail API integration notes](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/guides/integrations/gmail-api.md)

## Storage Choices

### Platform

- Recommended: PostgreSQL
- Reason: platform state is shared control-plane state and should not depend on single-node SQLite

### Buyer

- Default: SQLite via `SQLITE_DATABASE_PATH`
- Recommended upgrade path: set `DATABASE_URL` when buyer must survive container replacement or run with external operations tooling
- Precedence: `DATABASE_URL` overrides `SQLITE_DATABASE_PATH`

### Seller

- Default: SQLite via `SQLITE_DATABASE_PATH`
- Recommended upgrade path: set `DATABASE_URL` for multi-instance or persistent production runtime
- Precedence: `DATABASE_URL` overrides `SQLITE_DATABASE_PATH`

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
