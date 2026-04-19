import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildStructuredError } from "@delexec/contracts";
import {
  OPS_SECRET_KEYS,
  ensureOpsState,
  hasEncryptedSecretStore,
  readResolvedOpsSecrets,
  saveOpsState,
  scrubLegacySecrets,
  unlockOpsSecrets,
  writeOpsSecrets
} from "./config.js";
import { initializeSecretStore, rotateSecretStorePassphrase } from "@delexec/runtime-utils";

const SESSION_HEADER = "x-platform-console-session";
const BOOTSTRAP_SECRET_HEADER = "x-platform-console-bootstrap-secret";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLATFORM_CONSOLE_ROOT = path.resolve(__dirname, "../../platform-console");
const STATIC_ROOT = path.resolve(PLATFORM_CONSOLE_ROOT);
const STATIC_MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

function nowIso() {
  return new Date().toISOString();
}

function normalizedString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":
      "Content-Type, Authorization, X-Platform-Console-Session, X-Platform-Console-Bootstrap-Secret"
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, code, message, extra = {}) {
  sendJson(res, statusCode, buildStructuredError(code, message, extra));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function pruneExpiredSessions(runtime) {
  const now = Date.now();
  for (const [token, session] of runtime.sessions.entries()) {
    if (session.expiresAt <= now) {
      runtime.sessions.delete(token);
    }
  }
  if (runtime.sessions.size === 0) {
    runtime.passphrase = null;
    runtime.unlockedSecrets = null;
  }
}

function createSession(runtime, passphrase, secrets) {
  pruneExpiredSessions(runtime);
  const token = crypto.randomUUID().replace(/-/g, "");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  runtime.passphrase = passphrase;
  runtime.unlockedSecrets = secrets;
  runtime.sessions.set(token, { expiresAt });
  return {
    token,
    expires_at: new Date(expiresAt).toISOString()
  };
}

function sessionToken(req) {
  const raw = req.headers[SESSION_HEADER];
  if (Array.isArray(raw)) {
    return normalizedString(raw[0]);
  }
  return normalizedString(raw);
}

function currentSession(runtime, req) {
  pruneExpiredSessions(runtime);
  const token = sessionToken(req);
  if (!token) {
    return null;
  }
  const session = runtime.sessions.get(token);
  if (!session) {
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return {
    token,
    expires_at: new Date(session.expiresAt).toISOString()
  };
}

function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return String(forwarded[0]).split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "";
}

function isLoopbackAddress(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

function providedBootstrapSecret(req, body = {}) {
  const headerValue = req.headers[BOOTSTRAP_SECRET_HEADER];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }
  if (Array.isArray(headerValue) && headerValue[0]) {
    return String(headerValue[0]).trim();
  }
  return normalizedString(body.bootstrap_secret);
}

function requireBootstrapSetupAccess(req, res, body = {}) {
  const configuredSecret = normalizedString(process.env.PLATFORM_CONSOLE_BOOTSTRAP_SECRET);
  if (configuredSecret) {
    if (providedBootstrapSecret(req, body) === configuredSecret) {
      return true;
    }
    sendError(
      res,
      403,
      "AUTH_BOOTSTRAP_FORBIDDEN",
      "bootstrap secret is required before initializing the public gateway secret store"
    );
    return false;
  }
  if (isLoopbackAddress(clientAddress(req))) {
    return true;
  }
  sendError(
    res,
    403,
    "AUTH_BOOTSTRAP_FORBIDDEN",
    "initial gateway setup is only allowed from localhost unless PLATFORM_CONSOLE_BOOTSTRAP_SECRET is configured"
  );
  return false;
}

function contentTypeFor(filePath) {
  return STATIC_MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function resolveStaticPath(pathname) {
  if (pathname === "/" || pathname === "/index.html") {
    return path.join(STATIC_ROOT, "index.html");
  }
  if (pathname.startsWith("/src/")) {
    const resolved = path.resolve(STATIC_ROOT, `.${pathname}`);
    if (resolved.startsWith(STATIC_ROOT)) {
      return resolved;
    }
  }
  return null;
}

async function serveStaticConsole(req, res, pathname) {
  if (!["GET", "HEAD"].includes(req.method || "GET")) {
    return false;
  }
  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    return false;
  }
  try {
    const contents = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "cache-control": pathname === "/" || pathname === "/index.html" ? "no-cache" : "public, max-age=300"
    });
    if ((req.method || "GET") === "HEAD") {
      res.end();
      return true;
    }
    res.end(contents);
    return true;
  } catch {
    return false;
  }
}

function buildFlattenedSecrets(state, runtime) {
  const secrets = readResolvedOpsSecrets(state, runtime.unlockedSecrets);
  return {
    [OPS_SECRET_KEYS.caller_api_key]: secrets.caller_api_key,
    [OPS_SECRET_KEYS.responder_platform_api_key]: secrets.responder_platform_api_key,
    [OPS_SECRET_KEYS.transport_emailengine_access_token]: secrets.transport.emailengine.access_token,
    [OPS_SECRET_KEYS.transport_gmail_client_secret]: secrets.transport.gmail.client_secret,
    [OPS_SECRET_KEYS.transport_gmail_refresh_token]: secrets.transport.gmail.refresh_token,
    [OPS_SECRET_KEYS.platform_admin_api_key]: secrets.platform_admin_api_key
  };
}

