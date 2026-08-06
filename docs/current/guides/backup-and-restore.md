# Backup and Restore

`scripts/stack-backup.mjs` backs up, verifies and restores the `public-stack`
data plane. It needs nothing installed on the host beyond Docker.

```bash
node scripts/stack-backup.mjs backup  --project public-stack --out ~/backups/delexec
node scripts/stack-backup.mjs verify  --backup ~/backups/delexec/<stamp> --deep
node scripts/stack-backup.mjs restore --backup ~/backups/delexec/<stamp> --project <target>
```

## What a backup contains

| Surface | Archived as | Losing it means |
|---|---|---|
| PostgreSQL | `postgres.sql.gz` (`pg_dump`) | every call, device, hotline, ledger entry and alert config is gone |
| Artifact bytes | `artifacts.tar.gz` | committed artifacts still exist as descriptors with checksums, and cannot be fetched |
| Gateway `DELEXEC_HOME` | `gateway.tar.gz` | the console's encrypted credential store is gone; only a bootstrap reset can open it |
| Relay sqlite | `relay.tar.gz` | in-flight task envelopes are gone; those calls have to be resubmitted |

PostgreSQL is dumped, never volume-copied — a live data directory is not safe
to archive. The relay's sqlite is copied crash-consistently (db plus `-wal`
and `-shm`); sqlite replays the WAL when it opens the file.

## What a backup deliberately does not contain

**`.env`.** It holds `TOKEN_SECRET`, `PLATFORM_ADMIN_API_KEY`,
`RELAY_ADMIN_TOKEN`, `RELAY_TOKEN_SECRET` and
`PLATFORM_CONSOLE_BOOTSTRAP_SECRET`. Copying it into every backup multiplies
the number of places those secrets exist, and backups get copied around.
Keep it yourself, encrypted, alongside the backups but not inside them.

Also absent: host nginx configuration, TLS certificates, and container images
(pulled from the registry by the tags recorded in `manifest.json`).

The backup is still secret material regardless — the dump contains API keys and
the gateway archive contains the encrypted credential store. Files are written
`0600` inside a `0700` directory.

## Backing up a remote host

`--docker` prefixes every docker invocation, so a remote stack needs no code
deployed to it:

```bash
node scripts/stack-backup.mjs backup --project public-stack \
  --out ~/backups/delexec --docker "ssh aliyun-ecs sudo -n docker"
```

Arguments pass through a remote shell, so this form requires that no argument
contain spaces. Nothing the script builds does.

## Verifying

`verify` checks the manifest, every file's size and sha256, and then the check
this tool exists for: **every artifact the database calls `committed` must have
bytes present, of the recorded size, hashing to the recorded checksum.** The
platform refuses to call an artifact delivered when its checksum does not match;
a backup that quietly dropped the bytes would reintroduce that lie one layer
down. Bytes with no database record are reported as warnings, not blockers.

`verify --deep` additionally loads the dump into a throwaway PostgreSQL and
re-derives the artifact index from it. This is the only check that can tell you
the dump is loadable at all — file presence and checksums prove the bytes
survived the trip and say nothing about whether PostgreSQL will accept them. It
also compares the index in the dump against the manifest, which catches a dump
and archives that were not taken from the same state.

Run `--deep` at least on the backups you intend to rely on.

## Restoring

```bash
node scripts/stack-backup.mjs restore --backup <dir> --project <target>
```

Restore refuses to write into volumes that already hold data and names the
volume that stopped it. Use a fresh project name to rehearse; `--force`
overwrites and destroys the current contents.

It restores the three archived volumes and loads the dump into a new PostgreSQL
volume, created with the password `stack-backup-restore`. Bring your `.env`,
make `DATABASE_URL` agree with that password (or change the password once the
stack is up), then:

```bash
docker compose -p <target> -f deploy/public-stack/docker-compose.yml --env-file .env up -d
```

## What to expect when restoring with new secrets

Restoring to a host where you generate a fresh `.env` works, with consequences
worth knowing before you are in the middle of an incident:

- **The console is locked, not uninitialized.** `GET /gateway/session` reports
  `configured: true, setup_required: false, locked: true`. That is how you tell
  the credential store came back. `setup_required: true` means the gateway
  archive did not make it.
- **The console's stored operator API key is the old one.** It was encrypted
  under the previous deployment, and the platform now honours the
  `PLATFORM_ADMIN_API_KEY` in the `.env` you brought — so after unlocking the
  console, re-record the admin key.
- **Every issued relay receiver token stops validating**, because they are HMAC
  signed with `RELAY_TOKEN_SECRET`. Devices need fresh tokens.
- **Issued task tokens stop validating** for the same reason (`TOKEN_SECRET`).
  They are short-lived, so this matters only for calls in flight.

Carrying the original `.env` avoids all four.

## A note on `PLATFORM_ADMIN_API_KEY`

Until 2026-08-06 the key in `.env` was silently ignored on any stack that
already had persisted state: hydration replaced the whole API-key map with the
snapshot's copy, so only the key baked in when the database was first empty
still authenticated. That made a restored stack unadministrable with the `.env`
its operator actually held, and made rotating the key a no-op that looked like
it worked. A stated key now wins over the snapshot and revokes the previous one.
An unset key still changes nothing — the fallback is random per boot and would
otherwise revoke the working key on every restart.

## Rehearsal

A restore is only real once it has been rehearsed. The 2026-08-06 rehearsal —
production snapshot restored onto a separate machine, all six artifacts fetched
back through the restored platform with matching checksums — is recorded in the
fourth repository at
`.trellis/tasks/08-05-daily-usability-sprint/unit-3-backup-restore.md`.
