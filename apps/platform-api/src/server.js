import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildStructuredError, canonicalizeResultPackageForSignature } from "@delexec/contracts";
import { createPostgresSnapshotStore } from "@delexec/postgres-store";
import { createSqliteSnapshotStore } from "@delexec/sqlite-store";
import { buildOpsEnvSearchPaths, loadEnvFiles } from "@delexec/runtime-utils";
import { createRelayHttpTransportAdapter } from "./relay-http.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../../..");

loadEnvFiles([
  ...buildOpsEnvSearchPaths(ROOT_DIR, "platform"),
  path.join(ROOT_DIR, "deploy/all-in-one/.env"),
  path.join(ROOT_DIR, "deploy/all-in-one/.env.local")
]);

const HEARTBEAT_INTERVAL_S = 30;
const DEGRADED_THRESHOLD_S = 90;
const OFFLINE_THRESHOLD_S = 180;
const REVIEW_TEST_BUYER_ID = "buyer_review_bot";
const REVIEW_TEST_RECEIVER_PREFIX = "platform-review-bot";
const DEFAULT_REQUEST_EVENT_HISTORY_LIMIT = 200;
const DEFAULT_TELEMETRY_HISTORY_LIMIT = 5000;
const DEFAULT_SUBAGENT_QUOTA_PER_SELLER = 25;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

function readNumberEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function createDisplayCode() {
  return crypto.randomBytes(6).toString("base64url").toUpperCase();
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

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, X-Platform-Api-Key"
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, code, message, { retryable, ...extra } = {}) {
  sendJson(res, statusCode, buildStructuredError(code, message, { retryable, ...extra }));
}

function encodeBase64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function decodeBase64Url(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signToken(secret, claims) {
  const payload = encodeBase64Url(JSON.stringify(claims));
  const mac = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function parseToken(secret, token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { valid: false, error: { code: "AUTH_TOKEN_INVALID", message: "token format or signature is invalid", retryable: false } };
  }

  const [payload, signature] = token.split(".", 2);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const expectedBytes = Buffer.from(expected);
  const signatureBytes = Buffer.from(signature || "");

  if (expectedBytes.length !== signatureBytes.length || !crypto.timingSafeEqual(expectedBytes, signatureBytes)) {
    return { valid: false, error: { code: "AUTH_TOKEN_INVALID", message: "token format or signature is invalid", retryable: false } };
  }

  try {
    const claims = JSON.parse(decodeBase64Url(payload));
    if (typeof claims.exp !== "number" || Date.now() >= claims.exp * 1000) {
      return { valid: false, error: { code: "AUTH_TOKEN_EXPIRED", message: "token has expired", retryable: false }, claims };
    }
    return { valid: true, claims };
  } catch {
    return { valid: false, error: { code: "AUTH_TOKEN_INVALID", message: "token format or signature is invalid", retryable: false } };
  }
}

function decodePemEnv(value) {
  if (!value) {
    return null;
  }
  return value.replace(/\\n/g, "\n");
}

function readBooleanEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function createSellerIdentity({
  sellerId,
  subagentId,
  templateRef,
  displayName,
  taskDeliveryAddress,
  taskTypes = [],
  capabilities = [],
  tags = [],
  inputSchema = null,
  outputSchema = null,
  apiKey = null,
  ownerUserId = null,
  contactEmail = null,
  supportEmail = null,
  signing = null
}) {
  const keyPair = signing
    ? {
        publicKeyPem: signing.publicKeyPem,
        privateKeyPem: signing.privateKeyPem
      }
    : (() => {
        const generated = crypto.generateKeyPairSync("ed25519");
        return {
          publicKeyPem: generated.publicKey.export({ type: "spki", format: "pem" }).toString(),
          privateKeyPem: generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
        };
      })();
  const sellerApiKey = apiKey || `sk_seller_${crypto.randomBytes(12).toString("hex")}`;
  const sellerUserId = ownerUserId || randomId("user");
  const lastHeartbeatAt = nowIso();

  return {
    seller: {
      seller_id: sellerId,
      owner_user_id: sellerUserId,
      api_key: sellerApiKey,
      scopes: ["seller"],
      subagent_ids: [subagentId],
      status: "enabled",
      review_status: "approved",
      reviewed_at: lastHeartbeatAt,
      reviewed_by: "system",
      review_reason: "bootstrap",
      seller_public_key_pem: keyPair.publicKeyPem,
      seller_public_keys_pem: [keyPair.publicKeyPem],
      last_heartbeat_at: lastHeartbeatAt,
      availability_status: "healthy",
      contact_email: contactEmail || `${sellerId}@test.local`,
      support_email: supportEmail || `support+${sellerId}@test.local`
    },
    catalogItem: {
      seller_id: sellerId,
      subagent_id: subagentId,
      display_name: displayName,
      status: "enabled",
      review_status: "approved",
      submission_version: 1,
      submitted_at: lastHeartbeatAt,
      reviewed_at: lastHeartbeatAt,
      reviewed_by: "system",
      review_reason: "bootstrap",
      availability_status: "healthy",
      last_heartbeat_at: lastHeartbeatAt,
      template_ref: templateRef,
      task_types: taskTypes,
      capabilities,
      tags,
      input_schema: inputSchema,
      output_schema: outputSchema,
      seller_public_key_pem: keyPair.publicKeyPem,
      seller_public_keys_pem: [keyPair.publicKeyPem],
      task_delivery_address: taskDeliveryAddress
    },
    signing: {
      publicKeyPem: keyPair.publicKeyPem,
      privateKeyPem: keyPair.privateKeyPem
    }
  };
}

function createTemplateBundle(templateRef, options = {}) {
  return {
    template_ref: templateRef,
    input_schema: options.inputSchema || {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string" },
        context: { type: "object" }
      }
    },
    output_schema: options.outputSchema || {
      type: "object",
      required: ["summary"],
      properties: {
        summary: { type: "string" }
      }
    }
  };
}

