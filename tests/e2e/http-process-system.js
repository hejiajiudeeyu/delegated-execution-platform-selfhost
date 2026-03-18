import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveHttpServiceLaunch, stopNodeHttpService, startNodeHttpService } from "../helpers/process.js";

const ROOT_DIR = process.cwd();
const PLATFORM_ENTRY = path.join(ROOT_DIR, "apps/platform-api/src/server.js");
const RELAY_ENTRY = path.join(ROOT_DIR, "apps/transport-relay/src/server.js");
const BUYER_ENTRY = path.join(ROOT_DIR, "apps/buyer-controller/src/server.js");
const SELLER_ENTRY = path.join(ROOT_DIR, "apps/seller-controller/src/server.js");

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
  const sellerId = `seller_http_${crypto.randomBytes(4).toString("hex")}`;
  const subagentId = "foxlab.text.classifier.v1";
  const sellerApiKey = `sk_seller_${crypto.randomBytes(12).toString("hex")}`;
  const signing = generateSigningPair();
  const relayPort = randomPort(41000);
  const platformPort = randomPort(42000);
  const buyerPort = randomPort(43000);
  const sellerPort = randomPort(44000);

  const sharedEnv = {
    DELEXEC_HOME: runtimeDir,
    DATABASE_URL: "",
    SQLITE_DATABASE_PATH: "",
    ENABLE_BOOTSTRAP_SELLERS: "true",
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
      SERVICE_NAME: "transport-relay-http-e2e"
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
      TOKEN_SECRET: `test-token-secret-${crypto.randomBytes(8).toString("hex")}`,
      BOOTSTRAP_SELLER_ID: sellerId,
      BOOTSTRAP_SUBAGENT_ID: subagentId,
      BOOTSTRAP_TASK_DELIVERY_ADDRESS: `local://relay/${sellerId}/${subagentId}`,
      BOOTSTRAP_SELLER_API_KEY: sellerApiKey,
      BOOTSTRAP_SELLER_PUBLIC_KEY_PEM: signing.publicKeyPem.replace(/\n/g, "\\n"),
      BOOTSTRAP_SELLER_PRIVATE_KEY_PEM: signing.privateKeyPem.replace(/\n/g, "\\n")
    }
  });

  const buyer = await startNodeHttpService({
    name: "buyer",
    ...resolveHttpServiceLaunch({
      serviceName: "buyer",
      entryPath: BUYER_ENTRY
    }),
    entryPath: BUYER_ENTRY,
    port: buyerPort,
    env: {
      ...sharedEnv,
      SERVICE_NAME: "buyer-controller-http-e2e",
      PLATFORM_API_BASE_URL: platform.baseUrl,
      TRANSPORT_TYPE: "relay_http",
      TRANSPORT_BASE_URL: relay.baseUrl,
      TRANSPORT_RECEIVER: "buyer-controller",
      BUYER_CONTROLLER_POLL_INTERVAL_ACTIVE_S: "1",
      BUYER_CONTROLLER_POLL_INTERVAL_BACKOFF_S: "1",
      BUYER_CONTROLLER_INBOX_POLL_INTERVAL_MS: "25",
      BUYER_CONTROLLER_EVENTS_SYNC_INTERVAL_MS: "25"
    }
  });

  const seller = await startNodeHttpService({
    name: "seller",
    ...resolveHttpServiceLaunch({
      serviceName: "seller",
      entryPath: SELLER_ENTRY
    }),
    entryPath: SELLER_ENTRY,
    port: sellerPort,
    env: {
      ...sharedEnv,
      SERVICE_NAME: "seller-controller-http-e2e",
      PLATFORM_API_BASE_URL: platform.baseUrl,
      SELLER_PLATFORM_API_KEY: sellerApiKey,
      SELLER_ID: sellerId,
      SUBAGENT_IDS: subagentId,
      SELLER_SIGNING_PUBLIC_KEY_PEM: signing.publicKeyPem.replace(/\n/g, "\\n"),
      SELLER_SIGNING_PRIVATE_KEY_PEM: signing.privateKeyPem.replace(/\n/g, "\\n"),
      TRANSPORT_TYPE: "relay_http",
      TRANSPORT_BASE_URL: relay.baseUrl,
      TRANSPORT_RECEIVER: sellerId,
      SELLER_INBOX_POLL_INTERVAL_MS: "25",
      SELLER_HEARTBEAT_INTERVAL_MS: "250"
    }
  });

  return {
    runtimeDir,
    relay,
    platform,
    buyer,
    seller,
    sellerId,
    subagentId,
    signing
  };
}

export async function stopHttpProcessSystem(system) {
  await stopNodeHttpService(system?.seller);
  await stopNodeHttpService(system?.buyer);
  await stopNodeHttpService(system?.platform);
  await stopNodeHttpService(system?.relay);
  if (system?.runtimeDir) {
    fs.rmSync(system.runtimeDir, { recursive: true, force: true });
  }
}
