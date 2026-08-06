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
| `v0.4.2` | `v0.4.2` | `v0.4.2` | `v0.4.2` | Console rebuild UI: attention home page and `/calls/:id` detail. Fixes a dev-only bug that made the console dev server unable to reach any gateway, and English axis reasons in a Chinese UI. Drop-in; console ships in the gateway image |
| `v0.4.3` | `v0.4.3` | `v0.4.3` | `v0.4.3` | A failed console unlock no longer returns the raw AES-GCM error (`Unsupported state or unable to authenticate data`), which read as a broken gateway; pasting the deployment key into the passphrase box gets its own message pointing at the reset flow. Drop-in |
| `v0.4.4` | `v0.4.4` | `v0.4.4` | `v0.4.4` | Progress observations (FR-036): devices narrate input-fetch/execute/upload with percent+message, the `/calls/:id` timeline shows them, progressing calls stop tripping the stuck guardrail, and the responder's long-rejected `SOFT_TIMEOUT` finally lands. Needs `@delexec/contracts@0.1.5`; device beats need `@delexec/ops` ≥ 0.1.8. Drop-in |
| `v0.4.5` | `v0.4.5` | `v0.4.5` | `v0.4.5` | Alerts leave the process (FR-066): webhook delivery with optional HMAC signing, open/repeat/close semantics, visible delivery failures, and a liveness ping that is the only cover for a platform outage. Offline detection 180s → 120s (NFR-R05). Drop-in; alerting stays off until a webhook URL is saved |
| `v0.4.6` | `v0.4.6` | `v0.4.6` | `v0.4.6` | A Call pins the contract it was made under (FR-014): approval freezes the hotline's contract into a digest-carrying version, the binding rides the signed task token and delivery metadata, and `/calls/:id` shows the pinned version rather than the current one. Needs `@delexec/contracts@0.1.7`. Drop-in; calls created earlier report that they predate versioning |
| `v0.4.7` | `v0.4.7` | `v0.4.7` | `v0.4.7` | A hotline must be a contract before it can be published (FR-010/FR-013): approval requires both schemas, a worked example each way, a statement of what the hotline is not for, and examples that satisfy their own schemas. **Behaviour change at approval** — nothing is disabled, but an incomplete hotline can no longer be re-approved. Needs `@delexec/contracts@0.1.8` |
