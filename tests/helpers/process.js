import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { jsonRequest, waitFor } from "./http.js";

// Blank the store-selection env vars so spawned services stay hermetic even
// when the machine has local deploy env files (e.g. deploy/platform/.env)
// that platform-api self-loads on direct run.
export const HERMETIC_STORE_ENV = Object.freeze({
  DATABASE_URL: "",
  BILLING_DATABASE_URL: "",
  PLATFORM_DATABASE_URL: "",
  SQLITE_DATABASE_PATH: ""
});

function normalizedString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed || null;
}

function parseArgsEnv(value) {
  const normalized = normalizedString(value);
  if (!normalized) {
    return [];
  }
  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [normalized];
  } catch {
    return normalized.split(/\s+/).filter(Boolean);
  }
}

export function resolveHttpServiceLaunch({
  serviceName,
  entryPath,
  defaultArgs = []
}) {
  const envPrefix = `E2E_${String(serviceName || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")}`;
  const command = normalizedString(process.env[`${envPrefix}_CMD`]);
  const args = parseArgsEnv(process.env[`${envPrefix}_ARGS`]);

  if (command) {
    return {
      mode: "external_command",
      command,
      args
    };
  }

  return {
    mode: "source_entry",
    command: process.execPath,
    args: [entryPath, ...defaultArgs]
  };
}

// caller-controller / responder-controller / ops moved to the client
// repository in the repo split; resolve them from a sibling client checkout
// (fourth-repo workspace or CI sibling layout) unless an E2E_*_CMD override
// is set.
export function resolveClientDir(rootDir = process.cwd()) {
  const explicit = normalizedString(process.env.E2E_CLIENT_DIR);
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [
        path.resolve(rootDir, "../client"),
        path.resolve(rootDir, "../../client"),
        path.resolve(rootDir, "../../repos/client")
      ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
  }
  return null;
}

export function resolveClientServiceLaunch({
  serviceName,
  appName,
  entryRelPath = "src/server.js",
  defaultArgs = []
}) {
  const override = resolveHttpServiceLaunch({ serviceName, entryPath: null, defaultArgs });
  if (override.mode === "external_command") {
    return { launch: override, entryPath: null };
  }
  const clientDir = resolveClientDir();
  const entryPath = clientDir ? path.join(clientDir, "apps", appName, entryRelPath) : null;
  if (!entryPath || !fs.existsSync(entryPath)) {
    const envPrefix = `E2E_${String(serviceName).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    throw new Error(
      `${serviceName} service entry unavailable: the platform repo does not vendor ${appName}. ` +
        `Provide a sibling delegated-execution-client checkout with installed dependencies ` +
        `(../client, ../../client, ../../repos/client, or E2E_CLIENT_DIR), ` +
        `or set ${envPrefix}_CMD to an installed command.`
    );
  }
  return { launch: resolveHttpServiceLaunch({ serviceName, entryPath, defaultArgs }), entryPath };
}

export async function startNodeHttpService({
  name,
  entryPath,
  args = [],
  command = null,
  port,
  env = {},
  healthPath = "/healthz",
  host = "127.0.0.1",
  timeoutMs = 10000
}) {
  const logs = [];
  const launchCommand = command || process.execPath;
  const launchArgs = command ? args : [entryPath, ...args];
  const child = spawn(launchCommand, launchArgs, {
    env: {
      ...process.env,
      ...env,
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => logs.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));

  let exitCode = null;
  let exited = false;
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const baseUrl = `http://${host}:${port}`;

  try {
    await waitFor(async () => {
      if (exited) {
        const error = new Error(`${name}_process_exited_with_${exitCode}`);
        error.fatal = true;
        throw error;
      }
      const health = await jsonRequest(baseUrl, healthPath);
      if (health.status !== 200) {
        throw new Error(`${name}_health_${health.status}`);
      }
      return health;
    }, { timeoutMs, intervalMs: 100 });
  } catch (error) {
    await stopNodeHttpService({ child });
    const output = logs.join("");
    throw new Error(`${name}_failed_to_start:${error instanceof Error ? error.message : "unknown_error"}\n${output}`);
  }

  return {
    name,
    child,
    baseUrl,
    logs,
    launch: {
      command: launchCommand,
      args: launchArgs
    }
  };
}

export async function stopNodeHttpService(service) {
  if (!service?.child) {
    return;
  }

  const child = service.child;
  if (child.exitCode !== null || child.killed) {
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    child.once("exit", finish);
    child.kill("SIGTERM");

    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      finish();
    }, 1000);
  });
}