function sanitizeCatalogItem(item) {
  const { task_delivery_address, ...publicItem } = item;
  return publicItem;
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function buildAvailability(lastHeartbeatAt) {
  const ageSeconds = (Date.now() - new Date(lastHeartbeatAt).getTime()) / 1000;
  if (ageSeconds > OFFLINE_THRESHOLD_S) {
    return "offline";
  }
  if (ageSeconds > DEGRADED_THRESHOLD_S) {
    return "degraded";
  }
  return "healthy";
}

function resolveCatalogAvailability(item) {
  if (item.availability_status && item.availability_status !== "healthy") {
    return item.availability_status;
  }
  return buildAvailability(item.last_heartbeat_at);
}

function pushCapped(array, value, limit = DEFAULT_TELEMETRY_HISTORY_LIMIT) {
  array.push(value);
  const max = Math.max(1, Number(limit || DEFAULT_TELEMETRY_HISTORY_LIMIT));
  if (array.length > max) {
    array.splice(0, array.length - max);
  }
  return value;
}

function buildPlatformLimits() {
  return {
    requestEventHistory: readNumberEnv(process.env.PLATFORM_REQUEST_EVENT_HISTORY_LIMIT, DEFAULT_REQUEST_EVENT_HISTORY_LIMIT),
    telemetryHistory: readNumberEnv(process.env.PLATFORM_TELEMETRY_HISTORY_LIMIT, DEFAULT_TELEMETRY_HISTORY_LIMIT),
    subagentsPerSeller: readNumberEnv(process.env.PLATFORM_SUBAGENT_QUOTA_PER_SELLER, DEFAULT_SUBAGENT_QUOTA_PER_SELLER)
  };
}

function requestEventHistoryLimit(state) {
  return state.limits?.requestEventHistory || DEFAULT_REQUEST_EVENT_HISTORY_LIMIT;
}

function telemetryHistoryLimit(state) {
  return state.limits?.telemetryHistory || DEFAULT_TELEMETRY_HISTORY_LIMIT;
}

function getClientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return String(forwarded[0]).split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function buildRateLimitConfig() {
  return {
    windowMs: readNumberEnv(process.env.PUBLIC_RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
    registerUserMax: readNumberEnv(process.env.PUBLIC_RATE_LIMIT_REGISTER_USER_MAX, 1000),
    registerSellerMax: readNumberEnv(process.env.PUBLIC_RATE_LIMIT_REGISTER_SELLER_MAX, 1000),
    catalogSubmitMax: readNumberEnv(process.env.PUBLIC_RATE_LIMIT_CATALOG_SUBMIT_MAX, 1000)
  };
}

function createRateLimiter(config = buildRateLimitConfig()) {
  const counters = new Map();

  function allow(routeKey, identity) {
    const windowMs = Math.max(1000, config.windowMs || DEFAULT_RATE_LIMIT_WINDOW_MS);
    const limit = config[routeKey];
    if (!Number.isFinite(limit) || limit <= 0) {
      return { ok: true };
    }
    const now = Date.now();
    const bucketKey = `${routeKey}:${identity}`;
    const bucket = counters.get(bucketKey) || [];
    const active = bucket.filter((timestamp) => now - timestamp < windowMs);
    if (active.length >= limit) {
      counters.set(bucketKey, active);
      return {
        ok: false,
        retryAfterMs: Math.max(1000, windowMs - (now - active[0]))
      };
    }
    active.push(now);
    counters.set(bucketKey, active);
    return { ok: true };
  }

  return {
    config,
    allow
  };
}

function requestIdentityForRateLimit(req, auth = null) {
  return `${getClientAddress(req)}:${auth?.user_id || auth?.seller_id || auth?.admin_id || "anonymous"}`;
}

function buildReviewTransportConfig() {
  const baseUrl = process.env.REVIEW_TRANSPORT_BASE_URL || process.env.TRANSPORT_BASE_URL || null;
  if (!baseUrl) {
    return null;
  }
  return {
    baseUrl,
    receiver: REVIEW_TEST_RECEIVER_PREFIX
  };
}

function createReviewTransport() {
  const config = buildReviewTransportConfig();
  if (!config) {
    return null;
  }
  return createRelayHttpTransportAdapter(config);
}

function buildReviewResultReceiver(requestId) {
  return `${REVIEW_TEST_RECEIVER_PREFIX}-${requestId}`;
}

function buildReviewResultAddress(requestId) {
  return `local://relay/${buildReviewResultReceiver(requestId)}/${requestId}`;
}

function isSellerRoutable(seller) {
  return seller?.review_status === "approved" && seller?.status === "enabled";
}

function isSubagentRoutable(item) {
  return item?.review_status === "approved" && item?.status === "enabled";
}

function resolveCatalogVisibility(state, item) {
  if (!item) {
    return "hidden";
  }
  const seller = state.sellers.get(item.seller_id);
  return isSellerRoutable(seller) && isSubagentRoutable(item) ? "public" : "hidden";
}

function isOperatorAuth(auth, state) {
  if (!auth) {
    return false;
  }
  if (auth.type === "admin") {
    return true;
  }
  if (auth.type !== "buyer") {
    return false;
  }
  const user = state.users.get(auth.user_id);
  return (user?.roles || []).includes("admin");
}

function canManageSeller(auth, seller) {
  if (!auth || !seller) {
    return false;
  }
  if (auth.type === "buyer") {
    return seller.owner_user_id === auth.user_id;
  }
  if (auth.type === "seller") {
    return auth.seller_id === seller.seller_id;
  }
  return false;
}

function canViewCatalogItemDetail(state, auth, item) {
  if (!item) {
    return false;
  }
  if (resolveCatalogVisibility(state, item) === "public") {
    return true;
  }
  if (isOperatorAuth(auth, state)) {
    return true;
  }
  const seller = state.sellers.get(item.seller_id);
  return canManageSeller(auth, seller) || (auth?.type === "seller" && auth.subagent_ids?.includes(item.subagent_id));
}

function sanitizeCatalogItemForResponse(state, item) {
  return {
    ...sanitizeCatalogItem(item),
    catalog_visibility: resolveCatalogVisibility(state, item)
  };
}

function summarizeReviewTest(reviewTest) {
  if (!reviewTest) {
    return null;
  }
  return {
    request_id: reviewTest.request_id,
    seller_id: reviewTest.seller_id,
    subagent_id: reviewTest.subagent_id,
    status: reviewTest.status,
    verdict: reviewTest.verdict,
    failure_code: reviewTest.failure_code || null,
    started_at: reviewTest.started_at,
    finished_at: reviewTest.finished_at || null,
    result_summary: reviewTest.result_summary || null
  };
}

function findLatestReviewTest(state, subagentId) {
  const matches = Array.from(state.reviewTests.values())
    .filter((item) => item.subagent_id === subagentId)
    .sort((left, right) => String(right.started_at || "").localeCompare(String(left.started_at || "")));
  return matches[0] || null;
}

function buildCatalogDetail(state, item) {
  const submission = state.submissions.get(item.subagent_id) || null;
  return {
    ...item,
    catalog_visibility: resolveCatalogVisibility(state, item),
    latest_review_test: summarizeReviewTest(findLatestReviewTest(state, item.subagent_id)),
    submission:
      submission && {
        submission_version: submission.submission_version,
        submitted_at: submission.submitted_at,
        submitted_by: submission.submitted_by,
        review_reason: submission.review_reason || null,
        submitted_payload: cloneValue(submission.submitted_payload)
      }
  };
}

function buildCatalogAdminSummary(state, item) {
  return {
    ...item,
    catalog_visibility: resolveCatalogVisibility(state, item),
    latest_review_test: summarizeReviewTest(findLatestReviewTest(state, item.subagent_id))
  };
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function registerBuyerUser(state, body) {
  const contactEmail = body.contact_email || body.email;
  if (!contactEmail) {
    return { error: { code: "CONTRACT_INVALID_REGISTER_BODY", message: "contact_email is required", retryable: false }, statusCode: 400 };
  }

  const user = {
    user_id: randomId("user"),
    contact_email: contactEmail,
    api_key: `sk_buyer_${crypto.randomBytes(12).toString("hex")}`,
    roles: ["buyer"],
    created_at: nowIso()
  };

  state.users.set(user.user_id, user);
  state.apiKeys.set(user.api_key, {
    type: "buyer",
    user_id: user.user_id,
    scopes: ["buyer"]
  });

  return user;
}

function addUserRole(state, userId, role) {
  const user = state.users.get(userId);
  if (!user) {
    return null;
  }
  const roles = new Set(user.roles || []);
  roles.add(role);
  user.roles = Array.from(roles);
  for (const apiKeyRecord of state.apiKeys.values()) {
    if (apiKeyRecord.type === "buyer" && apiKeyRecord.user_id === userId) {
      const scopes = new Set(apiKeyRecord.scopes || ["buyer"]);
      scopes.add(role);
      apiKeyRecord.scopes = Array.from(scopes);
    }
  }
  return user;
}

function revokeApiKey(state, apiKey) {
  const record = state.apiKeys.get(apiKey);
  if (!record) {
    return null;
  }
  state.apiKeys.delete(apiKey);
  if (record.type === "buyer") {
    const user = state.users.get(record.user_id);
    if (user?.api_key === apiKey) {
      user.api_key = null;
    }
  }
  if (record.type === "seller") {
    const seller = state.sellers.get(record.seller_id);
    if (seller?.api_key === apiKey) {
      seller.api_key = null;
    }
  }
  return record;
}

function rotateBuyerApiKey(state, userId) {
  const user = state.users.get(userId);
  if (!user) {
    return null;
  }
  if (user.api_key) {
    revokeApiKey(state, user.api_key);
  }
  const apiKey = `sk_buyer_${crypto.randomBytes(12).toString("hex")}`;
  user.api_key = apiKey;
  state.apiKeys.set(apiKey, {
    type: "buyer",
    user_id: user.user_id,
    scopes: ["buyer", ...(user.roles || []).filter((role) => role !== "buyer")]
  });
  return {
    user_id: user.user_id,
    api_key: apiKey,
    roles: user.roles
  };
}

function rotateSellerApiKey(state, sellerId) {
  const seller = state.sellers.get(sellerId);
  if (!seller) {
    return null;
  }
  if (seller.api_key) {
    revokeApiKey(state, seller.api_key);
  }
  const apiKey = `sk_seller_${crypto.randomBytes(12).toString("hex")}`;
  seller.api_key = apiKey;
  state.apiKeys.set(apiKey, {
    type: "seller",
    seller_id: seller.seller_id,
    owner_user_id: seller.owner_user_id,
    scopes: seller.scopes,
    subagent_ids: seller.subagent_ids
  });
  return {
    seller_id: seller.seller_id,
    api_key: apiKey,
    subagent_ids: seller.subagent_ids
  };
}

function rotateSellerSigningKey(state, sellerId, body = {}) {
  const seller = state.sellers.get(sellerId);
  if (!seller) {
    return null;
  }
  const nextPublicKeyPem = body.seller_public_key_pem || body.next_public_key_pem;
  if (!nextPublicKeyPem) {
    return {
      error: {
        code: "CONTRACT_INVALID_SIGNING_KEY_ROTATION",
        message: "seller_public_key_pem is required",
        retryable: false
      },
      statusCode: 400
    };
  }
  const previousKeys = Array.isArray(body.previous_public_keys_pem)
    ? body.previous_public_keys_pem.filter(Boolean)
    : seller.seller_public_key_pem
      ? [seller.seller_public_key_pem]
      : [];
  const allKeys = Array.from(new Set([nextPublicKeyPem, ...previousKeys]));
  seller.seller_public_key_pem = nextPublicKeyPem;
  seller.seller_public_keys_pem = allKeys;
  seller.signing_key_rotation_window_until = body.rotation_window_until || null;

  for (const item of state.catalog.values()) {
    if (item.seller_id !== sellerId) {
      continue;
    }
    item.seller_public_key_pem = nextPublicKeyPem;
    item.seller_public_keys_pem = allKeys;
    item.signing_key_rotation_window_until = body.rotation_window_until || null;
  }

  return {
    seller_id: sellerId,
    seller_public_key_pem: nextPublicKeyPem,
    seller_public_keys_pem: allKeys,
    rotation_window_until: body.rotation_window_until || null
  };
}

async function persistPlatformState(onStateChanged, state) {
  if (typeof onStateChanged === "function") {
    await onStateChanged(state);
  }
}

export function createPlatformState(options = {}) {
  const tokenSecret = options.tokenSecret || process.env.TOKEN_SECRET || crypto.randomBytes(32);
  const tokenTtlSeconds = Number(options.tokenTtlSeconds || process.env.TOKEN_TTL_SECONDS || 300);
  const adminApiKey =
    options.adminApiKey || process.env.PLATFORM_ADMIN_API_KEY || `sk_admin_${crypto.randomBytes(12).toString("hex")}`;
  const bootstrapEnabled =
    options.bootstrapEnabled !== undefined
      ? Boolean(options.bootstrapEnabled)
      : readBooleanEnv(process.env.ENABLE_BOOTSTRAP_SELLERS, true);
  const bootstrapSellerSigning =
    process.env.BOOTSTRAP_SELLER_PUBLIC_KEY_PEM && process.env.BOOTSTRAP_SELLER_PRIVATE_KEY_PEM
      ? {
          publicKeyPem: decodePemEnv(process.env.BOOTSTRAP_SELLER_PUBLIC_KEY_PEM),
          privateKeyPem: decodePemEnv(process.env.BOOTSTRAP_SELLER_PRIVATE_KEY_PEM)
        }
      : null;

  const bootstrapSellers = bootstrapEnabled
    ? [
        createSellerIdentity({
          sellerId: process.env.BOOTSTRAP_SELLER_ID || "seller_foxlab",
          subagentId: process.env.BOOTSTRAP_SUBAGENT_ID || "foxlab.text.classifier.v1",
          templateRef: "foxlab/text-classifier@v1",
          displayName: "Foxlab Text Classifier",
          taskDeliveryAddress:
            process.env.BOOTSTRAP_TASK_DELIVERY_ADDRESS || "local://relay/seller_foxlab/foxlab.text.classifier.v1",
          taskTypes: ["text_classify"],
          capabilities: ["text.classify", "document.classify"],
          tags: ["nlp", "classification"],
          apiKey: process.env.BOOTSTRAP_SELLER_API_KEY || null,
          ownerUserId: process.env.BOOTSTRAP_SELLER_OWNER_USER_ID || null,
          signing: bootstrapSellerSigning
        }),
        createSellerIdentity({
          sellerId: "seller_northwind",
          subagentId: "northwind.copywriter.v1",
          templateRef: "northwind/copywriter@v1",
          displayName: "Northwind Copywriter",
          taskDeliveryAddress: "local://relay/seller_northwind/northwind.copywriter.v1",
          taskTypes: ["copywrite"],
          capabilities: ["marketing.copywrite", "text.generate"],
          tags: ["marketing", "copywriting"]
        })
      ]
    : [];

  const users = new Map();
  const apiKeys = new Map();
  const sellers = new Map();
  const catalog = new Map();
  const templates = new Map();
  const requests = new Map();
  const submissions = new Map();
  const reviewTests = new Map();
  const metricsEvents = [];
  const auditEvents = [];
  const reviewEvents = [];

  apiKeys.set(adminApiKey, {
    type: "admin",
    admin_id: "platform_admin",
    scopes: ["admin", "operator"]
  });

  for (const item of bootstrapSellers) {
    sellers.set(item.seller.seller_id, item.seller);
    apiKeys.set(item.seller.api_key, {
      type: "seller",
      seller_id: item.seller.seller_id,
      owner_user_id: item.seller.owner_user_id,
      scopes: item.seller.scopes,
      subagent_ids: item.seller.subagent_ids
    });
    catalog.set(item.catalogItem.subagent_id, { ...item.catalogItem });
    templates.set(
      item.catalogItem.template_ref,
      createTemplateBundle(item.catalogItem.template_ref, {
        inputSchema: item.catalogItem.input_schema,
        outputSchema: item.catalogItem.output_schema
      })
    );
  }

  return {
    tokenSecret,
    tokenTtlSeconds,
    limits: options.limits || buildPlatformLimits(),
    users,
    apiKeys,
    sellers,
    catalog,
    templates,
    requests,
    submissions,
    reviewTests,
    metricsEvents,
    auditEvents,
    reviewEvents,
    adminApiKey,
    bootstrap: {
      sellers: bootstrapSellers.map((item) => ({
        seller_id: item.seller.seller_id,
        subagent_id: item.catalogItem.subagent_id,
        api_key: item.seller.api_key,
        signing: item.signing
      }))
    }
  };
}

export function serializePlatformState(state) {
  return {
    users: Array.from(state.users.entries()),
    apiKeys: Array.from(state.apiKeys.entries()),
    sellers: Array.from(state.sellers.entries()),
    catalog: Array.from(state.catalog.entries()),
    templates: Array.from(state.templates.entries()),
    requests: Array.from(state.requests.entries()),
    submissions: Array.from(state.submissions.entries()),
    reviewTests: Array.from(state.reviewTests.entries()),
    metricsEvents: state.metricsEvents,
    auditEvents: state.auditEvents,
    reviewEvents: state.reviewEvents
  };
}

export function hydratePlatformState(state, snapshot) {
  if (!snapshot) {
    return state;
  }

  for (const [name, collection] of [
    ["users", state.users],
    ["apiKeys", state.apiKeys],
    ["sellers", state.sellers],
    ["catalog", state.catalog],
    ["templates", state.templates],
    ["requests", state.requests],
    ["submissions", state.submissions],
    ["reviewTests", state.reviewTests]
  ]) {
    collection.clear();
    for (const [key, value] of snapshot[name] || []) {
      collection.set(key, value);
    }
  }

  state.metricsEvents.splice(0, state.metricsEvents.length, ...(snapshot.metricsEvents || []));
  state.auditEvents.splice(0, state.auditEvents.length, ...(snapshot.auditEvents || []));
  state.reviewEvents.splice(0, state.reviewEvents.length, ...(snapshot.reviewEvents || []));
  return state;
}

function resolveAuth(req, state) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }
  return state.apiKeys.get(match[1]) || null;
}

function requireAuth(req, res, state) {
  const auth = resolveAuth(req, state);
  if (!auth) {
    sendError(res, 401, "AUTH_UNAUTHORIZED", "API key is missing or invalid");
    return null;
  }
  return auth;
}

function requireBuyer(req, res, state) {
  const auth = requireAuth(req, res, state);
  if (!auth) {
    return null;
  }
  if (auth.type !== "buyer") {
    sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "caller lacks the required buyer scope");
    return null;
  }
  return auth;
}

