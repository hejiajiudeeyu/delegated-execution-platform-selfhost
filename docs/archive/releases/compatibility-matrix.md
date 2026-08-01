# Compatibility Matrix

For L0, one repository release maps to one coordinated image tag set.
Mixed-version deployments are not part of the support promise.

| Repository Release | Platform Image | Gateway Image | Relay Image | Support Notes |
| --- | --- | --- | --- | --- |
| `v0.1.0` | `v0.1.0` | `v0.1.0` | `v0.1.0` | Baseline L0 coordinated self-hosted release |
| `v0.1.3` | `v0.1.3` | `v0.1.3` | `v0.1.3` | Console static entry fix for nginx `/console/` subpath |
| `v0.1.4` | `v0.1.4` | `v0.1.4` | `v0.1.4` | Console sidebar layout, human-readable panels, unlock UI fixes |
| `v0.1.5` | `v0.1.5` | `v0.1.5` | `v0.1.5` | Console review queue actions; production rolled gateway only (platform/relay stayed on `v0.1.2`); notes backfilled |
| `v0.1.6` | `v0.1.6` | `v0.1.6` | `v0.1.6` | Console lost-passphrase recovery + state-driven session UI; contracts `^0.1.3` repin fixes source-built boot; 500 diagnostics |
| `v0.1.7` | `v0.1.7` | `v0.1.7` | `v0.1.7` | Console gateway-API subpath fix — console now actually works behind `/console/` + `/gateway/` edges |
| `v0.2.0` | `v0.2.0` | `v0.2.0` | `v0.2.0` | Operator console rebuilt as a fingerprinted React SPA; production rolled gateway only (platform/relay stayed on `v0.1.2`); matrix row backfilled 2026-08-01 |
| `v0.3.0` | `v0.3.0` | `v0.3.0` | `v0.3.0` | **Breaking**: relay requires `RELAY_ADMIN_TOKEN`+`RELAY_TOKEN_SECRET` and refuses to boot without them; anonymous responder enrollment removed. Adds visibility leases, device version/capacity reporting, the artifact channel and `/buildz` build facts. Roll all three together |
| `v0.4.0` | `v0.4.0` | `v0.4.0` | `v0.4.0` | **Exposure change**: relay business routes return to the public edge — verify `RELAY_ADMIN_TOKEN`/`RELAY_TOKEN_SECRET` are real and `RELAY_ALLOW_UNAUTHENTICATED` is unset first. Adds restart reconciliation (`POST /v1/requests/:id/reconcile`, which can refund but never settle) and the console attention/call-detail aggregate reads. Roll all three together |
| `v0.4.1` | `v0.4.1` | `v0.4.1` | `v0.4.1` | Patch: the stuck-call guardrail behind the attention feed had never fired on real data (it read a field no production event carries). Anyone on `v0.4.0` or earlier should assume no stuck call was ever reported. Drop-in |
