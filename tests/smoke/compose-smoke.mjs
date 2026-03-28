import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

function runCmd(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: options.stdio || "pipe",
    encoding: "utf8",
    cwd: options.cwd || process.cwd()
  });
  return result;
}

function summarizeOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
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
    text.includes("oauth token") ||
    text.includes("tls handshake timeout") ||
    text.includes("i/o timeout") ||
    text.includes("context deadline exceeded") ||
    (text.includes("eof") && (text.includes("docker.io") || text.includes("authorize") || text.includes("token")))
  ) {
    return "image_pull_failed";
  }
  if (text.includes("port is already allocated") || text.includes("address already in use")) {
    return "port_conflict";
  }
  return "compose_up_failed";
}

function canUseDocker() {
  const docker = runCmd("docker", ["info"]);
  return docker.status === 0;
}

function strictModeEnabled() {
  return String(process.env.STRICT_COMPOSE_SMOKE || "false").toLowerCase() === "true";
}

const DEFAULT_COMPOSE_PROJECT_NAME = `rsp-smoke-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

function composeProjectName() {
  return process.env.COMPOSE_PROJECT_NAME || DEFAULT_COMPOSE_PROJECT_NAME;
}

function resolveComposeArgs() {
  const composeFile = process.env.COMPOSE_FILE || "docker-compose.yml";
  const args = ["compose", "-p", composeProjectName(), "-f", composeFile];
  if (process.env.COMPOSE_ENV_FILE) {
    args.push("--env-file", process.env.COMPOSE_ENV_FILE);
  }
  return args;
}

function useNoBuild() {
  return String(process.env.COMPOSE_NO_BUILD || "false").toLowerCase() === "true";
}

function encodePemForEnv(pem) {
  return pem.replace(/\n/g, "\\n");
}

function ensureBootstrapResponderEnv() {
  if (
    process.env.BOOTSTRAP_RESPONDER_API_KEY &&
    process.env.BOOTSTRAP_RESPONDER_PUBLIC_KEY_PEM &&
    process.env.BOOTSTRAP_RESPONDER_PRIVATE_KEY_PEM
  ) {
    return;
  }

  const pair = crypto.generateKeyPairSync("ed25519");
  process.env.BOOTSTRAP_RESPONDER_API_KEY ||= `sk_responder_smoke_${crypto.randomBytes(12).toString("hex")}`;
  process.env.BOOTSTRAP_RESPONDER_PUBLIC_KEY_PEM ||= encodePemForEnv(
    pair.publicKey.export({ type: "spki", format: "pem" }).toString()
  );
  process.env.BOOTSTRAP_RESPONDER_PRIVATE_KEY_PEM ||= encodePemForEnv(
    pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  );
}

function shouldRemoveVolumesOnDown() {
  return String(process.env.COMPOSE_DOWN_VOLUMES || "true").toLowerCase() === "true";
}

function imagePullRetryCount() {
  return Math.max(0, Number(process.env.COMPOSE_IMAGE_PULL_RETRIES || 2));
}

function prewarmBaseImages() {
  return ["node:22-alpine", "postgres:16-alpine"];
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyHealthFailure(output) {
  const text = String(output || "").toLowerCase();
  if (
    text.includes("exited") ||
    text.includes("dead") ||
    text.includes("restarting") ||
    text.includes("unhealthy")
  ) {
    return "service_runtime_failed";
  }
  return "health_check_timeout";
}

function configuredComposeImages(composeArgs) {
  const config = runCmd("docker", [...composeArgs, "config", "--images"], { stdio: "pipe" });
  if (config.status !== 0) {
    throw new Error(`compose_images_invalid: ${config.status}`);
  }
  return summarizeOutput(config)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function imageExists(image) {
  return runCmd("docker", ["image", "inspect", image], { stdio: "pipe" }).status === 0;
}

function pullImage(image) {
  const pulled = runCmd("docker", ["pull", image], { stdio: "pipe" });
  if (pulled.status === 0) {
    return;
  }
  const output = summarizeOutput(pulled);
  const classified = classifyComposeFailure(output);
  const error = new Error(`${classified}: ${image}`);
  error.output = output;
  error.image = image;
  throw error;
}

function prewarmImages(composeArgs) {
  const images = new Set(useNoBuild() ? configuredComposeImages(composeArgs) : prewarmBaseImages());
  const summary = {
    mode: useNoBuild() ? "published_image" : "source_build",
    cached: [],
    pulled: []
  };

  for (const image of images) {
    if (imageExists(image)) {
      summary.cached.push(image);
      continue;
    }
    pullImage(image);
    summary.pulled.push(image);
  }
  return summary;
}

async function waitHealth(url, timeoutMs = 120000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore and retry
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
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

async function waitFor(fn, { timeoutMs = 30000, intervalMs = 200 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (Date.now() - started >= timeoutMs) {
        throw error;
      }
      await sleep(intervalMs);
    }
  }
}

async function runScenario() {
  const platform = "http://127.0.0.1:8080";
  const caller = "http://127.0.0.1:8081";
  const requestId = `req_compose_${Date.now()}`;

  const register = await jsonRequest(caller, "/controller/register", {
    method: "POST",
    body: { email: "compose-smoke@test.local" }
  });
  if (register.status !== 201) {
    throw new Error(`register_failed: ${register.status}`);
  }

  const auth = { "X-Platform-Api-Key": register.body.api_key };

  const catalog = await jsonRequest(caller, "/controller/hotlines?status=enabled", {
    headers: auth
  });
  if (catalog.status !== 200 || !catalog.body?.items?.length) {
    throw new Error(`catalog_failed: ${catalog.status}`);
  }
  const selected = catalog.body.items[0];

  const started = await jsonRequest(caller, "/controller/remote-requests", {
    method: "POST",
    headers: auth,
    body: {
      request_id: requestId,
      responder_id: selected.responder_id,
      hotline_id: selected.hotline_id,
      expected_signer_public_key_pem: selected.responder_public_key_pem,
      soft_timeout_s: 5,
      hard_timeout_s: 20,
      simulate: "success",
      delay_ms: 80
    }
  });
  if (started.status !== 201) {
    throw new Error(`caller_remote_request_failed: ${started.status}`);
  }

  const events = await waitFor(async () => {
    const polled = await jsonRequest(platform, `/v1/requests/${requestId}/events`, {
      headers: { Authorization: `Bearer ${register.body.api_key}` }
    });
    if (polled.status !== 200 || !polled.body?.events?.some((event) => event.event_type === "ACKED")) {
      throw new Error("ack_not_ready");
    }
    return polled;
  });

  const final = await waitFor(async () => {
    const current = await jsonRequest(caller, `/controller/requests/${requestId}`);
    if (current.status !== 200 || current.body?.status !== "SUCCEEDED") {
      throw new Error("caller_result_not_ready");
    }
    return current;
  });

  console.log(`[compose-smoke] success request_id=${requestId} acked=${events.body.events.some((event) => event.event_type === "ACKED")} final_status=${final.body.status}`);
}

function bringComposeUp(composeArgs) {
  const retries = imagePullRetryCount();
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const up = runCmd("docker", [...composeArgs, "up", "-d", ...(useNoBuild() ? ["--no-build"] : ["--build"])]);
    if (up.status === 0) {
      return up;
    }

    const output = summarizeOutput(up);
    const classified = classifyComposeFailure(output);
    if (classified !== "image_pull_failed" || attempt === retries) {
      const error = new Error(`${classified}: ${up.status}`);
      error.output = output;
      throw error;
    }

    console.error(`[compose-smoke] transient image pull failure, retry ${attempt + 1}/${retries}`);
  }

  throw new Error("compose_up_failed: exhausted_retries");
}

function preflightComposeConfig(composeArgs) {
  const config = runCmd("docker", [...composeArgs, "config"], { stdio: "pipe" });
  if (config.status !== 0) {
    throw new Error(`compose_config_invalid: ${config.status}`);
  }
}

function cleanupComposeProject(composeArgs, { label } = {}) {
  const downArgs = [...composeArgs, "down", "--remove-orphans"];
  if (shouldRemoveVolumesOnDown()) {
    downArgs.push("-v");
  }
  const down = runCmd("docker", downArgs, { stdio: "pipe" });
  if (down.status !== 0) {
    console.error(`[compose-smoke] ${label || "cleanup"}_down_failed\n${summarizeOutput(down)}`);
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

async function waitHealthSuite(composeArgs) {
  try {
    await waitHealth("http://127.0.0.1:8090/healthz");
    await waitHealth("http://127.0.0.1:8080/healthz");
    await waitHealth("http://127.0.0.1:8081/healthz");
    await waitHealth("http://127.0.0.1:8082/healthz");
  } catch (error) {
    const state = captureComposeState(composeArgs);
    const reason = classifyHealthFailure(`${error instanceof Error ? error.message : ""}\n${state.ps || ""}\n${state.logs || ""}`);
    const wrapped = new Error(reason);
    wrapped.cause = error;
    wrapped.composeState = state;
    throw wrapped;
  }
}

function runPostgresCrudCheck(composeArgs) {
  const sql = [
    "CREATE TABLE IF NOT EXISTS smoke_checks (id SERIAL PRIMARY KEY, note TEXT NOT NULL);",
    "INSERT INTO smoke_checks (note) VALUES ('compose-smoke');",
    "SELECT COUNT(*) FROM smoke_checks;",
    "TRUNCATE TABLE smoke_checks;"
  ].join(" ");

  const result = runCmd(
    "docker",
    [...composeArgs, "exec", "-T", "postgres", "psql", "-U", "croc", "-d", "croc", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { stdio: "pipe" }
  );

  if (result.status !== 0) {
    throw new Error(`postgres_crud_check_failed: ${result.stderr || result.stdout || "unknown"}`);
  }
  console.log("[compose-smoke] postgres CRUD check passed");
}

async function main() {
  if (!canUseDocker()) {
    const message = "[compose-smoke] docker daemon not available";
    if (strictModeEnabled()) {
      console.error(`${message} (strict mode -> fail)`);
      process.exit(2);
    }
    console.log(`${message} (non-strict mode -> skip)`);
    process.exit(0);
  }

  const compose = resolveComposeArgs();

  try {
    ensureBootstrapResponderEnv();
    console.log(`[compose-smoke] project=${composeProjectName()} mode=${useNoBuild() ? "published_image" : "source_build"}`);
    preflightComposeConfig(compose);
    cleanupComposeProject(compose, { label: "preflight" });
    const prewarm = prewarmImages(compose);
    console.log(
      `[compose-smoke] prewarm cached=${prewarm.cached.length} pulled=${prewarm.pulled.length}${
        prewarm.pulled.length ? ` images=${prewarm.pulled.join(",")}` : ""
      }`
    );
    console.log(`[compose-smoke] up ${useNoBuild() ? "--no-build" : "--build"}`);
    bringComposeUp(compose);

    console.log("[compose-smoke] waiting health checks");
    await waitHealthSuite(compose);

    runPostgresCrudCheck(compose);
    await runScenario();
    console.log("[compose-smoke] completed");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    console.error(`[compose-smoke] diagnostics reason=${reason}`);
    if (error?.image) {
      console.error(`[compose-smoke] image failure image=${error.image}`);
    }
    if (error?.output) {
      console.error(`[compose-smoke] failure output\n${error.output}`);
    }
    const state = error?.composeState || captureComposeState(compose);
    if (state.ps) {
      console.error(`[compose-smoke] compose ps\n${state.ps}`);
    }
    if (state.logs) {
      console.error(`[compose-smoke] compose logs\n${state.logs}`);
    }
    throw error;
  } finally {
    console.log("[compose-smoke] down");
    cleanupComposeProject(compose);
  }
}

main().catch((error) => {
  console.error(`[compose-smoke] failed: ${error instanceof Error ? error.message : "unknown_error"}`);
  process.exit(1);
});