function requireSeller(req, res, state, { sellerId, subagentId } = {}) {
  const auth = requireAuth(req, res, state);
  if (!auth) {
    return null;
  }
  if (auth.type !== "seller") {
    sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "caller lacks the required seller scope");
    return null;
  }
  if (sellerId && auth.seller_id !== sellerId) {
    sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "seller_id does not match caller identity");
    return null;
  }
  if (subagentId && !auth.subagent_ids.includes(subagentId)) {
    sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "subagent_id is not owned by caller");
    return null;
  }
  return auth;
}

function requireOperator(req, res, state) {
  const auth = requireAuth(req, res, state);
  if (!auth) {
    return null;
  }
  if (auth.type === "admin") {
    return auth;
  }
  if (auth.type !== "buyer") {
    sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "caller lacks the required scope");
    return null;
  }
  const user = state.users.get(auth.user_id);
  if (!(user?.roles || []).includes("admin")) {
    sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "caller does not have admin role");
    return null;
  }
  return auth;
}

function getOrCreateRequest(state, requestId) {
  let request = state.requests.get(requestId);
  if (!request) {
    request = {
      request_id: requestId,
      buyer_id: null,
      seller_id: null,
      subagent_id: null,
      delivery_meta: null,
      expected_signer_public_key_pem: null,
      events: []
    };
    state.requests.set(requestId, request);
  }
  return request;
}

function normalizeResultDelivery(input = {}) {
  if (!input || typeof input !== "object") {
    return { error: { code: "CONTRACT_INVALID_RESULT_DELIVERY", message: "result_delivery is required", retryable: false }, statusCode: 400 };
  }

  const kind = typeof input.kind === "string" ? input.kind.trim() : "";
  const address = typeof input.address === "string" ? input.address.trim() : "";
  if (!kind || !address) {
    return {
      error: {
        code: "CONTRACT_INVALID_RESULT_DELIVERY",
        message: "result_delivery.kind and result_delivery.address are required",
        retryable: false
      },
      statusCode: 400
    };
  }

  if (kind === "platform_inbox") {
    return {
      error: {
        code: "RESULT_DELIVERY_KIND_NOT_IMPLEMENTED",
        message: "result_delivery.kind 'platform_inbox' is reserved but not implemented",
        retryable: false
      },
      statusCode: 501
    };
  }

  if (!["email", "local", "relay_http"].includes(kind)) {
    return {
      error: {
        code: "CONTRACT_INVALID_RESULT_DELIVERY",
        message: `unsupported result_delivery.kind '${kind}'`,
        retryable: false
      },
      statusCode: 400
    };
  }

  return {
    kind,
    address
  };
}

function appendRequestEvent(request, eventType, detail = {}) {
  pushCapped(request.events, {
    at: nowIso(),
    event_type: eventType,
    ...detail
  }, readNumberEnv(process.env.PLATFORM_REQUEST_EVENT_HISTORY_LIMIT, DEFAULT_REQUEST_EVENT_HISTORY_LIMIT));
}

function findMatchingRequestEvent(request, { eventType, sellerId, subagentId }) {
  return (request.events || []).find(
    (event) => event.event_type === eventType && event.seller_id === sellerId && event.subagent_id === subagentId
  );
}

function buildSellerAdminSummary(state, seller, catalogItems = []) {
  return {
    seller_id: seller.seller_id,
    owner_user_id: seller.owner_user_id,
    contact_email: seller.contact_email,
    support_email: seller.support_email,
    status: seller.status || "disabled",
    review_status: seller.review_status || "pending",
    reviewed_at: seller.reviewed_at || null,
    reviewed_by: seller.reviewed_by || null,
    review_reason: seller.review_reason || null,
    availability_status: seller.availability_status,
    last_heartbeat_at: seller.last_heartbeat_at,
    subagent_ids: seller.subagent_ids,
    subagent_count: catalogItems.length,
    subagents: catalogItems.map((item) => ({
      subagent_id: item.subagent_id,
      display_name: item.display_name,
      status: item.status,
      review_status: item.review_status || "pending",
      catalog_visibility: resolveCatalogVisibility(state, item),
      availability_status: resolveCatalogAvailability(item),
      task_types: item.task_types || [],
      capabilities: item.capabilities || [],
      tags: item.tags || []
    }))
  };
}

function buildRequestAdminSummary(request) {
  return {
    request_id: request.request_id,
    buyer_id: request.buyer_id,
    seller_id: request.seller_id,
    subagent_id: request.subagent_id,
    request_kind: request.request_kind || "remote_request",
    request_visibility: request.request_visibility || "public",
    event_count: Array.isArray(request.events) ? request.events.length : 0,
    latest_event: Array.isArray(request.events) && request.events.length > 0 ? request.events[request.events.length - 1] : null
  };
}

function describeActor(auth) {
  if (!auth) {
    return { actor_type: "system", actor_id: null };
  }
  if (auth.type === "admin") {
    return { actor_type: "admin", actor_id: auth.admin_id || "platform_admin" };
  }
  if (auth.type === "buyer") {
    return { actor_type: "buyer", actor_id: auth.user_id };
  }
  return { actor_type: auth.type || "unknown", actor_id: auth.user_id || auth.seller_id || null };
}

function appendAuditEvent(state, auth, action, target, detail = {}) {
  pushCapped(state.auditEvents, {
    id: randomId("audit"),
    action,
    target_type: target.type,
    target_id: target.id,
    recorded_at: nowIso(),
    ...describeActor(auth),
    ...detail
  }, telemetryHistoryLimit(state));
}

function appendReviewEvent(state, auth, reviewStatus, target, detail = {}) {
  pushCapped(state.reviewEvents, {
    id: randomId("review"),
    review_status: reviewStatus,
    target_type: target.type,
    target_id: target.id,
    recorded_at: nowIso(),
    ...describeActor(auth),
    ...detail
  }, telemetryHistoryLimit(state));
}

function buildSubmissionPayload(body) {
  return {
    seller_id: body.seller_id,
    subagent_id: body.subagent_id,
    display_name: body.display_name,
    description: body.description || null,
    template_ref: body.template_ref || `${body.subagent_id}@v1`,
    seller_public_key_pem: body.seller_public_key_pem,
    task_delivery_address: body.task_delivery_address || `local://relay/${body.seller_id}/${body.subagent_id}`,
    task_types: normalizeStringList(body.task_types),
    capabilities: normalizeStringList(body.capabilities),
    tags: normalizeStringList(body.tags),
    input_schema: body.input_schema || null,
    output_schema: body.output_schema || null,
    contact_email: body.contact_email || null,
    support_email: body.support_email || null
  };
}

function determineSubmissionVersion(state, subagentId) {
  const current = state.submissions.get(subagentId);
  return Number(current?.submission_version || 0) + 1;
}

function createTaskClaims(state, {
  buyerId,
  requestId,
  sellerId,
  subagentId,
  requestKind = "remote_request"
}) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const tokenTtlSeconds = Number(process.env.TOKEN_TTL_SECONDS || state.tokenTtlSeconds);
  const claims = {
    iss: "delexec-platform-api",
    sub: buyerId,
    aud: sellerId,
    jti: randomId("tok"),
    iat: issuedAt,
    exp: issuedAt + tokenTtlSeconds,
    buyer_id: buyerId,
    request_id: requestId,
    seller_id: sellerId,
    subagent_id: subagentId,
    request_kind: requestKind
  };
  return {
    claims,
    task_token: signToken(state.tokenSecret, claims)
  };
}

function createDeliveryMeta(state, request, catalogItem, resultDelivery) {
  request.expected_signer_public_key_pem = catalogItem.seller_public_key_pem;
  request.delivery_meta = {
    request_id: request.request_id,
    seller_id: catalogItem.seller_id,
    subagent_id: catalogItem.subagent_id,
    task_delivery: {
      kind: catalogItem.task_delivery_address.startsWith("local://") ? "local" : "email",
      address: catalogItem.task_delivery_address,
      thread_hint: `req:${request.request_id}`
    },
    result_delivery: {
      kind: resultDelivery.kind,
      address: resultDelivery.address,
      thread_hint: `req:${request.request_id}`
    },
    verification: {
      display_code: request.delivery_meta?.verification?.display_code || createDisplayCode()
    },
    seller_public_key_pem: catalogItem.seller_public_key_pem
  };
  return request.delivery_meta;
}

function extractResultPackageFromEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  if (envelope.result_package) {
    return envelope.result_package;
  }
  if (envelope.payload?.result_package) {
    return envelope.payload.result_package;
  }
  if (typeof envelope.body_text === "string" && envelope.body_text.trim()) {
    try {
      return JSON.parse(envelope.body_text);
    } catch {
      return null;
    }
  }
  return null;
}

