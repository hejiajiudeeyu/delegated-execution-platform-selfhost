import { spawn } from "node:child_process";

import { jsonRequest, waitFor } from "./http.js";

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

  const baseUrl = `http://${host}:${port}`;

  try {
    await waitFor(async () => {
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
