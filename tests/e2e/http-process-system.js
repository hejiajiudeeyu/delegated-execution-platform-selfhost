import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HERMETIC_STORE_ENV,
  resolveClientServiceLaunch,
  resolveHttpServiceLaunch,
  startNodeHttpService,
  stopNodeHttpService
} from "../helpers/process.js";

const ROOT_DIR = process.cwd();
const PLATFORM_ENTRY = path.join(ROOT_DIR, "apps/platform-api/src/server.js");
const RELAY_ENTRY = path.join(ROOT_DIR, "apps/transport-relay/src/server.js");

function randomPort(base) {
  return base + Math.floor(Math.random() * 500);
}

function generateSigningPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" })
  };
}

export async function startHttpProcessSystem() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rsp-http-e2e-"));
  const responderId = `responder_http_${crypto.randomBytes(4).toString("hex")}`;
  const hotlineId = "foxlab.text.classifier.v1";
  const responderApiKey = `sk_responder_${crypto.randomBytes(12).toString("hex")}`;
  const signing = generateSigningPair();
  const relayPort = randomPort(41000);
  const platformPort = randomPort(42000);
  const callerPort = randomPort(43000);
  const responderPort = randomPort(44000);

  // The relay authenticates its business routes, so the whole e2e stack runs
  // authenticated: this is the flow a real deployment uses, and it proves
  // platform-api and both client controllers carry the credential correctly.
  const relayAdminToken = `relay_admin_${crypto.randomBytes(12).toString("hex")}`;
  const relayTokenSecret = `relay_secret_${crypto.randomBytes(16).toString("hex")}`;

  const sharedEnv = {
    DELEXEC_HOME: runtimeDir,
    ...HERMETIC_STORE_ENV,
    ENABLE_BOOTSTRAP_RESPONDERS: "true",
    PLATFORM_ADMIN_API_KEY: `sk_admin_${crypto.randomBytes(12).toString("hex")}`
  };

  const relay = await startNodeHttpService({
    name: "relay",
    ...resolveHttpServiceLaunch({
      serviceName: "relay",
      entryPath: RELAY_ENTRY
    }),
    entryPath: RELAY_ENTRY,
    port: relayPort,
    env: {
      ...sharedEnv,
      SERVICE_NAME: "transport-relay-http-e2e",
      RELAY_ADMIN_TOKEN: relayAdminToken,
      RELAY_TOKEN_SECRET: relayTokenSecret
    }
  });

  const platform = await startNodeHttpService({
    name: "platform",
    ...resolveHttpServiceLaunch({
      serviceName: "platform",
      entryPath: PLATFORM_ENTRY
    }),
    entryPath: PLATFORM_ENTRY,
    port: platformPort,
    env: {
      ...sharedEnv,
      SERVICE_NAME: "platform-api-http-e2e",
      RELAY_ADMIN_TOKEN: relayAdminToken,
      TOKEN_SECRET: `test-token-secret-${crypto.randomBytes(8).toString("hex")}`,
      BOOTSTRAP_RESPONDER_ID: responderId,
      BOOTSTRAP_HOTLINE_ID: hotlineId,
      BOOTSTRAP_TASK_DELIVERY_ADDRESS: `local://relay/${responderId}/${hotlineId}`,
      BOOTSTRAP_RESPONDER_API_KEY: responderApiKey,
      BOOTSTRAP_RESPONDER_PUBLIC_KEY_PEM: signing.publicKeyPem.replace(/\n/g, "\\n"),
      BOOTSTRAP_RESPONDER_PRIVATE_KEY_PEM: signing.privateKeyPem.replace(/\n/g, "\\n")
    }
  });

  const callerService = resolveClientServiceLaunch({ serviceName: "caller", appName: "caller-controller" });
  const caller = await startNodeHttpService({
    name: "caller",
    ...callerService.launch,
    entryPath: callerService.entryPath,
    port: callerPort,
    env: {
      ...sharedEnv,
      SERVICE_NAME: "caller-controller-http-e2e",
      PLATFORM_API_BASE_URL: platform.baseUrl,
      TRANSPORT_TYPE: "relay_http",
      TRANSPORT_BASE_URL: relay.baseUrl,
      TRANSPORT_AUTH_TOKEN: relayAdminToken,
      TRANSPORT_RECEIVER: "caller-controller",
      CALLER_CONTROLLER_POLL_INTERVAL_ACTIVE_S: "1",
      CALLER_CONTROLLER_POLL_INTERVAL_BACKOFF_S: "1",
      CALLER_CONTROLLER_INBOX_POLL_INTERVAL_MS: "25",
      CALLER_CONTROLLER_EVENTS_SYNC_INTERVAL_MS: "25"
    }
  });

  const responderService = resolveClientServiceLaunch({ serviceName: "responder", appName: "responder-controller" });
  const responder = await startNodeHttpService({
    name: "responder",
    ...responderService.launch,
    entryPath: responderService.entryPath,
    port: responderPort,
    env: {
      ...sharedEnv,
      SERVICE_NAME: "responder-controller-http-e2e",
      PLATFORM_API_BASE_URL: platform.baseUrl,
      RESPONDER_PLATFORM_API_KEY: responderApiKey,
      RESPONDER_ID: responderId,
      HOTLINE_IDS: hotlineId,
      RESPONDER_SIGNING_PUBLIC_KEY_PEM: signing.publicKeyPem.replace(/\n/g, "\\n"),
      RESPONDER_SIGNING_PRIVATE_KEY_PEM: signing.privateKeyPem.replace(/\n/g, "\\n"),
      TRANSPORT_TYPE: "relay_http",
      TRANSPORT_BASE_URL: relay.baseUrl,
      TRANSPORT_AUTH_TOKEN: relayAdminToken,
      TRANSPORT_RECEIVER: responderId,
      RESPONDER_INBOX_POLL_INTERVAL_MS: "25",
      RESPONDER_HEARTBEAT_INTERVAL_MS: "250"
    }
  });

  return {
    runtimeDir,
    relay,
    platform,
    caller,
    responder,
    responderId,
    hotlineId,
    signing
  };
}

export async function stopHttpProcessSystem(system) {
  await stopNodeHttpService(system?.responder);
  await stopNodeHttpService(system?.caller);
  await stopNodeHttpService(system?.platform);
  await stopNodeHttpService(system?.relay);
  if (system?.runtimeDir) {
    fs.rmSync(system.runtimeDir, { recursive: true, force: true });
  }
}