function verifyReviewResult(request, resultPackage) {
  if (!resultPackage || typeof resultPackage !== "object") {
    return { ok: false, code: "RESULT_BODY_INVALID_JSON", summary: "review test result body is missing or invalid" };
  }
  if (
    resultPackage.request_id !== request.request_id ||
    resultPackage.seller_id !== request.seller_id ||
    resultPackage.subagent_id !== request.subagent_id
  ) {
    return { ok: false, code: "RESULT_CONTEXT_MISMATCH", summary: "review test result does not match request context" };
  }
  if (resultPackage.result_version && resultPackage.result_version !== "0.1.0") {
    return { ok: false, code: "RESULT_CONTEXT_MISMATCH", summary: "unsupported result version for review test" };
  }
  if (request.delivery_meta?.verification?.display_code) {
    if (resultPackage.verification?.display_code !== request.delivery_meta.verification.display_code) {
      return { ok: false, code: "RESULT_CONTEXT_MISMATCH", summary: "review test verification code mismatch" };
    }
  }
  if (!resultPackage.signature_base64 || !request.expected_signer_public_key_pem) {
    return { ok: false, code: "RESULT_SIGNATURE_INVALID", summary: "review test signature is missing" };
  }
  try {
    const signingBytes = Buffer.from(JSON.stringify(canonicalizeResultPackageForSignature(resultPackage)), "utf8");
    const signature = Buffer.from(resultPackage.signature_base64, "base64");
    const publicKey = crypto.createPublicKey(request.expected_signer_public_key_pem);
    const verified = crypto.verify(null, signingBytes, publicKey, signature);
    if (!verified) {
      return { ok: false, code: "RESULT_SIGNATURE_INVALID", summary: "review test signature validation failed" };
    }
  } catch {
    return { ok: false, code: "RESULT_SIGNATURE_INVALID", summary: "review test signature validation failed" };
  }
  if (resultPackage.schema_valid === false) {
    return { ok: false, code: "RESULT_SCHEMA_INVALID", summary: "review test returned schema_valid=false" };
  }
  if (resultPackage.status !== "ok") {
    return {
      ok: false,
      code: resultPackage.error?.code || "EXEC_UNKNOWN",
      summary: resultPackage.error?.message || "review test execution returned error status"
    };
  }
  return {
    ok: true,
    code: null,
    summary: resultPackage.output ? JSON.stringify(resultPackage.output) : "review test passed"
  };
}

