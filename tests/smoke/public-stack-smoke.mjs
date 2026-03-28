import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

function runCmd(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    stdio: options.stdio || "pipe",
    encoding: "utf8",
    cwd: options.cwd || process.cwd()
  });
}

function summarizeOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function canUseDocker() {
  return runCmd("docker", ["info"]).status === 0;
}

function strictModeEnabled() {
  return String(process.env.STRICT_COMPOSE_SMOKE || "false").toLowerCase() === "true";
}

function classifyComposeFailure(output) {
  const text = String(output || "").toLowerCase();
  if (
    text.includes("pull access denied") ||
    text.includes("failed to authorize") ||
    text.includes("failed to fetch oauth token") ||
    text.includes("auth.docker.io/token") ||
    text.includes("unauthorized") ||
    text.includes("authentication required")
  ) {
    return "registry_auth_failed";
  }
  if (
    text.includes("failed to resolve source metadata") ||
    text.includes("error pulling image") ||
    text.includes("tls handshake timeout") ||
    text.includes("i/o timeout") ||
    text.includes("context deadline exceeded")
  ) {
    return "image_pull_failed";
  }
  if (text.includes("port is already allocated") || text.includes("address already in use")) {
    return "port_conflict";
  }
  return "compose_up_failed";
}

const DEFAULT_COMPOSE_PROJECT_NAME = `rsp-public-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

function composeProjectName() {
  return process.env.COMPOSE_PROJECT_NAME || DEFAULT_COMPOSE_PROJECT_NAME;
}

function resolveComposeArgs() {
  return [
    "compose",
    "-p",
    composeProjectName(),
    "-f",
    process.env.COMPOSE_FILE || "deploy/public-stack/docker-compose.yml",
    "--env-file",
    process.env.COMPOSE_ENV_FILE || "deploy/public-stack/.env.example"
  ];
}

function useNoBuild() {
  return String(process.env.COMPOSE_NO_BUILD || "false").toLowerCase() === "true";
}

function imageRef(name) {
  return `${process.env.IMAGE_REGISTRY || "ghcr.io/hejiajiudeeyu"}/${name}:${process.env.IMAGE_TAG || "latest"}`;
}

function buildLocalReleaseImages() {
  const builds = [
    { name: "rsp-platform", appPath: "apps/platform-api" },
    { name: "rsp-relay", appPath: "apps/transport-relay" },
    { name: "rsp-gateway", appPath: "apps/platform-console-gateway" }
  ];

  for (const build of builds) {
    const result = runCmd(
      "docker",
      [
        "build",
        "-f",
        "Dockerfile.workspace",
        "--build-arg",
        `APP_PATH=${build.appPath}`,
        "-t",
        imageRef(build.name),
        "."
      ],
      { stdio: "pipe" }
    );
    if (result.status !== 0) {
      throw new Error(`local_image_build_failed:${build.name}`);
    }
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupComposeProject(composeArgs, { label } = {}) {
  const down = runCmd("docker", [...composeArgs, "down", "--remove-orphans", "-v"], { stdio: "pipe" });
  if (down.status !== 0) {
    console.error(`[public-stack-smoke] ${label || "cleanup"}_down_failed\n${summarizeOutput(down)}`);
  }
}

function preflightComposeConfig(composeArgs) {
  const config = runCmd("docker", [...composeArgs, "config"], { stdio: "pipe" });
  if (config.status !== 0) {
    throw new Error(`compose_config_invalid: ${config.status}`);
  }
}

function captureComposeState(composeArgs) {
  const ps = runCmd("docker", [...composeArgs, "ps", "-a"], { stdio: "pipe" });
  const logs = runCmd("docker", [...composeArgs, "logs", "--no-color", "--tail", "200"], { stdio: "pipe" });
  return {
    ps: ps.status === 0 ? summarizeOutput(ps) : null,
    logs: logs.status === 0 ? summarizeOutput(logs) : null
  };
}

function bringComposeUp(composeArgs) {
  const up = runCmd("docker", [...composeArgs, "up", "-d", ...(useNoBuild() ? ["--no-build"] : ["--build"])]);
  if (up.status === 0) {
    return;
  }
  const output = summarizeOutput(up);
  throw new Error(classifyComposeFailure(output));
}

async function waitHealth(url, timeoutMs = 120000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
    } catch {
      // retry
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`health_check_timeout: ${url}`);
    }
    await sleep(1000);
  }
}

async function jsonRequest(baseUrl, path, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  const requestInit = { method, headers };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    requestInit.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${path}`, requestInit);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  return {
    status: response.status,
    body
  };
}

