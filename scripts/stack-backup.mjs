#!/usr/bin/env node
//
// Backup, verify and restore for the public-stack data plane.
//
// Why this exists: the stack had no backup tooling at all, only a checklist
// printer in the fourth repo that named `.env` and a postgres dump. That
// checklist covers one of four stateful surfaces. Restoring from it would
// bring back a database in which every committed artifact descriptor carries a
// checksum and points at bytes that no longer exist — a delivered result you
// cannot fetch. This project spends a lot of effort making sure a checksum
// mismatch can never be called `delivered`; a backup that silently drops the
// bytes reintroduces exactly that lie one layer down.
//
// The four surfaces:
//
//   postgres  — the platform's entire domain state lives in a single JSON
//               snapshot row (service_state_snapshots) plus the billing
//               ledger tables. Dumped with pg_dump, never tarred: a live
//               postgres data directory is not safe to copy.
//   artifacts — the bytes themselves, one flat file per artifact id.
//   gateway   — DELEXEC_HOME: the console's encrypted operator credential
//               store. Losing it means the restored console is locked and
//               only the bootstrap reset path can open it.
//   relay     — in-flight task envelopes (sqlite).
//
// What is deliberately NOT in a backup: `.env`. It holds TOKEN_SECRET,
// PLATFORM_ADMIN_API_KEY, the relay tokens and the console bootstrap secret.
// Copying it into every backup artifact multiplies the number of places those
// secrets exist. Restore asks the operator to supply it out of band instead,
// and refuses to guess.
//
// The backup is still secret material even so — the postgres dump contains API
// keys and the gateway tar contains the encrypted credential store. Files are
// written 0600 inside a 0700 directory and the manifest says so out loud.
//
// Usage:
//   node scripts/stack-backup.mjs backup  --project public-stack --out DIR
//   node scripts/stack-backup.mjs verify  --backup DIR [--deep]
//   node scripts/stack-backup.mjs restore --backup DIR --project TARGET [--force]
//
// `--docker` lets every docker invocation be prefixed, which is how this runs
// against a remote host without installing anything there:
//   --docker "sudo -n docker"
//   --docker "ssh aliyun-ecs sudo -n docker"
// (arguments are passed through a remote shell, so none of them may contain
// spaces — none of the ones this script builds do.)

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const MANIFEST_NAME = "manifest.json";
const MANIFEST_FORMAT_VERSION = 1;
const PLATFORM_SERVICE_NAME = "platform-api";
const SNAPSHOT_TABLE = "service_state_snapshots";

// Volume suffix -> file it is archived into. The compose project prefixes each
// name, so the real volume is `<project>_public-stack-<suffix>-data`.
const VOLUME_ARCHIVES = [
  { key: "artifacts", volumeSuffix: "artifact", file: "artifacts.tar.gz" },
  { key: "gateway", volumeSuffix: "gateway", file: "gateway.tar.gz" },
  { key: "relay", volumeSuffix: "relay", file: "relay.tar.gz" }
];

const POSTGRES_DUMP_FILE = "postgres.sql.gz";

function usage() {
  console.log(`stack-backup — public-stack data plane backup / verify / restore

commands:
  backup   --project <name> --out <dir> [--docker <cmd>] [--helper-image <img>]
  verify   --backup <dir> [--deep] [--docker <cmd>]
  restore  --backup <dir> --project <name> [--force] [--docker <cmd>]

verify checks the manifest, the file checksums, and that every artifact the
database calls committed has bytes with a matching size and sha256.
verify --deep additionally loads the dump into a throwaway postgres and
re-derives that index from it, which is the only way to learn that the dump
is actually loadable.`);
}

