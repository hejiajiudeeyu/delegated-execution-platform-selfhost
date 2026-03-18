# Product Readiness Boundary

This document defines the current boundary between:

- `pilot-ready`: can be used in a controlled self-hosted environment
- `production-ready`: can be treated as a stable directly deployable product baseline

## Current Position

The repository is currently:

- `pilot-ready` for controlled self-hosted use
- not yet `production-ready`

Current strengths:

- protocol main path is implemented
- buyer / seller / platform reference implementations are present
- local end-user bootstrap path exists
- public operator stack exists
- formal seller/subagent onboarding and hidden review tests exist

## Pilot-Ready Means

The following are supported today:

- local end-user setup through `npm run ops -- bootstrap`
- controlled seller/subagent onboarding with admin approval
- self-hosted deployment using `deploy/platform`, `deploy/public-stack`, or `deploy/all-in-one`
- source-build smoke validation
- local release-shaped image validation
- published image validation through the GHCR-facing smoke workflow

Good-fit use cases:

- internal evaluation
- protocol integration
- demos
- small self-hosted pilots with an operator in the loop

## Not Yet Production-Ready

The following still block a stronger production claim:

1. key lifecycle is incomplete
   - API key rotation and revocation are still pending
   - signer key rotation windows are still pending
2. observability is incomplete
   - no Prometheus-ready metrics
   - no tracing
   - no dashboard-ready time-series views
3. secret management is still local-first
   - current baseline uses encrypted local files
   - no OS keychain or managed secret backend yet
4. published image support is present, but long-running external-environment stability still needs more burn-in
5. `platform-console` frontend is not yet bundled into `deploy/public-stack`

## Direct User Promise Today

Current user promise:

- an AI can help a user deploy the local client from the repository checkout
- an operator can deploy the public stack with Docker Compose
- both still assume a technically capable operator is present

Current non-promise:

- zero-touch package-manager distribution for end users
- turnkey SaaS-grade hosted operations
- managed secret lifecycle
- full production observability

## Exit To Production-Ready

The minimum remaining bar for a stronger production claim is:

1. key rotation and revocation
2. Prometheus/tracing/time-series observability
3. stronger published-image validation in real external environments
4. clearer operator-facing public console packaging