async function runScenario(baseUrl) {
  const consoleResponse = await fetch(`${baseUrl}/console/`);
  if (!consoleResponse.ok) {
    throw new Error(`console_static_failed: ${consoleResponse.status}`);
  }

  const sessionSetup = await jsonRequest(baseUrl, "/gateway/session/setup", {
    method: "POST",
    body: {
      passphrase: "public-stack-smoke-passphrase",
      bootstrap_secret: process.env.PLATFORM_CONSOLE_BOOTSTRAP_SECRET
    }
  });
  if (![200, 201].includes(sessionSetup.status) || !sessionSetup.body?.token) {
    throw new Error(`gateway_session_setup_failed: ${sessionSetup.status}`);
  }

  const sessionHeaders = {
    "x-platform-console-session": sessionSetup.body.token
  };

  const credentials = await jsonRequest(baseUrl, "/gateway/credentials/platform-admin", {
    method: "PUT",
    headers: sessionHeaders,
    body: {
      api_key: process.env.PLATFORM_ADMIN_API_KEY
    }
  });
  if (credentials.status !== 200 || credentials.body?.api_key_configured !== true) {
    throw new Error(`gateway_credentials_failed: ${credentials.status}`);
  }

  const proxied = await jsonRequest(baseUrl, "/gateway/proxy/v2/admin/hotlines", {
    headers: sessionHeaders
  });
  if (proxied.status !== 200 || !Array.isArray(proxied.body?.items)) {
    throw new Error(`gateway_proxy_failed: ${proxied.status}`);
  }

  console.log(`[public-stack-smoke] gateway proxy ok hotlines=${proxied.body.items.length}`);
}

async function main() {
  if (!canUseDocker()) {
    const message = "[public-stack-smoke] docker daemon not available";
    if (strictModeEnabled()) {
      console.error(`${message} (strict mode -> fail)`);
      process.exit(2);
    }
    console.log(`${message} (non-strict mode -> skip)`);
    process.exit(0);
  }

  process.env.PUBLIC_HTTP_PORT ||= "18080";
  process.env.PUBLIC_HTTPS_PORT ||= "18443";
  process.env.POSTGRES_PORT ||= "15432";
  process.env.PLATFORM_ADMIN_API_KEY ||= `sk_admin_public_${crypto.randomBytes(12).toString("hex")}`;
  process.env.PLATFORM_CONSOLE_BOOTSTRAP_SECRET ||= `bootstrap_${crypto.randomBytes(12).toString("hex")}`;
  process.env.PUBLIC_SITE_ADDRESS ||= "http://127.0.0.1";
  process.env.TOKEN_SECRET ||= crypto.randomBytes(32).toString("hex");

  const compose = resolveComposeArgs();
  const baseUrl = `http://127.0.0.1:${process.env.PUBLIC_HTTP_PORT}`;

  try {
    console.log(`[public-stack-smoke] project=${composeProjectName()} mode=${useNoBuild() ? "published_image" : "source_build"}`);
    preflightComposeConfig(compose);
    cleanupComposeProject(compose, { label: "preflight" });
    if (!useNoBuild()) {
      buildLocalReleaseImages();
    }
    bringComposeUp(compose);

    await waitHealth(`${baseUrl}/healthz`);
    await waitHealth(`${baseUrl}/platform/healthz`);
    await waitHealth(`${baseUrl}/relay/healthz`);
    await waitHealth(`${baseUrl}/gateway/healthz`);
    await runScenario(baseUrl);
    console.log("[public-stack-smoke] completed");
  } catch (error) {
    const state = captureComposeState(compose);
    console.error(`[public-stack-smoke] failed: ${error instanceof Error ? error.message : "unknown_error"}`);
    if (state.ps) {
      console.error(`[public-stack-smoke] compose ps\n${state.ps}`);
    }
    if (state.logs) {
      console.error(`[public-stack-smoke] compose logs\n${state.logs}`);
    }
    process.exitCode = 1;
  } finally {
    console.log("[public-stack-smoke] down");
    cleanupComposeProject(compose);
  }
}

main();