function authState(state, runtime) {
  pruneExpiredSessions(runtime);
  const configured = hasEncryptedSecretStore();
  const activeSession = runtime.sessions.values().next().value || null;
  const secrets = readResolvedOpsSecrets(state, runtime.unlockedSecrets);
  return {
    configured,
    setup_required: !configured,
    authenticated: configured ? runtime.sessions.size > 0 : false,
    locked: configured ? runtime.sessions.size === 0 : false,
    expires_at: activeSession ? new Date(activeSession.expiresAt).toISOString() : null,
    platform_url: state.config.platform_console?.base_url || state.config.platform?.base_url || null,
    admin_api_key_configured: Boolean(secrets.platform_admin_api_key)
  };
}

function requireSession(req, res, state, runtime) {
  if (!hasEncryptedSecretStore()) {
    sendError(res, 409, "AUTH_SECRET_STORE_MISSING", "local secret store is not initialized", {
      auth: authState(state, runtime)
    });
    return null;
  }
  const session = currentSession(runtime, req);
  if (!session) {
    sendError(res, 401, "AUTH_SESSION_REQUIRED", "local operator session is locked or missing", {
      auth: authState(state, runtime)
    });
    return null;
  }
  return session;
}

async function proxyRelayRequest(state, runtime, req, res, targetPathname, search) {
  const session = requireSession(req, res, state, runtime);
  if (!session) {
    return;
  }
  const baseUrl = state.config.transport_relay?.base_url;
  if (!baseUrl) {
    sendError(res, 409, "RELAY_NOT_CONFIGURED", "transport_relay.base_url is not configured");
    return;
  }
  const targetUrl = new URL(`${targetPathname || "/"}${search || ""}`, baseUrl);
  const method = req.method || "GET";
  const headers = {};
  const body = ["GET", "HEAD"].includes(method) ? undefined : JSON.stringify(await parseJsonBody(req));
  if (body !== undefined) {
    headers["content-type"] = "application/json; charset=utf-8";
  }
  let response;
  try {
    response = await fetch(targetUrl, { method, headers, body });
  } catch (error) {
    sendError(res, 502, "RELAY_UNREACHABLE", error instanceof Error ? error.message : "relay_unreachable", {
      base_url: baseUrl
    });
    return;
  }
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  sendJson(res, response.status, parsed);
}