async function runReviewTestHarness(state, reviewTest, request, transport, onStateChanged) {
  const receiver = buildReviewResultReceiver(request.request_id);
  const timeoutMs = Number(reviewTest.timeout_ms || Math.max(5000, Number(reviewTest.constraints?.hard_timeout_s || 10) * 1000));
  const deadline = Date.now() + timeoutMs;

  await transport.send({
    message_id: `msg_review_${crypto.randomUUID()}`,
    thread_id: `req:${request.request_id}`,
    from: REVIEW_TEST_BUYER_ID,
    to: request.delivery_meta.task_delivery.address,
    type: "task.requested",
    request_id: request.request_id,
    seller_id: request.seller_id,
    subagent_id: request.subagent_id,
    task_token: reviewTest.task_token,
    result_delivery: request.delivery_meta.result_delivery,
    verification: request.delivery_meta.verification,
    payload: reviewTest.task_input,
    task_input: reviewTest.task_input,
    constraints: reviewTest.constraints || null,
    sent_at: nowIso()
  });

  while (Date.now() < deadline) {
    const polled = await transport.poll({ receiver, limit: 5 });
    const envelope = (polled.items || []).find((item) => item.request_id === request.request_id);
    if (envelope) {
      const resultPackage = extractResultPackageFromEnvelope(envelope);
      await transport.ack(envelope.message_id, { receiver });
      const verification = verifyReviewResult(request, resultPackage);
      reviewTest.status = "completed";
      reviewTest.verdict = verification.ok ? "pass" : "fail";
      reviewTest.failure_code = verification.code;
      reviewTest.result_summary = verification.summary;
      reviewTest.result_package = resultPackage;
      reviewTest.finished_at = nowIso();
      await persistPlatformState(onStateChanged, state);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  reviewTest.status = "completed";
  reviewTest.verdict = "fail";
  reviewTest.failure_code = "EXEC_TIMEOUT";
  reviewTest.result_summary = "review test timed out waiting for result";
  reviewTest.finished_at = nowIso();
  await persistPlatformState(onStateChanged, state);
}

function matchesQuery(value, query) {
  if (!query) {
    return true;
  }
  return JSON.stringify(value).toLowerCase().includes(query.toLowerCase());
}

function parsePagination(url) {
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  return { limit, offset };
}

function paginateItems(items, { limit, offset }) {
  const sliced = items.slice(offset, offset + limit);
  return {
    items: sliced,
    pagination: {
      total: items.length,
      limit,
      offset,
      has_more: offset + sliced.length < items.length
    }
  };
}

function issueTaskToken(state, auth, body) {
  const catalogItem = state.catalog.get(body.subagent_id);
  const seller = state.sellers.get(body.seller_id);
  if (
    !catalogItem ||
    !seller ||
    catalogItem.seller_id !== body.seller_id ||
    resolveCatalogVisibility(state, catalogItem) !== "public"
  ) {
    return { error: { code: "CATALOG_SUBAGENT_NOT_FOUND", message: "subagent not found or not enabled", retryable: false } };
  }

  const request = getOrCreateRequest(state, body.request_id);
  if (request.buyer_id && request.buyer_id !== auth.user_id) {
    return { error: { code: "AUTH_RESOURCE_FORBIDDEN", message: "request is owned by another buyer", retryable: false }, statusCode: 403 };
  }
  if (request.seller_id && request.seller_id !== body.seller_id) {
    return { error: { code: "REQUEST_BINDING_MISMATCH", message: "seller_id or subagent_id does not match existing request", retryable: false }, statusCode: 409 };
  }
  if (request.subagent_id && request.subagent_id !== body.subagent_id) {
    return { error: { code: "REQUEST_BINDING_MISMATCH", message: "seller_id or subagent_id does not match existing request", retryable: false }, statusCode: 409 };
  }

  const issued = createTaskClaims(state, {
    buyerId: auth.user_id,
    requestId: body.request_id,
    sellerId: body.seller_id,
    subagentId: body.subagent_id
  });
  request.buyer_id = auth.user_id;
  request.seller_id = body.seller_id;
  request.subagent_id = body.subagent_id;
  request.request_kind ||= "remote_request";
  request.request_visibility ||= "public";
  appendRequestEvent(request, "TASK_TOKEN_ISSUED", { actor_type: "buyer" });

  return issued;
}

function submitCatalogSubagent(state, body, auth = null, { allowUnauthenticatedCreate = false } = {}) {
  if (!body.seller_id || !body.subagent_id || !body.display_name || !body.seller_public_key_pem) {
    return {
      error: {
        code: "CONTRACT_INVALID_SELLER_REGISTER_BODY",
        message: "seller_id, subagent_id, display_name, and seller_public_key_pem are required",
        retryable: false
      },
      statusCode: 400
    };
  }

  const existingSeller = state.sellers.get(body.seller_id) || null;
  const existingItem = state.catalog.get(body.subagent_id) || null;
  if (existingItem && existingItem.seller_id !== body.seller_id) {
    return {
      error: { code: "SUBAGENT_ID_ALREADY_EXISTS", message: "a subagent with this id is already registered", retryable: false },
      statusCode: 409
    };
  }

  if (existingSeller && !existingItem && (existingSeller.subagent_ids || []).length >= (state.limits?.subagentsPerSeller || DEFAULT_SUBAGENT_QUOTA_PER_SELLER)) {
    return {
      error: {
        code: "SUBAGENT_QUOTA_EXCEEDED",
        message: `seller has reached the configured subagent quota of ${state.limits?.subagentsPerSeller || DEFAULT_SUBAGENT_QUOTA_PER_SELLER}`,
        retryable: false
      },
      statusCode: 429
    };
  }

  if (!existingSeller && !auth && !allowUnauthenticatedCreate) {
    return {
      error: { code: "AUTH_UNAUTHORIZED", message: "buyer or seller authentication is required for onboarding", retryable: false },
      statusCode: 401
    };
  }

  if (existingSeller) {
    if (!auth) {
      return {
        error: { code: "AUTH_UNAUTHORIZED", message: "authentication required to manage an existing seller", retryable: false },
        statusCode: 401
      };
    }
    if (!canManageSeller(auth, existingSeller)) {
      return {
        error: { code: "AUTH_RESOURCE_FORBIDDEN", message: "caller does not own this seller identity", retryable: false },
        statusCode: 403
      };
    }
  }

  const submissionPayload = buildSubmissionPayload(body);
  const ownerUserId = existingSeller?.owner_user_id || auth?.user_id || body.owner_user_id || randomId("user");
  const sellerApiKey = existingSeller?.api_key || `sk_seller_${crypto.randomBytes(12).toString("hex")}`;
  const heartbeatAt = nowIso();
  const templateRef = submissionPayload.template_ref;
  const submissionVersion = determineSubmissionVersion(state, body.subagent_id);

  const seller = existingSeller || {
    seller_id: body.seller_id,
    owner_user_id: ownerUserId,
    api_key: sellerApiKey,
    scopes: ["seller"],
    subagent_ids: [],
    status: "disabled",
    review_status: "pending",
    reviewed_at: null,
    reviewed_by: null,
    review_reason: null,
    seller_public_key_pem: body.seller_public_key_pem,
    seller_public_keys_pem: existingSeller?.seller_public_keys_pem || [body.seller_public_key_pem],
    last_heartbeat_at: heartbeatAt,
    availability_status: "healthy",
    contact_email: body.contact_email || state.users.get(ownerUserId)?.contact_email || `${body.seller_id}@test.local`,
    support_email: body.support_email || `support+${body.seller_id}@test.local`
  };

  const sellerChanged =
    !existingSeller ||
    seller.contact_email !== (body.contact_email || seller.contact_email) ||
    seller.support_email !== (body.support_email || seller.support_email) ||
    seller.seller_public_key_pem !== body.seller_public_key_pem;

  seller.contact_email = body.contact_email || seller.contact_email;
  seller.support_email = body.support_email || seller.support_email;
  seller.seller_public_key_pem = body.seller_public_key_pem;
  seller.seller_public_keys_pem = Array.from(new Set([body.seller_public_key_pem, ...(seller.seller_public_keys_pem || [])]));
  seller.subagent_ids = Array.from(new Set([...(seller.subagent_ids || []), body.subagent_id]));
  seller.last_heartbeat_at = seller.last_heartbeat_at || heartbeatAt;
  seller.availability_status ||= "healthy";
  if (!existingSeller || sellerChanged) {
    seller.review_status = "pending";
    seller.status = "disabled";
    seller.reviewed_at = null;
    seller.reviewed_by = null;
    seller.review_reason = null;
  }

  const catalogItem = {
    seller_id: body.seller_id,
    subagent_id: body.subagent_id,
    display_name: body.display_name,
    description: body.description || existingItem?.description || null,
    status: "disabled",
    review_status: "pending",
    submission_version: submissionVersion,
    submitted_at: heartbeatAt,
    reviewed_at: null,
    reviewed_by: null,
    review_reason: null,
    availability_status: existingItem?.availability_status || "healthy",
    last_heartbeat_at: existingItem?.last_heartbeat_at || heartbeatAt,
    template_ref: templateRef,
    task_types: submissionPayload.task_types,
    capabilities: submissionPayload.capabilities,
    tags: submissionPayload.tags,
    input_schema: submissionPayload.input_schema,
    output_schema: submissionPayload.output_schema,
    seller_public_key_pem: submissionPayload.seller_public_key_pem,
    seller_public_keys_pem: seller.seller_public_keys_pem,
    task_delivery_address: submissionPayload.task_delivery_address
  };

  state.sellers.set(seller.seller_id, seller);
  state.apiKeys.set(sellerApiKey, {
    type: "seller",
    seller_id: seller.seller_id,
    owner_user_id: ownerUserId,
    scopes: seller.scopes,
    subagent_ids: seller.subagent_ids
  });
  state.catalog.set(catalogItem.subagent_id, catalogItem);
  state.templates.set(
    templateRef,
    createTemplateBundle(templateRef, {
      inputSchema: catalogItem.input_schema,
      outputSchema: catalogItem.output_schema
    })
  );
  state.submissions.set(catalogItem.subagent_id, {
    seller_id: seller.seller_id,
    subagent_id: catalogItem.subagent_id,
    owner_user_id: ownerUserId,
    submitted_at: heartbeatAt,
    submitted_by: auth?.user_id || auth?.seller_id || "system",
    review_reason: body.review_reason || body.reason || null,
    submission_version: submissionVersion,
    submitted_payload: submissionPayload,
    latest_review_test_request_id: existingItem ? state.submissions.get(catalogItem.subagent_id)?.latest_review_test_request_id || null : null
  });

  if (auth?.user_id) {
    addUserRole(state, auth.user_id, "seller");
  }

  if (!existingSeller || sellerChanged) {
    appendReviewEvent(
      state,
      auth,
      "pending",
      { type: "seller", id: seller.seller_id },
      {
        seller_id: seller.seller_id,
        subagent_id: catalogItem.subagent_id,
        submission_version: submissionVersion,
        reason: body.review_reason || body.reason || null
      }
    );
  }
  appendReviewEvent(
    state,
    auth,
    "pending",
    { type: "subagent", id: catalogItem.subagent_id },
    {
      seller_id: seller.seller_id,
      subagent_id: catalogItem.subagent_id,
      submission_version: submissionVersion,
      reason: body.review_reason || body.reason || null
    }
  );

  return {
    seller_id: seller.seller_id,
    subagent_id: catalogItem.subagent_id,
    seller_api_key: sellerApiKey,
    api_key: sellerApiKey,
    owner_user_id: ownerUserId,
    task_delivery_address: catalogItem.task_delivery_address,
    seller_public_key_pem: catalogItem.seller_public_key_pem,
    status: catalogItem.status,
    seller_status: seller.status,
    subagent_status: catalogItem.status,
    seller_review_status: seller.review_status,
    subagent_review_status: catalogItem.review_status,
    review_status: catalogItem.review_status,
    catalog_visibility: resolveCatalogVisibility(state, catalogItem),
    submission_version: submissionVersion,
    task_types: catalogItem.task_types,
    capabilities: catalogItem.capabilities,
    tags: catalogItem.tags
  };
}

function registerSellerIdentity(state, body, auth = null) {
  return submitCatalogSubagent(state, body, auth, {
    allowUnauthenticatedCreate: true
  });
}

export function createPlatformServer({
  state = createPlatformState(),
  serviceName = "platform-api",
  onStateChanged = null
} = {}) {
  const rateLimiter = createRateLimiter();
  const metricsBearerToken = process.env.PROMETHEUS_METRICS_BEARER_TOKEN || null;

  function enforceRateLimit(req, res, routeKey, auth = null) {
    const attempt = rateLimiter.allow(routeKey, requestIdentityForRateLimit(req, auth));
    if (attempt.ok) {
      return true;
    }
    res.setHeader("retry-after", String(Math.max(1, Math.ceil((attempt.retryAfterMs || 1000) / 1000))));
    sendError(res, 429, "RATE_LIMITED", "request rate limit exceeded", {
      retryable: true
    });
    return false;
  }

  function requireMetricsAccess(req, res) {
    if (!metricsBearerToken) {
      return true;
    }
    const auth = req.headers.authorization || "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match?.[1] === metricsBearerToken) {
      return true;
    }
    sendError(res, 401, "AUTH_UNAUTHORIZED", "metrics bearer token is missing or invalid");
    return false;
  }

  function renderPrometheusMetrics() {
    const lines = [
      "# HELP rsp_platform_requests_total Total requests tracked by the platform state.",
      "# TYPE rsp_platform_requests_total gauge",
      `rsp_platform_requests_total ${state.requests.size}`,
      "# HELP rsp_platform_catalog_public_subagents Total public subagents visible in catalog.",
      "# TYPE rsp_platform_catalog_public_subagents gauge",
      `rsp_platform_catalog_public_subagents ${Array.from(state.catalog.values()).filter((item) => resolveCatalogVisibility(state, item) === "public").length}`,
      "# HELP rsp_platform_metrics_events_total Total metric events retained by the platform.",
      "# TYPE rsp_platform_metrics_events_total gauge",
      `rsp_platform_metrics_events_total ${state.metricsEvents.length}`
    ];

    const byType = state.metricsEvents.reduce((acc, event) => {
      acc[event.event_type] = (acc[event.event_type] || 0) + 1;
      return acc;
    }, {});
    for (const [eventType, count] of Object.entries(byType).sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`rsp_platform_metric_event_type_total{event_type="${eventType.replace(/"/g, '\\"')}"} ${count}`);
    }

    const reviewTestCounts = Array.from(state.reviewTests.values()).reduce((acc, item) => {
      acc[item.status || "unknown"] = (acc[item.status || "unknown"] || 0) + 1;
      return acc;
    }, {});
    for (const [status, count] of Object.entries(reviewTestCounts).sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`rsp_platform_review_tests_total{status="${status.replace(/"/g, '\\"')}"} ${count}`);
    }

    return `${lines.join("\n")}\n`;
  }

  return http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;

    try {
      if (method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "Content-Type, Authorization, X-Platform-Api-Key"
        });
        res.end();
        return;
      }

      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true, service: serviceName });
        return;
      }

      if (method === "GET" && pathname === "/metrics") {
        if (!requireMetricsAccess(req, res)) {
          return;
        }
        res.writeHead(200, {
          "content-type": "text/plain; version=0.0.4; charset=utf-8"
        });
        res.end(renderPrometheusMetrics());
        return;
      }

      if (method === "GET" && pathname === "/readyz") {
        sendJson(res, 200, { ready: true, service: serviceName });
        return;
      }

      if (method === "GET" && pathname === "/") {
        sendJson(res, 200, { service: serviceName, status: "running" });
        return;
      }

      if (method === "POST" && pathname === "/v1/users/register") {
        if (!enforceRateLimit(req, res, "registerUserMax")) {
          return;
        }
        const body = await parseJsonBody(req);
        const user = registerBuyerUser(state, body);
        if (user.error) {
          sendJson(res, user.statusCode || 400, { error: user.error });
          return;
        }
        await persistPlatformState(onStateChanged, state);

        sendJson(res, 201, user);
        return;
      }

      if (method === "POST" && pathname === "/v1/sellers/register") {
        const body = await parseJsonBody(req);
        const auth = resolveAuth(req, state);
        if (auth && auth.type !== "buyer" && auth.type !== "seller") {
          sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "only buyer or seller callers may register");
          return;
        }
        if (!enforceRateLimit(req, res, "registerSellerMax", auth)) {
          return;
        }
        const registered = registerSellerIdentity(state, body, auth);
        if (registered.error) {
          sendJson(res, registered.statusCode || 400, { error: registered.error });
          return;
        }
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 201, registered);
        return;
      }

      if (method === "POST" && pathname === "/v1/catalog/subagents") {
        const auth = requireAuth(req, res, state);
        if (!auth) {
          return;
        }
        if (auth.type !== "buyer" && auth.type !== "seller") {
          sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "only buyer or seller callers may submit onboarding");
          return;
        }
        if (!enforceRateLimit(req, res, "catalogSubmitMax", auth)) {
          return;
        }

        const body = await parseJsonBody(req);
        const registered = submitCatalogSubagent(state, body, auth);
        if (registered.error) {
          sendJson(res, registered.statusCode || 400, { error: registered.error });
          return;
        }
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 201, registered);
        return;
      }

      if (method === "GET" && pathname === "/v1/catalog/subagents") {
        const statusFilter = url.searchParams.get("status") || "enabled";
        const availabilityFilter = url.searchParams.get("availability_status");
        const taskTypeFilter = url.searchParams.get("task_type");
        const capabilityFilter = url.searchParams.get("capability");
        const tagFilter = url.searchParams.get("tag");
        const items = Array.from(state.catalog.values())
          .map((item) => ({
            ...item,
            availability_status: resolveCatalogAvailability(item)
          }))
          .filter((item) => resolveCatalogVisibility(state, item) === "public")
          .filter((item) => !statusFilter || item.status === statusFilter)
          .filter((item) => !availabilityFilter || item.availability_status === availabilityFilter)
          .filter((item) => !taskTypeFilter || (item.task_types || []).includes(taskTypeFilter))
          .filter((item) => !capabilityFilter || (item.capabilities || []).includes(capabilityFilter))
          .filter((item) => !tagFilter || (item.tags || []).includes(tagFilter))
          .map((item) => sanitizeCatalogItemForResponse(state, item));

        sendJson(res, 200, { items });
        return;
      }

      const catalogDetailMatch = pathname.match(/^\/v1\/catalog\/subagents\/([^/]+)$/);
      if (method === "GET" && catalogDetailMatch) {
        const item = state.catalog.get(catalogDetailMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_SUBAGENT_NOT_FOUND", "subagent not found in catalog");
          return;
        }
        const auth = resolveAuth(req, state);
        if (!canViewCatalogItemDetail(state, auth, item)) {
          sendError(res, 404, "CATALOG_SUBAGENT_NOT_FOUND", "subagent not found in catalog");
          return;
        }
        if (resolveCatalogVisibility(state, item) === "public" && !isOperatorAuth(auth, state) && !canManageSeller(auth, state.sellers.get(item.seller_id))) {
          sendJson(res, 200, sanitizeCatalogItemForResponse(state, item));
          return;
        }
        sendJson(res, 200, buildCatalogDetail(state, item));
        return;
      }

      const templateMatch = pathname.match(/^\/v1\/catalog\/subagents\/([^/]+)\/template-bundle$/);
      if (method === "GET" && templateMatch) {
        const subagentId = templateMatch[1];
        const templateRef = url.searchParams.get("template_ref");
        const catalogItem = state.catalog.get(subagentId);
        if (!catalogItem) {
          sendError(res, 404, "TEMPLATE_NOT_FOUND", "subagent or template not found");
          return;
        }
        const auth = resolveAuth(req, state);
        if (!canViewCatalogItemDetail(state, auth, catalogItem)) {
          sendError(res, 404, "TEMPLATE_NOT_FOUND", "subagent or template not found");
          return;
        }
        if (templateRef && catalogItem.template_ref !== templateRef) {
          sendError(res, 409, "TEMPLATE_REF_MISMATCH", "template_ref does not match catalog entry");
          return;
        }
        sendJson(res, 200, state.templates.get(catalogItem.template_ref));
        return;
      }

      if (method === "POST" && pathname === "/v1/tokens/task") {
        const auth = requireBuyer(req, res, state);
        if (!auth) {
          return;
        }

        const body = await parseJsonBody(req);
        if (!body.request_id || !body.seller_id || !body.subagent_id) {
          sendError(res, 400, "CONTRACT_INVALID_TOKEN_REQUEST", "request_id, seller_id, and subagent_id are required");
          return;
        }

        const issued = issueTaskToken(state, auth, body);
        if (issued.error) {
          sendJson(res, issued.statusCode || 404, { error: issued.error });
          return;
        }
        await persistPlatformState(onStateChanged, state);

        sendJson(res, 201, issued);
        return;
      }

      if (method === "POST" && pathname === "/v1/tokens/introspect") {
        const body = await parseJsonBody(req);
        const taskToken = body.task_token || body.token;
        const parsed = parseToken(state.tokenSecret, taskToken);

        const auth = parsed.claims?.seller_id
          ? requireSeller(req, res, state, {
              sellerId: parsed.claims.seller_id,
              subagentId: parsed.claims.subagent_id
            })
          : requireAuth(req, res, state);
        if (!auth) {
          return;
        }

        if (auth.type !== "seller") {
          sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "only seller callers may introspect tokens");
          return;
        }

        if (!parsed.valid) {
          sendJson(res, 200, {
            active: false,
            error: parsed.error,
            claims: parsed.claims || null
          });
          return;
        }

        sendJson(res, 200, {
          active: true,
          claims: parsed.claims
        });
        return;
      }

      const deliveryMetaMatch = pathname.match(/^\/v1\/requests\/([^/]+)\/delivery-meta$/);
      if (method === "POST" && deliveryMetaMatch) {
        const auth = requireBuyer(req, res, state);
        if (!auth) {
          return;
        }

        const requestId = deliveryMetaMatch[1];
        const body = await parseJsonBody(req);
        const taskToken = body.task_token || body.token || null;
        if (!body.seller_id || !body.subagent_id) {
          sendError(res, 400, "CONTRACT_INVALID_DELIVERY_META_REQUEST", "seller_id and subagent_id are required");
          return;
        }
        const normalizedResultDelivery = normalizeResultDelivery(body.result_delivery);
        if (normalizedResultDelivery?.error) {
          sendError(
            res,
            normalizedResultDelivery.statusCode || 400,
            normalizedResultDelivery.error.code,
            normalizedResultDelivery.error.message
          );
          return;
        }

        const catalogItem = state.catalog.get(body.subagent_id);
        if (
          !catalogItem ||
          catalogItem.seller_id !== body.seller_id ||
          resolveCatalogVisibility(state, catalogItem) !== "public"
        ) {
          sendError(res, 404, "CATALOG_SUBAGENT_NOT_FOUND", "subagent not found or not enabled");
          return;
        }

        if (taskToken) {
          const parsed = parseToken(state.tokenSecret, taskToken);
          if (!parsed.valid) {
            sendJson(res, 401, { error: parsed.error });
            return;
          }
          if (
            parsed.claims.request_id !== requestId ||
            parsed.claims.seller_id !== body.seller_id ||
            parsed.claims.subagent_id !== body.subagent_id ||
            parsed.claims.buyer_id !== auth.user_id
          ) {
            sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "token claims do not match request parameters");
            return;
          }
        }

        const request = state.requests.get(requestId);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
          return;
        }
        if (request.buyer_id && request.buyer_id !== auth.user_id) {
          sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "request is owned by another buyer");
          return;
        }
        if (request.seller_id && request.seller_id !== body.seller_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "seller_id does not match existing request");
          return;
        }
        if (request.subagent_id && request.subagent_id !== body.subagent_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "subagent_id does not match existing request");
          return;
        }
        request.buyer_id = auth.user_id;
        request.seller_id = body.seller_id;
        request.subagent_id = body.subagent_id;
        request.request_kind ||= "remote_request";
        request.request_visibility ||= "public";
        createDeliveryMeta(state, request, catalogItem, normalizedResultDelivery);
        appendRequestEvent(request, "DELIVERY_META_ISSUED", { actor_type: "buyer" });
        await persistPlatformState(onStateChanged, state);

        sendJson(res, 200, request.delivery_meta);
        return;
      }

      const ackMatch = pathname.match(/^\/v1\/requests\/([^/]+)\/ack$/);
      if (method === "POST" && ackMatch) {
        const requestId = ackMatch[1];
        const auth = requireAuth(req, res, state);
        if (!auth) {
          return;
        }
        if (auth.type !== "seller") {
          sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "only seller callers may ack requests");
          return;
        }
        const body = await parseJsonBody(req);
        if (!body.seller_id || !body.subagent_id) {
          sendError(res, 400, "CONTRACT_INVALID_ACK_REQUEST", "seller_id and subagent_id are required");
          return;
        }
        if (auth.seller_id !== body.seller_id || !auth.subagent_ids.includes(body.subagent_id)) {
          sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "caller does not own the specified seller or subagent");
          return;
        }

        const request = state.requests.get(requestId);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
          return;
        }
        if (request.seller_id && request.seller_id !== body.seller_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "seller_id does not match existing request");
          return;
        }
        if (request.subagent_id && request.subagent_id !== body.subagent_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "subagent_id does not match existing request");
          return;
        }
        request.seller_id = body.seller_id;
        request.subagent_id = body.subagent_id;
        if (!request.events.some((event) => event.event_type === "ACKED" && event.actor_type === "seller")) {
          appendRequestEvent(request, "ACKED", {
            actor_type: "seller",
            eta_hint_s: Number(body.eta_hint_s || 0)
          });
          await persistPlatformState(onStateChanged, state);
        }

        sendJson(res, 202, { accepted: true, request_id: requestId });
        return;
      }

      const requestEventWriteMatch = pathname.match(/^\/v1\/requests\/([^/]+)\/events$/);
      if (method === "POST" && requestEventWriteMatch) {
        const requestId = requestEventWriteMatch[1];
        const auth = requireAuth(req, res, state);
        if (!auth) {
          return;
        }
        if (auth.type !== "seller") {
          sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "only seller callers may append request events");
          return;
        }

        const body = await parseJsonBody(req);
        if (!body.seller_id || !body.subagent_id || !body.event_type) {
          sendError(
            res,
            400,
            "CONTRACT_INVALID_REQUEST_EVENT",
            "seller_id, subagent_id, and event_type are required"
          );
          return;
        }
        if (!["COMPLETED", "FAILED"].includes(body.event_type)) {
          sendError(
            res,
            400,
            "CONTRACT_INVALID_REQUEST_EVENT",
            "event_type must be COMPLETED or FAILED"
          );
          return;
        }
        if (auth.seller_id !== body.seller_id || !auth.subagent_ids.includes(body.subagent_id)) {
          sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "caller does not own the specified seller or subagent");
          return;
        }

        const request = state.requests.get(requestId);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
          return;
        }
        if (request.seller_id && request.seller_id !== body.seller_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "seller_id does not match existing request");
          return;
        }
        if (request.subagent_id && request.subagent_id !== body.subagent_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "subagent_id does not match existing request");
          return;
        }

        request.seller_id = body.seller_id;
        request.subagent_id = body.subagent_id;

        const existingEvent = findMatchingRequestEvent(request, {
          eventType: body.event_type,
          sellerId: body.seller_id,
          subagentId: body.subagent_id
        });
        if (existingEvent) {
          sendJson(res, 202, { accepted: true, request_id: requestId, event: existingEvent, deduped: true });
          return;
        }

        appendRequestEvent(request, body.event_type, {
          actor_type: "seller",
          seller_id: body.seller_id,
          subagent_id: body.subagent_id,
          status: body.status || (body.event_type === "FAILED" ? "error" : "ok"),
          error_code: body.error_code || null,
          finished_at: body.finished_at || nowIso()
        });
        await persistPlatformState(onStateChanged, state);

        sendJson(res, 202, {
          accepted: true,
          request_id: requestId,
          event: request.events[request.events.length - 1]
        });
        return;
      }

      const eventMatch = pathname.match(/^\/v1\/requests\/([^/]+)\/events$/);
      if (method === "GET" && eventMatch) {
        const auth = requireAuth(req, res, state);
        if (!auth) {
          return;
        }

        const request = state.requests.get(eventMatch[1]);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
          return;
        }
        if (auth.type === "buyer" && request.buyer_id !== auth.user_id) {
          sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "request is owned by another buyer");
          return;
        }
        if (
          auth.type === "seller" &&
          (request.seller_id !== auth.seller_id ||
            (request.subagent_id && !auth.subagent_ids.includes(request.subagent_id)))
        ) {
          sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "seller does not own this request");
          return;
        }

        sendJson(res, 200, { request_id: request.request_id, events: request.events, items: request.events });
        return;
      }

      if (method === "POST" && pathname === "/v1/requests/events/batch") {
        const auth = requireAuth(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);
        const requestIds = Array.isArray(body.request_ids) ? body.request_ids.map((item) => String(item)).filter(Boolean) : [];
        if (requestIds.length === 0) {
          sendError(res, 400, "CONTRACT_INVALID_BATCH_REQUEST", "request_ids must contain at least one id");
          return;
        }
        if (requestIds.length > 100) {
          sendError(res, 400, "CONTRACT_INVALID_BATCH_REQUEST", "request_ids cannot exceed 100 items");
          return;
        }

        const items = [];
        for (const requestId of requestIds) {
          const request = state.requests.get(requestId);
          if (!request) {
            items.push({
              request_id: requestId,
              found: false
            });
            continue;
          }
          if (auth.type === "buyer" && request.buyer_id !== auth.user_id) {
            items.push({
              request_id: requestId,
              found: false
            });
            continue;
          }
          if (
            auth.type === "seller" &&
            (request.seller_id !== auth.seller_id || (request.subagent_id && !auth.subagent_ids.includes(request.subagent_id)))
          ) {
            items.push({
              request_id: requestId,
              found: false
            });
            continue;
          }
          items.push({
            request_id: request.request_id,
            found: true,
            events: request.events,
            items: request.events
          });
        }

        sendJson(res, 200, { items });
        return;
      }

      const heartbeatMatch = pathname.match(/^\/v1\/sellers\/([^/]+)\/heartbeat$/);
      if (method === "POST" && heartbeatMatch) {
        const sellerId = heartbeatMatch[1];
        const auth = requireSeller(req, res, state, { sellerId });
        if (!auth) {
          return;
        }

        const body = await parseJsonBody(req);
        const seller = state.sellers.get(sellerId);
        if (!seller) {
          sendError(res, 404, "SELLER_NOT_FOUND", "no seller found with this id");
          return;
        }

        const heartbeatAt = nowIso();
        seller.last_heartbeat_at = heartbeatAt;
        seller.availability_status = body.status || "healthy";

        for (const item of state.catalog.values()) {
          if (item.seller_id === sellerId) {
            item.last_heartbeat_at = heartbeatAt;
            item.availability_status = body.status || "healthy";
          }
        }
        await persistPlatformState(onStateChanged, state);

        sendJson(res, 202, {
          accepted: true,
          seller_id: sellerId,
          status: seller.availability_status,
          heartbeat_interval_s: HEARTBEAT_INTERVAL_S,
          last_heartbeat_at: heartbeatAt
        });
        return;
      }

      if (method === "POST" && pathname === "/v1/metrics/events") {
        const auth = requireAuth(req, res, state);
        if (!auth) {
          return;
        }

        const body = await parseJsonBody(req);
        const eventType = body.event_type || body.event_name;
        if (!eventType || !body.source) {
          sendError(res, 400, "CONTRACT_INVALID_METRIC_EVENT", "event_type and source are required");
          return;
        }

        const event = {
          id: randomId("evt"),
          event_type: eventType,
          source: body.source,
          request_id: body.request_id || null,
          recorded_at: nowIso()
        };
        pushCapped(state.metricsEvents, event, telemetryHistoryLimit(state));
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 202, { accepted: true, event });
        return;
      }

      if (method === "GET" && pathname === "/v1/metrics/summary") {
        const auth = requireAuth(req, res, state);
        if (!auth) {
          return;
        }

        sendJson(res, 200, {
          total_events: state.metricsEvents.length,
          by_type: state.metricsEvents.reduce((acc, event) => {
            acc[event.event_type] = (acc[event.event_type] || 0) + 1;
            return acc;
          }, {})
        });
        return;
      }

      if (method === "GET" && pathname === "/v1/admin/sellers") {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const { limit, offset } = parsePagination(url);
        const q = url.searchParams.get("q");
        const status = url.searchParams.get("status");
        const reviewStatus = url.searchParams.get("review_status");
        const availabilityStatus = url.searchParams.get("availability_status");
        const ownerUserId = url.searchParams.get("owner_user_id");

        const items = Array.from(state.sellers.values())
          .map((seller) =>
            buildSellerAdminSummary(
              state,
              seller,
              Array.from(state.catalog.values()).filter((item) => item.seller_id === seller.seller_id)
            )
          )
          .filter((item) => !status || item.status === status)
          .filter((item) => !reviewStatus || item.review_status === reviewStatus)
          .filter((item) => !availabilityStatus || item.availability_status === availabilityStatus)
          .filter((item) => !ownerUserId || item.owner_user_id === ownerUserId)
          .filter((item) => matchesQuery(item, q));
        sendJson(res, 200, paginateItems(items, { limit, offset }));
        return;
      }

      if (method === "GET" && pathname === "/v1/admin/subagents") {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const { limit, offset } = parsePagination(url);
        const q = url.searchParams.get("q");
        const status = url.searchParams.get("status");
        const reviewStatus = url.searchParams.get("review_status");
        const availabilityStatus = url.searchParams.get("availability_status");
        const sellerId = url.searchParams.get("seller_id");
        const capability = url.searchParams.get("capability");
        const tag = url.searchParams.get("tag");

        const items = Array.from(state.catalog.values())
          .map((item) =>
            buildCatalogAdminSummary(state, {
              ...item,
              availability_status: resolveCatalogAvailability(item)
            })
          )
          .filter((item) => !status || item.status === status)
          .filter((item) => !reviewStatus || item.review_status === reviewStatus)
          .filter((item) => !availabilityStatus || item.availability_status === availabilityStatus)
          .filter((item) => !sellerId || item.seller_id === sellerId)
          .filter((item) => !capability || (item.capabilities || []).includes(capability))
          .filter((item) => !tag || (item.tags || []).includes(tag))
          .filter((item) => matchesQuery(item, q));
        sendJson(res, 200, paginateItems(items, { limit, offset }));
        return;
      }

      if (method === "GET" && pathname === "/v1/admin/requests") {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const { limit, offset } = parsePagination(url);
        const q = url.searchParams.get("q");
        const buyerId = url.searchParams.get("buyer_id");
        const sellerId = url.searchParams.get("seller_id");
        const subagentId = url.searchParams.get("subagent_id");
        const eventType = url.searchParams.get("event_type");

        const items = Array.from(state.requests.values())
          .map(buildRequestAdminSummary)
          .filter((item) => !buyerId || item.buyer_id === buyerId)
          .filter((item) => !sellerId || item.seller_id === sellerId)
          .filter((item) => !subagentId || item.subagent_id === subagentId)
          .filter((item) => !eventType || item.latest_event?.event_type === eventType)
          .filter((item) => matchesQuery(item, q));
        sendJson(res, 200, paginateItems(items, { limit, offset }));
        return;
      }

      if (method === "GET" && pathname === "/v1/admin/reviews") {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const { limit, offset } = parsePagination(url);
        const q = url.searchParams.get("q");
        const reviewStatus = url.searchParams.get("review_status");
        const targetType = url.searchParams.get("target_type");
        const targetId = url.searchParams.get("target_id");

        const items = state.reviewEvents
          .slice()
          .reverse()
          .filter((item) => !reviewStatus || item.review_status === reviewStatus)
          .filter((item) => !targetType || item.target_type === targetType)
          .filter((item) => !targetId || item.target_id === targetId)
          .filter((item) => matchesQuery(item, q));
        sendJson(res, 200, paginateItems(items, { limit, offset }));
        return;
      }

      if (method === "GET" && pathname === "/v1/admin/review-tests") {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const { limit, offset } = parsePagination(url);
        const q = url.searchParams.get("q");
        const sellerId = url.searchParams.get("seller_id");
        const subagentId = url.searchParams.get("subagent_id");
        const status = url.searchParams.get("status");
        const verdict = url.searchParams.get("verdict");

        const items = Array.from(state.reviewTests.values())
          .map(summarizeReviewTest)
          .filter((item) => !sellerId || item?.seller_id === sellerId)
          .filter((item) => !subagentId || item?.subagent_id === subagentId)
          .filter((item) => !status || item?.status === status)
          .filter((item) => !verdict || item?.verdict === verdict)
          .filter((item) => matchesQuery(item, q));
        sendJson(res, 200, paginateItems(items, { limit, offset }));
        return;
      }

      const reviewTestDetailMatch = pathname.match(/^\/v1\/admin\/review-tests\/([^/]+)$/);
      if (method === "GET" && reviewTestDetailMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const reviewTest = state.reviewTests.get(reviewTestDetailMatch[1]);
        if (!reviewTest) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "review test not found");
          return;
        }
        sendJson(res, 200, {
          ...reviewTest,
          request: state.requests.get(reviewTest.request_id) || null
        });
        return;
      }

      const adminRoleGrantMatch = pathname.match(/^\/v1\/admin\/users\/([^/]+)\/roles$/);
      if (method === "POST" && adminRoleGrantMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }

        const body = await parseJsonBody(req);
        const role = body.role || body.add_role;
        if (!role) {
          sendError(res, 400, "CONTRACT_INVALID_ROLE_GRANT", "role is required");
          return;
        }

        const user = addUserRole(state, adminRoleGrantMatch[1], role);
        if (!user) {
          sendError(res, 404, "USER_NOT_FOUND", "no user found with this id");
          return;
        }
        appendAuditEvent(state, auth, "user.role.granted", { type: "user", id: user.user_id }, { role });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, { user_id: user.user_id, roles: user.roles });
        return;
      }

      const buyerKeyRotateMatch = pathname.match(/^\/v1\/admin\/users\/([^/]+)\/api-keys\/rotate$/);
      if (method === "POST" && buyerKeyRotateMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const rotated = rotateBuyerApiKey(state, buyerKeyRotateMatch[1]);
        if (!rotated) {
          sendError(res, 404, "USER_NOT_FOUND", "no user found with this id");
          return;
        }
        appendAuditEvent(state, auth, "user.api_key.rotated", { type: "user", id: rotated.user_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, rotated);
        return;
      }

      const sellerKeyRotateMatch = pathname.match(/^\/v1\/admin\/sellers\/([^/]+)\/api-keys\/rotate$/);
      if (method === "POST" && sellerKeyRotateMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const rotated = rotateSellerApiKey(state, sellerKeyRotateMatch[1]);
        if (!rotated) {
          sendError(res, 404, "SELLER_NOT_FOUND", "no seller found with this id");
          return;
        }
        appendAuditEvent(state, auth, "seller.api_key.rotated", { type: "seller", id: rotated.seller_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, rotated);
        return;
      }

      const sellerSigningRotateMatch = pathname.match(/^\/v1\/admin\/sellers\/([^/]+)\/signing-keys\/rotate$/);
      if (method === "POST" && sellerSigningRotateMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);
        const rotated = rotateSellerSigningKey(state, sellerSigningRotateMatch[1], body);
        if (!rotated) {
          sendError(res, 404, "SELLER_NOT_FOUND", "no seller found with this id");
          return;
        }
        if (rotated.error) {
          sendJson(res, rotated.statusCode || 400, { error: rotated.error });
          return;
        }
        appendAuditEvent(state, auth, "seller.signing_key.rotated", { type: "seller", id: rotated.seller_id }, {
          rotation_window_until: rotated.rotation_window_until
        });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, rotated);
        return;
      }

      if (method === "POST" && pathname === "/v1/admin/api-keys/revoke") {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);
        if (!body.api_key) {
          sendError(res, 400, "CONTRACT_INVALID_API_KEY_REVOKE", "api_key is required");
          return;
        }
        const revoked = revokeApiKey(state, body.api_key);
        if (!revoked) {
          sendError(res, 404, "AUTH_KEY_NOT_FOUND", "api key was not found");
          return;
        }
        appendAuditEvent(state, auth, "api_key.revoked", { type: revoked.type || "api_key", id: revoked.user_id || revoked.seller_id || "unknown" });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          revoked: true,
          type: revoked.type,
          user_id: revoked.user_id || null,
          seller_id: revoked.seller_id || null
        });
        return;
      }

      if (method === "GET" && pathname === "/v1/admin/audit-events") {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const { limit, offset } = parsePagination(url);
        const q = url.searchParams.get("q");
        const action = url.searchParams.get("action");
        const actorType = url.searchParams.get("actor_type");
        const targetType = url.searchParams.get("target_type");

        const items = state.auditEvents
          .slice()
          .reverse()
          .filter((item) => !action || item.action === action)
          .filter((item) => !actorType || item.actor_type === actorType)
          .filter((item) => !targetType || item.target_type === targetType)
          .filter((item) => matchesQuery(item, q));
        sendJson(res, 200, paginateItems(items, { limit, offset }));
        return;
      }

      const adminReviewTestCreateMatch = pathname.match(/^\/v1\/admin\/subagents\/([^/]+)\/review-tests$/);
      if (method === "POST" && adminReviewTestCreateMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);
        const item = state.catalog.get(adminReviewTestCreateMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_SUBAGENT_NOT_FOUND", "subagent not found in catalog");
          return;
        }
        if (!item.task_delivery_address?.startsWith("local://")) {
          sendError(
            res,
            409,
            "PLATFORM_REVIEW_TEST_UNSUPPORTED",
            "review test automation currently supports only local or relay-backed task delivery"
          );
          return;
        }
        const transport = createReviewTransport();
        if (!transport) {
          sendError(
            res,
            409,
            "PLATFORM_REVIEW_TRANSPORT_NOT_CONFIGURED",
            "review transport base URL is not configured on the platform"
          );
          return;
        }

        const requestId = body.request_id || `req_review_${crypto.randomUUID().replace(/-/g, "")}`;
        const taskInput = body.task_input || {};
        const constraints = body.constraints || null;
        const request = getOrCreateRequest(state, requestId);
        request.buyer_id = REVIEW_TEST_BUYER_ID;
        request.seller_id = item.seller_id;
        request.subagent_id = item.subagent_id;
        request.request_kind = "review_test";
        request.request_visibility = "hidden";

        const issued = createTaskClaims(state, {
          buyerId: REVIEW_TEST_BUYER_ID,
          requestId,
          sellerId: item.seller_id,
          subagentId: item.subagent_id,
          requestKind: "review_test"
        });
        const resultDelivery = {
          kind: "local",
          address: buildReviewResultAddress(requestId)
        };
        createDeliveryMeta(state, request, item, resultDelivery);
        appendRequestEvent(request, "TASK_TOKEN_ISSUED", { actor_type: "system", request_kind: "review_test" });
        appendRequestEvent(request, "DELIVERY_META_ISSUED", { actor_type: "system", request_kind: "review_test" });

        const reviewTest = {
          request_id: requestId,
          seller_id: item.seller_id,
          subagent_id: item.subagent_id,
          status: "running",
          verdict: null,
          failure_code: null,
          result_summary: null,
          result_package: null,
          task_input: cloneValue(taskInput),
          constraints: cloneValue(constraints),
          expected_checks: cloneValue(body.expected_checks || null),
          timeout_ms: Number(body.timeout_ms || 0) || null,
          started_at: nowIso(),
          finished_at: null,
          task_token: issued.task_token
        };
        state.reviewTests.set(requestId, reviewTest);

        const submission = state.submissions.get(item.subagent_id);
        if (submission) {
          submission.latest_review_test_request_id = requestId;
        }

        appendAuditEvent(state, auth, "review_test.started", { type: "subagent", id: item.subagent_id }, { request_id: requestId });
        await persistPlatformState(onStateChanged, state);

        void runReviewTestHarness(state, reviewTest, request, transport, onStateChanged)
          .then(async () => {
            appendAuditEvent(
              state,
              auth,
              "review_test.completed",
              { type: "subagent", id: item.subagent_id },
              {
                request_id: requestId,
                verdict: reviewTest.verdict,
                failure_code: reviewTest.failure_code || null
              }
            );
            await persistPlatformState(onStateChanged, state);
          })
          .catch(async (error) => {
            reviewTest.status = "completed";
            reviewTest.verdict = "fail";
            reviewTest.failure_code = "TRANSPORT_CONNECTION_FAILED";
            reviewTest.result_summary = error instanceof Error ? error.message : "review test failed";
            reviewTest.finished_at = nowIso();
            appendAuditEvent(
              state,
              auth,
              "review_test.completed",
              { type: "subagent", id: item.subagent_id },
              {
                request_id: requestId,
                verdict: reviewTest.verdict,
                failure_code: reviewTest.failure_code
              }
            );
            await persistPlatformState(onStateChanged, state);
          });

        sendJson(res, 202, {
          request_id: requestId,
          seller_id: item.seller_id,
          subagent_id: item.subagent_id,
          status: reviewTest.status
        });
        return;
      }

      const adminSellerDisableMatch = pathname.match(/^\/v1\/admin\/sellers\/([^/]+)\/disable$/);
      if (method === "POST" && adminSellerDisableMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const seller = state.sellers.get(adminSellerDisableMatch[1]);
        if (!seller) {
          sendError(res, 404, "SELLER_NOT_FOUND", "no seller found with this id");
          return;
        }
        seller.status = "disabled";
        appendAuditEvent(state, auth, "seller.disabled", { type: "seller", id: seller.seller_id }, { reason: body.reason || null });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          seller_id: seller.seller_id,
          status: seller.status,
          review_status: seller.review_status,
          catalog_visibility: "hidden"
        });
        return;
      }

      const adminSellerApproveMatch = pathname.match(/^\/v1\/admin\/sellers\/([^/]+)\/approve$/);
      if (method === "POST" && adminSellerApproveMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const seller = state.sellers.get(adminSellerApproveMatch[1]);
        if (!seller) {
          sendError(res, 404, "SELLER_NOT_FOUND", "no seller found with this id");
          return;
        }
        seller.review_status = "approved";
        seller.status = "enabled";
        seller.reviewed_at = nowIso();
        seller.reviewed_by = describeActor(auth).actor_id;
        seller.review_reason = body.reason || null;
        appendAuditEvent(state, auth, "seller.approved", { type: "seller", id: seller.seller_id }, { reason: body.reason || null });
        appendReviewEvent(state, auth, "approved", { type: "seller", id: seller.seller_id }, { reason: body.reason || null, seller_id: seller.seller_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          seller_id: seller.seller_id,
          status: seller.status,
          review_status: seller.review_status
        });
        return;
      }

      const adminSellerRejectMatch = pathname.match(/^\/v1\/admin\/sellers\/([^/]+)\/reject$/);
      if (method === "POST" && adminSellerRejectMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const seller = state.sellers.get(adminSellerRejectMatch[1]);
        if (!seller) {
          sendError(res, 404, "SELLER_NOT_FOUND", "no seller found with this id");
          return;
        }
        seller.review_status = "rejected";
        seller.status = "disabled";
        seller.reviewed_at = nowIso();
        seller.reviewed_by = describeActor(auth).actor_id;
        seller.review_reason = body.reason || null;
        appendAuditEvent(state, auth, "seller.rejected", { type: "seller", id: seller.seller_id }, { reason: body.reason || null });
        appendReviewEvent(state, auth, "rejected", { type: "seller", id: seller.seller_id }, { reason: body.reason || null, seller_id: seller.seller_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          seller_id: seller.seller_id,
          status: seller.status,
          review_status: seller.review_status,
          catalog_visibility: "hidden"
        });
        return;
      }

      const adminSellerEnableMatch = pathname.match(/^\/v1\/admin\/sellers\/([^/]+)\/enable$/);
      if (method === "POST" && adminSellerEnableMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const seller = state.sellers.get(adminSellerEnableMatch[1]);
        if (!seller) {
          sendError(res, 404, "SELLER_NOT_FOUND", "no seller found with this id");
          return;
        }
        if (seller.review_status !== "approved") {
          sendError(res, 409, "SELLER_NOT_APPROVED", "seller must be approved before it can be enabled");
          return;
        }
        seller.status = "enabled";
        appendAuditEvent(state, auth, "seller.enabled", { type: "seller", id: seller.seller_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          seller_id: seller.seller_id,
          status: seller.status,
          review_status: seller.review_status
        });
        return;
      }

      const adminSubagentDisableMatch = pathname.match(/^\/v1\/admin\/subagents\/([^/]+)\/disable$/);
      if (method === "POST" && adminSubagentDisableMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const item = state.catalog.get(adminSubagentDisableMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_SUBAGENT_NOT_FOUND", "subagent not found in catalog");
          return;
        }
        item.status = "disabled";
        appendAuditEvent(state, auth, "subagent.disabled", { type: "subagent", id: item.subagent_id }, { reason: body.reason || null });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          subagent_id: item.subagent_id,
          status: item.status,
          review_status: item.review_status,
          catalog_visibility: resolveCatalogVisibility(state, item)
        });
        return;
      }

      const adminSubagentApproveMatch = pathname.match(/^\/v1\/admin\/subagents\/([^/]+)\/approve$/);
      if (method === "POST" && adminSubagentApproveMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const item = state.catalog.get(adminSubagentApproveMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_SUBAGENT_NOT_FOUND", "subagent not found in catalog");
          return;
        }
        item.review_status = "approved";
        item.status = "enabled";
        item.reviewed_at = nowIso();
        item.reviewed_by = describeActor(auth).actor_id;
        item.review_reason = body.reason || null;
        appendAuditEvent(state, auth, "subagent.approved", { type: "subagent", id: item.subagent_id }, { reason: body.reason || null });
        appendReviewEvent(state, auth, "approved", { type: "subagent", id: item.subagent_id }, { reason: body.reason || null, seller_id: item.seller_id, subagent_id: item.subagent_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          subagent_id: item.subagent_id,
          status: item.status,
          review_status: item.review_status,
          catalog_visibility: resolveCatalogVisibility(state, item)
        });
        return;
      }

      const adminSubagentRejectMatch = pathname.match(/^\/v1\/admin\/subagents\/([^/]+)\/reject$/);
      if (method === "POST" && adminSubagentRejectMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const item = state.catalog.get(adminSubagentRejectMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_SUBAGENT_NOT_FOUND", "subagent not found in catalog");
          return;
        }
        item.review_status = "rejected";
        item.status = "disabled";
        item.reviewed_at = nowIso();
        item.reviewed_by = describeActor(auth).actor_id;
        item.review_reason = body.reason || null;
        appendAuditEvent(state, auth, "subagent.rejected", { type: "subagent", id: item.subagent_id }, { reason: body.reason || null });
        appendReviewEvent(state, auth, "rejected", { type: "subagent", id: item.subagent_id }, { reason: body.reason || null, seller_id: item.seller_id, subagent_id: item.subagent_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          subagent_id: item.subagent_id,
          status: item.status,
          review_status: item.review_status,
          catalog_visibility: resolveCatalogVisibility(state, item)
        });
        return;
      }

      const adminSubagentEnableMatch = pathname.match(/^\/v1\/admin\/subagents\/([^/]+)\/enable$/);
      if (method === "POST" && adminSubagentEnableMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const item = state.catalog.get(adminSubagentEnableMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_SUBAGENT_NOT_FOUND", "subagent not found in catalog");
          return;
        }
        if (item.review_status !== "approved") {
          sendError(res, 409, "SUBAGENT_NOT_APPROVED", "subagent must be approved before it can be enabled");
          return;
        }
        item.status = "enabled";
        appendAuditEvent(state, auth, "subagent.enabled", { type: "subagent", id: item.subagent_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          subagent_id: item.subagent_id,
          status: item.status,
          review_status: item.review_status,
          catalog_visibility: resolveCatalogVisibility(state, item)
        });
        return;
      }

      sendError(res, 404, "not_found", "no matching route", { path: pathname });
    } catch (error) {
      if (error.message === "invalid_json") {
        sendError(res, 400, "CONTRACT_INVALID_JSON", "request body is not valid JSON");
        return;
      }

      sendError(res, 500, "PLATFORM_API_INTERNAL_ERROR", error instanceof Error ? error.message : "unknown_error", { retryable: true });
    }
  });
}

