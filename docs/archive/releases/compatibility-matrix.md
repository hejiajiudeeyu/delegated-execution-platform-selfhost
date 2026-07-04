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