function parseArgs(argv) {
  const first = argv[0] || null;
  const args = {
    command: first === "--help" || first === "-h" ? "help" : first,
    project: null,
    out: null,
    backup: null,
    docker: "docker",
    helperImage: "postgres:16-alpine",
    deep: false,
    force: false,
    json: false
  };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    const take = () => {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error(`${value} requires a value`);
      }
      index += 1;
      return next;
    };
    if (value === "--project") args.project = take();
    else if (value === "--out") args.out = take();
    else if (value === "--backup") args.backup = take();
    else if (value === "--docker") args.docker = take();
    else if (value === "--helper-image") args.helperImage = take();
    else if (value === "--deep") args.deep = true;
    else if (value === "--force") args.force = true;
    else if (value === "--json") args.json = true;
    else if (value === "--help" || value === "-h") args.command = "help";
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

// ------------------------------------------------------------------ docker

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// When the docker command is an ssh invocation, everything after it is joined
// and re-parsed by a remote shell, so our arguments have to survive that pass.
// Local invocations go straight to execve and must not be quoted.
function dockerParts(dockerCommand, args) {
  const parts = dockerCommand.trim().split(/\s+/);
  const bin = parts[0];
  const prefix = parts.slice(1);
  const remote = path.basename(bin) === "ssh";
  return { bin, argv: [...prefix, ...(remote ? args.map(shellQuote) : args)] };
}

function docker(dockerCommand, args, { input = null, allowFailure = false } = {}) {
  const { bin, argv } = dockerParts(dockerCommand, args);
  const result = spawnSync(bin, argv, {
    encoding: "utf8",
    input: input === null ? undefined : input,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(`${bin} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-5).join("\n");
    throw new Error(`docker ${args.join(" ")} exited ${result.status}\n${detail}`);
  }
  return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

// Streams docker stdout through gzip into `destination`, hashing the compressed
// bytes on the way past so the manifest checksum costs no extra read.
async function dockerStreamToGzip(dockerCommand, args, destination) {
  const { bin, argv } = dockerParts(dockerCommand, args);
  const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const hash = crypto.createHash("sha256");
  const gzip = zlib.createGzip();
  gzip.on("data", (chunk) => hash.update(chunk));

  const out = fs.createWriteStream(destination, { mode: 0o600 });
  const streamed = pipeline(child.stdout, gzip, out);

  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker ${args.join(" ")} exited ${code}\n${stderr.trim().split("\n").slice(-5).join("\n")}`));
    });
  });

  await Promise.all([streamed, exited]);
  return { sha256: hash.digest("hex"), size_bytes: fs.statSync(destination).size };
}