function isDirectRun() {
  if (!process.argv[1]) {
    return false;
  }
  return fs.realpathSync.native(path.resolve(process.argv[1])) === fs.realpathSync.native(__filename);
}

async function createOptionalPersistence(serviceName) {
  const connectionString = process.env.DATABASE_URL || null;
  if (connectionString) {
    const store = await createPostgresSnapshotStore({
      connectionString,
      serviceName
    });
    await store.migrate();
    return store;
  }

  const sqlitePath = process.env.SQLITE_DATABASE_PATH || null;
  if (!sqlitePath) {
    return null;
  }

  const store = await createSqliteSnapshotStore({
    databasePath: sqlitePath,
    serviceName
  });
  await store.migrate();
  return store;
}

if (isDirectRun()) {
  const port = Number(process.env.PORT || 8080);
  const serviceName = process.env.SERVICE_NAME || "platform-api";
  if (!process.env.TOKEN_SECRET) {
    throw new Error("platform_token_secret_required");
  }
  const state = createPlatformState({
    tokenSecret: process.env.TOKEN_SECRET
  });
  const persistence = await createOptionalPersistence(serviceName);
  if (persistence) {
    hydratePlatformState(state, await persistence.loadSnapshot());
  }
  const server = createPlatformServer({
    serviceName,
    state,
    onStateChanged: persistence
      ? async (currentState) => {
          await persistence.saveSnapshot(serializePlatformState(currentState));
        }
      : null
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[${serviceName}] listening on ${port}`);
  });
  server.on("close", () => {
    if (persistence) {
      void persistence.saveSnapshot(serializePlatformState(state));
      void persistence.close();
    }
  });
}