async function proxyRequest(state, runtime, req, res, targetPathname, search) {
  const session = requireSession(req, res, state, runtime);
  if (!session) {
    return;
  }
  const secrets = readResolvedOpsSecrets(state, runtime.unlockedSecrets);
  if (!secrets.platform_admin_api_key) {
    sendError(res, 409, "AUTH_CREDENTIALS_MISSING", "platform admin key is not configured", {
      auth: authState(state, runtime)
    });
    return;
  }
  const baseUrl = state.config.platform_console?.base_url || state.config.platform?.base_url;
  const targetUrl = new URL(`${targetPathname}${search || ""}`, baseUrl);
  const method = req.method || "GET";
  const headers = {
    Authorization: `Bearer ${secrets.platform_admin_api_key}`
  };
  const body = ["GET", "HEAD"].includes(method) ? undefined : JSON.stringify(await parseJsonBody(req));
  if (body !== undefined) {
    headers["content-type"] = "application/json; charset=utf-8";
  }
  const response = await fetch(targetUrl, {
    method,
    headers,
    body
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  sendJson(res, response.status, parsed);
}

export function createPlatformConsoleGatewayServer() {
  const state = ensureOpsState();
  const runtime = {
    sessions: new Map(),
    unlockedSecrets: null,
    passphrase: null
  };

  return http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;

    try {
      if (method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
      }

      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true, service: "platform-console-gateway" });
        return;
      }
      if (method === "GET" && pathname === "/session") {
        sendJson(res, 200, { ok: true, session: authState(state, runtime) });
        return;
      }
      if (method === "POST" && pathname === "/session/setup") {
        const body = await parseJsonBody(req);
        if (!requireBootstrapSetupAccess(req, res, body)) {
          return;
        }
        const passphrase = normalizedString(body.passphrase);
        if (!passphrase || passphrase.length < 8) {
          sendError(res, 400, "AUTH_INVALID_PASSPHRASE", "passphrase must be at least 8 characters");
          return;
        }
        if (hasEncryptedSecretStore()) {
          sendError(res, 409, "AUTH_SECRET_STORE_EXISTS", "encrypted secret store already exists");
          return;
        }
        initializeSecretStore(state.secretsFile, passphrase, buildFlattenedSecrets(state, runtime));
        runtime.unlockedSecrets = unlockOpsSecrets(passphrase);
        runtime.passphrase = passphrase;
        scrubLegacySecrets(state);
        state.env = saveOpsState(state);
        const session = createSession(runtime, passphrase, runtime.unlockedSecrets);
        sendJson(res, 201, { ok: true, token: session.token, expires_at: session.expires_at, session: authState(state, runtime) });
        return;
      }
      if (method === "POST" && pathname === "/session/login") {
        const body = await parseJsonBody(req);
        const passphrase = normalizedString(body.passphrase);
        if (!passphrase) {
          sendError(res, 400, "AUTH_INVALID_PASSPHRASE", "passphrase is required");
          return;
        }
        if (!hasEncryptedSecretStore()) {
          sendError(res, 409, "AUTH_SECRET_STORE_MISSING", "encrypted secret store is not initialized yet");
          return;
        }
        try {
          const secrets = unlockOpsSecrets(passphrase);
          const session = createSession(runtime, passphrase, secrets);
          sendJson(res, 200, { ok: true, token: session.token, expires_at: session.expires_at, session: authState(state, runtime) });
        } catch (error) {
          sendError(res, 401, "AUTH_INVALID_PASSPHRASE", error instanceof Error ? error.message : "secret_unlock_failed");
        }
        return;
      }
      if (method === "POST" && pathname === "/session/logout") {
        const token = sessionToken(req);
        if (token) {
          runtime.sessions.delete(token);
        } else {
          runtime.sessions.clear();
        }
        pruneExpiredSessions(runtime);
        sendJson(res, 200, { ok: true, session: authState(state, runtime) });
        return;
      }
      if (method === "POST" && pathname === "/session/change-passphrase") {
        const active = requireSession(req, res, state, runtime);
        if (!active) {
          return;
        }
        const body = await parseJsonBody(req);
        const nextPassphrase = normalizedString(body.next_passphrase);
        if (!nextPassphrase || nextPassphrase.length < 8) {
          sendError(res, 400, "AUTH_INVALID_PASSPHRASE", "next_passphrase must be at least 8 characters");
          return;
        }
        try {
          rotateSecretStorePassphrase(state.secretsFile, runtime.passphrase, nextPassphrase);
          runtime.unlockedSecrets = unlockOpsSecrets(nextPassphrase);
          runtime.passphrase = nextPassphrase;
          sendJson(res, 200, { ok: true, session: authState(state, runtime) });
        } catch (error) {
          sendError(res, 401, "AUTH_INVALID_PASSPHRASE", error instanceof Error ? error.message : "passphrase_rotation_failed");
        }
        return;
      }
      if (method === "GET" && pathname === "/credentials/platform-admin") {
        const active = requireSession(req, res, state, runtime);
        if (!active) {
          return;
        }
        sendJson(res, 200, {
          ok: true,
          platform_url: state.config.platform_console?.base_url || state.config.platform?.base_url || null,
          api_key_configured: Boolean(readResolvedOpsSecrets(state, runtime.unlockedSecrets).platform_admin_api_key)
        });
        return;
      }
      if (method === "PUT" && pathname === "/credentials/platform-admin") {
        const active = requireSession(req, res, state, runtime);
        if (!active) {
          return;
        }
        const body = await parseJsonBody(req);
        const baseUrl = normalizedString(body.base_url);
        const apiKey = normalizedString(body.api_key);
        state.config.platform_console ||= {};
        if (baseUrl) {
          state.config.platform_console.base_url = baseUrl;
        }
        state.env = saveOpsState(state);
        if (apiKey) {
          writeOpsSecrets(runtime.passphrase, {
            [OPS_SECRET_KEYS.platform_admin_api_key]: apiKey
          });
          runtime.unlockedSecrets = unlockOpsSecrets(runtime.passphrase);
          scrubLegacySecrets(state);
        }
        sendJson(res, 200, {
          ok: true,
          platform_url: state.config.platform_console?.base_url || state.config.platform?.base_url || null,
          api_key_configured: Boolean(readResolvedOpsSecrets(state, runtime.unlockedSecrets).platform_admin_api_key)
        });
        return;
      }
      if (pathname.startsWith("/proxy/relay/")) {
        await proxyRelayRequest(state, runtime, req, res, pathname.slice("/proxy/relay".length), url.search);
        return;
      }
      if (pathname.startsWith("/proxy/")) {
        await proxyRequest(state, runtime, req, res, pathname.slice("/proxy".length), url.search);
        return;
      }

      if (await serveStaticConsole(req, res, pathname)) {
        return;
      }

      sendError(res, 404, "not_found", "no matching route", { path: pathname });
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_json") {
        sendError(res, 400, "invalid_json", "request body is not valid JSON");
        return;
      }
      sendError(res, 500, "platform_console_gateway_internal_error", error instanceof Error ? error.message : "unknown_error", {
        retryable: true
      });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createPlatformConsoleGatewayServer();
  const port = Number(process.env.PORT || 8085);
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`[platform-console-gateway] listening on http://${host}:${port}`);
  });
}
