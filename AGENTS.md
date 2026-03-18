# AGENTS.md

Agent instructions for this repository:

- Primary responsibility: self-hosted operator deployment and server-side platform behavior.
- Primary public artifacts: GHCR images plus compose entrypoints.
- Do not optimize for npm installation of server packages as the normal operator path.
- Route protocol-shape changes to `delegated-execution-protocol`.
- Route end-user CLI and local runtime UX changes to `delegated-execution-client`.

Minimum local validation:

```bash
npm test
npm run test:service:packages
npm run test:deploy:config
npm run test:public-stack-smoke
```