function sha256OfFile(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

// ------------------------------------------------------------------ discovery

function volumeName(project, suffix) {
  return `${project}_public-stack-${suffix}-data`;
}

function listVolumes(dockerCommand) {
  return docker(dockerCommand, ["volume", "ls", "--format", "{{.Name}}"])
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function findPostgresContainer(dockerCommand, project) {
  const names = docker(dockerCommand, ["ps", "--format", "{{.Names}}"])
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const expected = `${project}-postgres-1`;
  if (names.includes(expected)) {
    return expected;
  }
  const fallback = names.find((name) => name.startsWith(`${project}-postgres`));
  if (fallback) {
    return fallback;
  }
  throw new Error(
    `no running postgres container for project '${project}' (looked for ${expected}); ` +
      `a dump needs the database running — start the stack first`
  );
}

function containerEnv(dockerCommand, container) {
  const raw = docker(dockerCommand, ["inspect", container, "--format", "{{json .Config.Env}}"]).stdout.trim();
  const env = {};
  for (const entry of JSON.parse(raw)) {
    const separator = entry.indexOf("=");
    if (separator > 0) {
      env[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  }
  return env;
}

function serviceImages(dockerCommand, project) {
  const lines = docker(dockerCommand, ["ps", "--format", "{{.Names}}\t{{.Image}}"])
    .stdout.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const images = {};
  for (const line of lines) {
    const [name, image] = line.split("\t");
    if (name.startsWith(`${project}-`)) {
      images[name] = image;
    }
  }
  return images;
}

// ------------------------------------------------------------------ artifact index

// The artifact index is a record of what the database said at backup time:
// every artifact, its lifecycle state, and the size/checksum it claims. It is
// not a second source of truth — `verify --deep` re-derives it from the dump
// and reports any disagreement, which would mean the dump and the archives
// were not taken from the same state.
export function artifactIndexFromSnapshot(snapshot) {
  const entries = snapshot?.artifacts || [];
  return entries
    .map(([artifactId, record]) => ({
      artifact_id: artifactId,
      request_id: record?.request_id ?? null,
      role: record?.role ?? null,
      lifecycle_state: record?.lifecycle_state ?? null,
      size_bytes: record?.size_bytes ?? 0,
      checksum: record?.checksum ?? null
    }))
    .sort((left, right) => left.artifact_id.localeCompare(right.artifact_id));
}

function readSnapshotFromPostgres(dockerCommand, container, env) {
  const user = env.POSTGRES_USER || "croc";
  const database = env.POSTGRES_DB || "croc";
  const result = docker(
    dockerCommand,
    [
      "exec",
      container,
      "psql",
      "-U",
      user,
      "-d",
      database,
      "-tAc",
      `SELECT COALESCE(state_json::text,'null') FROM ${SNAPSHOT_TABLE} WHERE service_name='${PLATFORM_SERVICE_NAME}'`
    ],
    { allowFailure: true }
  );
  if (result.status !== 0) {
    return null;
  }
  const text = result.stdout.trim();
  if (!text || text === "null") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ backup

async function commandBackup(args) {
  if (!args.project) throw new Error("--project is required");
  if (!args.out) throw new Error("--out is required");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.resolve(args.out, stamp);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);

  const volumes = listVolumes(args.docker);
  const missing = VOLUME_ARCHIVES.map((entry) => volumeName(args.project, entry.volumeSuffix)).filter(
    (name) => !volumes.includes(name)
  );
  if (missing.length > 0) {
    throw new Error(`volumes not found for project '${args.project}': ${missing.join(", ")}`);
  }

  const pgContainer = findPostgresContainer(args.docker, args.project);
  const pgEnv = containerEnv(args.docker, pgContainer);
  const pgUser = pgEnv.POSTGRES_USER || "croc";
  const pgDatabase = pgEnv.POSTGRES_DB || "croc";

  console.log(`[backup] project=${args.project} -> ${backupDir}`);

  const files = {};

  console.log(`[backup] pg_dump ${pgDatabase} from ${pgContainer}`);
  files[POSTGRES_DUMP_FILE] = await dockerStreamToGzip(
    args.docker,
    ["exec", pgContainer, "pg_dump", "--clean", "--if-exists", "-U", pgUser, "-d", pgDatabase],
    path.join(backupDir, POSTGRES_DUMP_FILE)
  );

  // Read the snapshot straight after the dump so the index describes as close
  // to the same instant as a running system allows.
  const snapshot = readSnapshotFromPostgres(args.docker, pgContainer, pgEnv);
  const artifactIndex = artifactIndexFromSnapshot(snapshot);

  for (const entry of VOLUME_ARCHIVES) {
    const volume = volumeName(args.project, entry.volumeSuffix);
    console.log(`[backup] archive ${volume}`);
    files[entry.file] = await dockerStreamToGzip(
      args.docker,
      ["run", "--rm", "-v", `${volume}:/src:ro`, args.helperImage, "tar", "-C", "/src", "-cf", "-", "."],
      path.join(backupDir, entry.file)
    );
  }

  const manifest = {
    format_version: MANIFEST_FORMAT_VERSION,
    created_at: new Date().toISOString(),
    project: args.project,
    sensitivity: "contains-secrets",
    postgres: {
      container: pgContainer,
      database: pgDatabase,
      user: pgUser,
      dump: POSTGRES_DUMP_FILE,
      dump_flags: ["--clean", "--if-exists"]
    },
    images: serviceImages(args.docker, args.project),
    files: Object.entries(files)
      .map(([name, meta]) => ({ name, ...meta }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    artifact_index: artifactIndex,
    artifact_index_source: snapshot ? "live-database" : "unavailable",
    artifact_counts: {
      total: artifactIndex.length,
      committed: artifactIndex.filter((item) => item.lifecycle_state === "committed").length
    },
    not_included: [
      ".env (TOKEN_SECRET, PLATFORM_ADMIN_API_KEY, RELAY_ADMIN_TOKEN, RELAY_TOKEN_SECRET, PLATFORM_CONSOLE_BOOTSTRAP_SECRET) — supplied by the operator at restore time, on purpose",
      "host nginx configuration and TLS certificates",
      "container images (pulled from the registry by tag; see images)"
    ],
    notes: [
      "postgres is dumped, never volume-copied: a live data directory is not safe to archive",
      "relay sqlite is archived crash-consistently (db + -wal + -shm); sqlite replays the WAL on open",
      "every file in this directory is secret material and is written 0600 inside a 0700 directory"
    ]
  };

  const manifestPath = path.join(backupDir, MANIFEST_NAME);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  console.log(
    `[backup] ok — ${manifest.files.length + 1} files, ` +
      `${manifest.artifact_counts.committed}/${manifest.artifact_counts.total} artifacts committed`
  );
  if (manifest.artifact_index_source === "unavailable") {
    console.log("[backup] warning: could not read the platform state snapshot; verify cannot cross-check artifacts");
  }
  console.log(`[backup] next: node scripts/stack-backup.mjs verify --backup ${backupDir} --deep`);
  return backupDir;
}

// ------------------------------------------------------------------ verify

function readManifest(backupDir) {
  const manifestPath = path.join(backupDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`${MANIFEST_NAME} not found in ${backupDir}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function extractArchive(archivePath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", destination], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`tar failed to extract ${path.basename(archivePath)}: ${(result.stderr || "").trim()}`);
  }
}

// The check this whole unit exists for: bytes for everything the database
// calls committed, with the size and checksum the database recorded.
export function crossCheckArtifacts(artifactIndex, artifactRoot) {
  const blockers = [];
  const warnings = [];
  const committed = artifactIndex.filter((item) => item.lifecycle_state === "committed");
  const seen = new Set();

  for (const item of committed) {
    const bytePath = path.join(artifactRoot, item.artifact_id);
    seen.add(item.artifact_id);
    if (!fs.existsSync(bytePath)) {
      blockers.push(`${item.artifact_id}: committed in the database, no bytes in the backup`);
      continue;
    }
    const stats = fs.statSync(bytePath);
    if (item.size_bytes && stats.size !== item.size_bytes) {
      blockers.push(`${item.artifact_id}: size ${stats.size} != recorded ${item.size_bytes}`);
      continue;
    }
    // The descriptor records the algorithm alongside the value on purpose, so
    // read both: comparing a sha256 digest against a value computed some other
    // way would be a check that always passes for the wrong reason.
    const algorithm = item.checksum?.algorithm ?? null;
    const recorded = item.checksum?.value ?? null;
    if (!recorded) {
      warnings.push(`${item.artifact_id}: committed but the database recorded no checksum`);
    } else if (algorithm !== "sha256") {
      warnings.push(`${item.artifact_id}: checksum algorithm '${algorithm}' cannot be verified here`);
    } else {
      const actual = sha256OfFile(bytePath);
      if (actual !== recorded) {
        blockers.push(`${item.artifact_id}: sha256 ${actual} != recorded ${recorded}`);
      }
    }
  }

  // Orphans are not a restore blocker — the bytes are simply unreferenced —
  // but silence about them would hide a store drifting away from its index.
  const onDisk = fs.existsSync(artifactRoot)
    ? fs.readdirSync(artifactRoot).filter((name) => !name.startsWith("."))
    : [];
  const known = new Set(artifactIndex.map((item) => item.artifact_id));
  for (const name of onDisk) {
    if (!known.has(name)) {
      warnings.push(`${name}: bytes present with no record in the database`);
    }
  }

  return { committed: committed.length, checked: seen.size, on_disk: onDisk.length, blockers, warnings };
}

function waitForPostgres(dockerCommand, container, user, database) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = docker(dockerCommand, ["exec", container, "pg_isready", "-U", user, "-d", database], {
      allowFailure: true
    });
    if (probe.status === 0) {
      return true;
    }
    spawnSync("sleep", ["1"]);
  }
  return false;
}

// Loading the dump into a throwaway database is the only check that can tell
// you the dump is loadable at all. File presence and checksums prove the bytes
// survived the trip; they prove nothing about whether postgres will accept them.
function deepVerify(args, manifest, backupDir) {
  const container = `stack-backup-verify-${crypto.randomBytes(4).toString("hex")}`;
  const image = manifest.images?.[`${manifest.project}-postgres-1`] || args.helperImage;
  const user = manifest.postgres?.user || "croc";
  const database = manifest.postgres?.database || "croc";

  console.log(`[verify] loading the dump into a throwaway ${image}`);
  docker(args.docker, [
    "run",
    "-d",
    "--name",
    container,
    "-e",
    `POSTGRES_USER=${user}`,
    "-e",
    `POSTGRES_DB=${database}`,
    "-e",
    "POSTGRES_PASSWORD=stack-backup-verify",
    image
  ]);

  try {
    if (!waitForPostgres(args.docker, container, user, database)) {
      return { ok: false, blockers: ["throwaway postgres never became ready"], artifact_index: null };
    }

    const dumpSql = zlib.gunzipSync(fs.readFileSync(path.join(backupDir, POSTGRES_DUMP_FILE))).toString("utf8");
    const load = docker(
      args.docker,
      ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database],
      { input: dumpSql, allowFailure: true }
    );
    if (load.status !== 0) {
      return {
        ok: false,
        blockers: [`psql refused the dump: ${(load.stderr || "").trim().split("\n").slice(-3).join(" / ")}`],
        artifact_index: null
      };
    }

    const snapshot = readSnapshotFromPostgres(args.docker, container, {
      POSTGRES_USER: user,
      POSTGRES_DB: database
    });
    return { ok: true, blockers: [], artifact_index: snapshot ? artifactIndexFromSnapshot(snapshot) : null };
  } finally {
    docker(args.docker, ["rm", "-f", container], { allowFailure: true });
  }
}

function commandVerify(args) {
  if (!args.backup) throw new Error("--backup is required");
  const backupDir = path.resolve(args.backup);
  const manifest = readManifest(backupDir);

  const blockers = [];
  const warnings = [];

  console.log(`[verify] ${backupDir} (project=${manifest.project}, created ${manifest.created_at})`);

  for (const file of manifest.files) {
    const filePath = path.join(backupDir, file.name);
    if (!fs.existsSync(filePath)) {
      blockers.push(`${file.name}: missing`);
      continue;
    }
    const stats = fs.statSync(filePath);
    if (stats.size !== file.size_bytes) {
      blockers.push(`${file.name}: size ${stats.size} != manifest ${file.size_bytes}`);
      continue;
    }
    if (sha256OfFile(filePath) !== file.sha256) {
      blockers.push(`${file.name}: sha256 mismatch`);
      continue;
    }
    console.log(`[verify] ok ${file.name} (${stats.size} bytes)`);
  }

  if (blockers.length > 0) {
    return report(false, blockers, warnings, args);
  }

  if (manifest.artifact_index_source !== "live-database") {
    warnings.push("the backup carries no artifact index; artifact bytes cannot be cross-checked");
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-backup-verify-"));
  let crossCheck = null;
  try {
    extractArchive(path.join(backupDir, "artifacts.tar.gz"), path.join(workDir, "artifacts"));
    crossCheck = crossCheckArtifacts(manifest.artifact_index || [], path.join(workDir, "artifacts"));
    blockers.push(...crossCheck.blockers);
    warnings.push(...crossCheck.warnings);
    console.log(
      `[verify] artifacts: ${crossCheck.checked}/${crossCheck.committed} committed cross-checked, ` +
        `${crossCheck.on_disk} byte files present`
    );

    // A restored console nobody can open is a restore that failed, so name the
    // credential store explicitly rather than trusting the tar to be non-empty.
    extractArchive(path.join(backupDir, "gateway.tar.gz"), path.join(workDir, "gateway"));
    const secretsPath = path.join(workDir, "gateway", "secrets.enc.json");
    if (!fs.existsSync(secretsPath) || fs.statSync(secretsPath).size === 0) {
      warnings.push("gateway backup has no secrets.enc.json: the restored console will need a bootstrap reset");
    } else {
      console.log("[verify] ok gateway credential store present");
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  if (args.deep) {
    const deep = deepVerify(args, manifest, backupDir);
    blockers.push(...deep.blockers);
    if (deep.ok) {
      console.log("[verify] ok the dump loads into a clean postgres");
      if (deep.artifact_index && manifest.artifact_index) {
        const fromDump = JSON.stringify(deep.artifact_index);
        const fromManifest = JSON.stringify(manifest.artifact_index);
        if (fromDump !== fromManifest) {
          blockers.push("the artifact index in the dump disagrees with the manifest: dump and archives are not the same state");
        } else {
          console.log(`[verify] ok the dump's own artifact index matches the manifest (${deep.artifact_index.length} entries)`);
        }
      } else if (!deep.artifact_index) {
        warnings.push("the restored dump has no platform state snapshot");
      }
    }
  } else {
    warnings.push("run with --deep to prove the dump actually loads into postgres");
  }

  return report(blockers.length === 0, blockers, warnings, args);
}

function report(ok, blockers, warnings, args) {
  for (const warning of warnings) {
    console.log(`[verify] warn ${warning}`);
  }
  for (const blocker of blockers) {
    console.log(`[verify] BLOCKER ${blocker}`);
  }
  console.log(ok ? "[verify] ok — restorable" : "[verify] fail — do not rely on this backup");
  if (args.json) {
    console.log(JSON.stringify({ ok, blockers, warnings }, null, 2));
  }
  return ok;
}

// ------------------------------------------------------------------ restore

function volumeIsEmpty(dockerCommand, volume, helperImage) {
  const result = docker(
    dockerCommand,
    ["run", "--rm", "-v", `${volume}:/src:ro`, helperImage, "sh", "-c", "ls -A /src | head -1"],
    { allowFailure: true }
  );
  return result.status === 0 && result.stdout.trim() === "";
}

function commandRestore(args) {
  if (!args.backup) throw new Error("--backup is required");
  if (!args.project) throw new Error("--project is required");
  const backupDir = path.resolve(args.backup);
  const manifest = readManifest(backupDir);

  console.log(`[restore] ${backupDir} -> project ${args.project}`);

  const existing = listVolumes(args.docker);
  const targets = VOLUME_ARCHIVES.map((entry) => ({ ...entry, volume: volumeName(args.project, entry.volumeSuffix) }));
  const postgresVolume = volumeName(args.project, "postgres");

  // Restoring over live data is the one irreversible thing this script can do,
  // so it refuses by default and says exactly which volume stopped it.
  const occupied = [...targets.map((entry) => entry.volume), postgresVolume].filter(
    (volume) => existing.includes(volume) && !volumeIsEmpty(args.docker, volume, args.helperImage)
  );
  if (occupied.length > 0 && !args.force) {
    throw new Error(
      `these volumes already hold data: ${occupied.join(", ")}\n` +
        `restore into a fresh project name, or pass --force to overwrite (this destroys the current contents)`
    );
  }

  for (const entry of targets) {
    if (!existing.includes(entry.volume)) {
      docker(args.docker, ["volume", "create", entry.volume]);
    }
    console.log(`[restore] ${entry.file} -> ${entry.volume}`);
    const archive = fs.readFileSync(path.join(backupDir, entry.file));
    const { bin, argv } = dockerParts(args.docker, [
      "run",
      "--rm",
      "-i",
      "-v",
      `${entry.volume}:/dst`,
      args.helperImage,
      "sh",
      "-c",
      args.force ? "rm -rf /dst/* /dst/.[!.]* 2>/dev/null; tar -C /dst -xzf -" : "tar -C /dst -xzf -"
    ]);
    const result = spawnSync(bin, argv, {
      input: archive,
      encoding: "buffer",
      maxBuffer: 512 * 1024 * 1024
    });
    if (result.status !== 0) {
      throw new Error(`restoring ${entry.file} failed: ${(result.stderr || "").toString().trim()}`);
    }
  }

  if (!existing.includes(postgresVolume)) {
    docker(args.docker, ["volume", "create", postgresVolume]);
  }

  const user = manifest.postgres?.user || "croc";
  const database = manifest.postgres?.database || "croc";
  const image = manifest.images?.[`${manifest.project}-postgres-1`] || args.helperImage;
  const container = `stack-backup-restore-${crypto.randomBytes(4).toString("hex")}`;

  console.log(`[restore] loading ${POSTGRES_DUMP_FILE} into ${postgresVolume}`);
  docker(args.docker, [
    "run",
    "-d",
    "--name",
    container,
    "-e",
    `POSTGRES_USER=${user}`,
    "-e",
    `POSTGRES_DB=${database}`,
    "-e",
    "POSTGRES_PASSWORD=stack-backup-restore",
    "-v",
    `${postgresVolume}:/var/lib/postgresql/data`,
    image
  ]);
  try {
    if (!waitForPostgres(args.docker, container, user, database)) {
      throw new Error("postgres never became ready on the restored volume");
    }
    const dumpSql = zlib.gunzipSync(fs.readFileSync(path.join(backupDir, POSTGRES_DUMP_FILE))).toString("utf8");
    const load = docker(
      args.docker,
      ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database],
      { input: dumpSql, allowFailure: true }
    );
    if (load.status !== 0) {
      throw new Error(`psql refused the dump: ${(load.stderr || "").trim().split("\n").slice(-3).join(" / ")}`);
    }
  } finally {
    docker(args.docker, ["rm", "-f", container], { allowFailure: true });
  }

  console.log("[restore] ok — data plane restored");
  console.log("[restore] the password postgres was created with must match the DATABASE_URL you bring:");
  console.log("[restore]   POSTGRES_PASSWORD=stack-backup-restore (change it after the stack is up)");
  console.log("[restore] .env is NOT in the backup by design; supply it, then:");
  console.log(
    `[restore]   docker compose -p ${args.project} -f deploy/public-stack/docker-compose.yml --env-file .env up -d`
  );
  return true;
}

// ------------------------------------------------------------------ main

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[stack-backup] ${error.message}`);
    usage();
    process.exit(2);
  }

  if (!args.command || args.command === "help") {
    usage();
    process.exit(args.command ? 0 : 2);
  }

  try {
    if (args.command === "backup") {
      await commandBackup(args);
      return;
    }
    if (args.command === "verify") {
      process.exit(commandVerify(args) ? 0 : 1);
    }
    if (args.command === "restore") {
      commandRestore(args);
      return;
    }
    console.error(`[stack-backup] unknown command: ${args.command}`);
    usage();
    process.exit(2);
  } catch (error) {
    console.error(`[stack-backup] ${error.message}`);
    process.exit(1);
  }
}

// Only run when invoked as a command; the checks above are imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
