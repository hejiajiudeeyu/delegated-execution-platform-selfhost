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
const REVIEW_TEST_CALLER_ID = "caller_review_bot";
const REVIEW_TEST_RECEIVER_PREFIX = "platform-review-bot";
const DEFAULT_REQUEST_EVENT_HISTORY_LIMIT = 200;
const DEFAULT_TELEMETRY_HISTORY_LIMIT = 5000;
const DEFAULT_HOTLINE_QUOTA_PER_RESPONDER = 25;
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

function createResponderIdentity({
  responderId,
  hotlineId,
  templateRef,
  displayName,
  taskDeliveryAddress,
  taskTypes = [],
  capabilities = [],
  tags = [],
  summary = null,
  description = null,
  recommendedFor = null,
  notRecommendedFor = null,
  limitations = null,
  inputSummary = null,
  outputSummary = null,
  inputSchema = null,
  outputSchema = null,
  inputAttachments = null,
  outputAttachments = null,
  inputExamples = null,
  outputExamples = null,
  templateVersion = null,
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
  const responderApiKey = apiKey || `sk_responder_${crypto.randomBytes(12).toString("hex")}`;
  const responderUserId = ownerUserId || randomId("user");
  const lastHeartbeatAt = nowIso();

  return {
    responder: {
      responder_id: responderId,
      owner_user_id: responderUserId,
      api_key: responderApiKey,
      scopes: ["responder"],
      hotline_ids: [hotlineId],
      status: "enabled",
      review_status: "approved",
      reviewed_at: lastHeartbeatAt,
      reviewed_by: "system",
      review_reason: "bootstrap",
      responder_public_key_pem: keyPair.publicKeyPem,
      responder_public_keys_pem: [keyPair.publicKeyPem],
      last_heartbeat_at: lastHeartbeatAt,
      availability_status: "healthy",
      contact_email: contactEmail || `${responderId}@test.local`,
      support_email: supportEmail || `support+${responderId}@test.local`
    },
    catalogItem: {
      responder_id: responderId,
      hotline_id: hotlineId,
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
      summary,
      description,
      recommended_for: recommendedFor,
      not_recommended_for: notRecommendedFor,
      limitations,
      input_summary: inputSummary,
      output_summary: outputSummary,
      input_schema: inputSchema,
      output_schema: outputSchema,
      input_attachments: inputAttachments,
      output_attachments: outputAttachments,
      responder_public_key_pem: keyPair.publicKeyPem,
      responder_public_keys_pem: [keyPair.publicKeyPem],
      task_delivery_address: taskDeliveryAddress
    },
    templateOptions: {
      inputSchema,
      outputSchema,
      inputAttachments,
      outputAttachments,
      inputExamples,
      outputExamples,
      templateVersion
    },
    signing: {
      publicKeyPem: keyPair.publicKeyPem,
      privateKeyPem: keyPair.privateKeyPem
    }
  };
}

function createTemplateBundle(templateRef, options = {}) {
  const bundle = {
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
  if (options.inputAttachments !== undefined) {
    bundle.input_attachments = options.inputAttachments;
  }
  if (options.outputAttachments !== undefined) {
    bundle.output_attachments = options.outputAttachments;
  }
  if (options.inputExamples !== undefined) {
    bundle.input_examples = options.inputExamples;
  }
  if (options.outputExamples !== undefined) {
    bundle.output_examples = options.outputExamples;
  }
  if (options.templateVersion !== undefined) {
    bundle.template_version = options.templateVersion;
  }
  return bundle;
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
    hotlinesPerResponder: readNumberEnv(process.env.PLATFORM_HOTLINE_QUOTA_PER_RESPONDER, DEFAULT_HOTLINE_QUOTA_PER_RESPONDER)
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
    registerResponderMax: readNumberEnv(process.env.PUBLIC_RATE_LIMIT_REGISTER_RESPONDER_MAX, 1000),
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
  return `${getClientAddress(req)}:${auth?.user_id || auth?.responder_id || auth?.admin_id || "anonymous"}`;
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

function isResponderRoutable(responder) {
  return responder?.review_status === "approved" && responder?.status === "enabled";
}

function isHotlineRoutable(item) {
  return item?.review_status === "approved" && item?.status === "enabled";
}

function resolveCatalogVisibility(state, item) {
  if (!item) {
    return "hidden";
  }
  const responder = state.responders.get(item.responder_id);
  return isResponderRoutable(responder) && isHotlineRoutable(item) ? "public" : "hidden";
}

function isOperatorAuth(auth, state) {
  if (!auth) {
    return false;
  }
  if (auth.type === "admin") {
    return true;
  }
  if (auth.type !== "caller") {
    return false;
  }
  const user = state.users.get(auth.user_id);
  return (user?.roles || []).includes("admin");
}

function canManageResponder(auth, responder) {
  if (!auth || !responder) {
    return false;
  }
  if (auth.type === "caller") {
    return responder.owner_user_id === auth.user_id;
  }
  if (auth.type === "responder") {
    return auth.responder_id === responder.responder_id;
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
  const responder = state.responders.get(item.responder_id);
  return canManageResponder(auth, responder) || (auth?.type === "responder" && auth.hotline_ids?.includes(item.hotline_id));
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
    responder_id: reviewTest.responder_id,
    hotline_id: reviewTest.hotline_id,
    status: reviewTest.status,
    verdict: reviewTest.verdict,
    failure_code: reviewTest.failure_code || null,
    started_at: reviewTest.started_at,
    finished_at: reviewTest.finished_at || null,
    result_summary: reviewTest.result_summary || null
  };
}

function findLatestReviewTest(state, hotlineId) {
  const matches = Array.from(state.reviewTests.values())
    .filter((item) => item.hotline_id === hotlineId)
    .sort((left, right) => String(right.started_at || "").localeCompare(String(left.started_at || "")));
  return matches[0] || null;
}

function buildCatalogDetail(state, item) {
  const submission = state.submissions.get(item.hotline_id) || null;
  return {
    ...item,
    catalog_visibility: resolveCatalogVisibility(state, item),
    latest_review_test: summarizeReviewTest(findLatestReviewTest(state, item.hotline_id)),
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
    latest_review_test: summarizeReviewTest(findLatestReviewTest(state, item.hotline_id))
  };
}

function slugifyMarketplaceSegment(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "item";
}

function buildMarketplaceTemplateSummary(template) {
  if (!template) {
    return null;
  }
  const inputSchema = template.input_schema || null;
  const outputSchema = template.output_schema || null;
  return {
    template_ref: template.template_ref,
    input_required: Array.isArray(inputSchema?.required) ? inputSchema.required : [],
    input_properties: inputSchema?.properties ? Object.keys(inputSchema.properties) : [],
    output_properties: outputSchema?.properties ? Object.keys(outputSchema.properties) : []
  };
}

function buildMarketplaceTrustBadges(state, item, responder) {
  const badges = [];
  if (resolveCatalogVisibility(state, item) === "public") {
    badges.push("public");
  }
  if (responder?.review_status === "approved") {
    badges.push("responder_reviewed");
  }
  if (item?.review_status === "approved") {
    badges.push("hotline_reviewed");
  }
  if (resolveCatalogAvailability(item) === "healthy") {
    badges.push("healthy");
  }
  return badges;
}

function buildMarketplaceHotlineSummary(state, item) {
  const responder = state.responders.get(item.responder_id) || null;
  const template = state.templates.get(item.template_ref) || null;
  const responderSlug = slugifyMarketplaceSegment(responder?.display_name || responder?.responder_id || item.responder_id);
  const hotlineSlug = slugifyMarketplaceSegment(item.display_name || item.hotline_id);
  return {
    hotline_id: item.hotline_id,
    responder_id: item.responder_id,
    responder_slug: responderSlug,
    hotline_slug: hotlineSlug,
    display_name: item.display_name || item.hotline_id,
    summary: item.summary || item.description || `${item.display_name || item.hotline_id} handles ${(item.task_types || []).join(", ") || "remote tasks"}.`,
    responder_display_name: responder?.display_name || responder?.responder_id || item.responder_id,
    task_types: item.task_types || [],
    capabilities: item.capabilities || [],
    tags: item.tags || [],
    status: item.status || "disabled",
    review_status: item.review_status || "pending",
    availability_status: resolveCatalogAvailability(item),
    catalog_visibility: resolveCatalogVisibility(state, item),
    template_summary: buildMarketplaceTemplateSummary(template),
    latest_review_test: summarizeReviewTest(findLatestReviewTest(state, item.hotline_id)),
    support_email: responder?.support_email || null,
    trust_badges: buildMarketplaceTrustBadges(state, item, responder),
    updated_at: item.reviewed_at || item.submitted_at || item.last_heartbeat_at || null
  };
}

function buildMarketplaceHotlineDetail(state, item) {
  const responder = state.responders.get(item.responder_id) || null;
  const template = state.templates.get(item.template_ref) || null;
  const relatedHotlines = Array.from(state.catalog.values())
    .filter((entry) => entry.responder_id === item.responder_id && entry.hotline_id !== item.hotline_id)
    .filter((entry) => resolveCatalogVisibility(state, entry) === "public")
    .slice(0, 3)
    .map((entry) => buildMarketplaceHotlineSummary(state, entry));
  return {
    ...buildMarketplaceHotlineSummary(state, item),
    description: item.description || null,
    recommended_for: item.recommended_for || null,
    not_recommended_for: item.not_recommended_for || null,
    limitations: item.limitations || null,
    input_summary: item.input_summary || null,
    output_summary: item.output_summary || null,
    responder_profile: responder
      ? {
          responder_id: responder.responder_id,
          display_name: responder.display_name || responder.responder_id,
          support_email: responder.support_email || null,
          availability_status: responder.availability_status || null,
          last_heartbeat_at: responder.last_heartbeat_at || null
        }
      : null,
    related_hotlines: relatedHotlines,
    input_schema: item.input_schema || template?.input_schema || null,
    output_schema: item.output_schema || template?.output_schema || null,
    input_attachments: item.input_attachments || template?.input_attachments || null,
    output_attachments: item.output_attachments || template?.output_attachments || null,
    template_ref: item.template_ref || null
  };
}

function buildMarketplaceResponderProfile(state, responder) {
  const hotlines = Array.from(state.catalog.values())
    .filter((item) => item.responder_id === responder.responder_id)
    .filter((item) => resolveCatalogVisibility(state, item) === "public")
    .map((item) => buildMarketplaceHotlineSummary(state, item));

  return {
    responder_id: responder.responder_id,
    responder_slug: slugifyMarketplaceSegment(responder.display_name || responder.responder_id),
    display_name: responder.display_name || responder.responder_id,
    summary: responder.summary || "",
    availability_status: responder.availability_status || "unknown",
    review_status: responder.review_status || "pending",
    support_email: responder.support_email || null,
    last_heartbeat_at: responder.last_heartbeat_at || null,
    hotline_count: hotlines.length,
    task_types: Array.from(new Set(hotlines.flatMap((item) => item.task_types || []))),
    capabilities: Array.from(new Set(hotlines.flatMap((item) => item.capabilities || []))),
    trust_badges: Array.from(new Set(hotlines.flatMap((item) => item.trust_badges || []))),
    hotlines
  };
}

function buildMarketplaceMeta(state) {
  const hotlines = Array.from(state.catalog.values())
    .filter((item) => resolveCatalogVisibility(state, item) === "public")
    .map((item) => buildMarketplaceHotlineSummary(state, item));
  const countValues = (values) =>
    values.reduce((counts, value) => {
      if (!value) {
        return counts;
      }
      counts[value] = (counts[value] || 0) + 1;
      return counts;
    }, {});
  return {
    hotline_count: hotlines.length,
    responder_count: new Set(hotlines.map((item) => item.responder_id)).size,
    task_types: countValues(hotlines.flatMap((item) => item.task_types || [])),
    capabilities: countValues(hotlines.flatMap((item) => item.capabilities || [])),
    tags: countValues(hotlines.flatMap((item) => item.tags || [])),
    updated_at: nowIso()
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

function registerCallerUser(state, body) {
  const contactEmail = body.contact_email || body.email;
  if (!contactEmail) {
    return { error: { code: "CONTRACT_INVALID_REGISTER_BODY", message: "contact_email is required", retryable: false }, statusCode: 400 };
  }

  const user = {
    user_id: randomId("user"),
    contact_email: contactEmail,
    api_key: `sk_caller_${crypto.randomBytes(12).toString("hex")}`,
    roles: ["caller"],
    created_at: nowIso()
  };

  state.users.set(user.user_id, user);
  state.apiKeys.set(user.api_key, {
    type: "caller",
    user_id: user.user_id,
    scopes: ["caller"]
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
    if (apiKeyRecord.type === "caller" && apiKeyRecord.user_id === userId) {
      const scopes = new Set(apiKeyRecord.scopes || ["caller"]);
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
  if (record.type === "caller") {
    const user = state.users.get(record.user_id);
    if (user?.api_key === apiKey) {
      user.api_key = null;
    }
  }
  if (record.type === "responder") {
    const responder = state.responders.get(record.responder_id);
    if (responder?.api_key === apiKey) {
      responder.api_key = null;
    }
  }
  return record;
}

function rotateCallerApiKey(state, userId) {
  const user = state.users.get(userId);
  if (!user) {
    return null;
  }
  if (user.api_key) {
    revokeApiKey(state, user.api_key);
  }
  const apiKey = `sk_caller_${crypto.randomBytes(12).toString("hex")}`;
  user.api_key = apiKey;
  state.apiKeys.set(apiKey, {
    type: "caller",
    user_id: user.user_id,
    scopes: ["caller", ...(user.roles || []).filter((role) => role !== "caller")]
  });
  return {
    user_id: user.user_id,
    api_key: apiKey,
    roles: user.roles
  };
}

function rotateResponderApiKey(state, responderId) {
  const responder = state.responders.get(responderId);
  if (!responder) {
    return null;
  }
  if (responder.api_key) {
    revokeApiKey(state, responder.api_key);
  }
  const apiKey = `sk_responder_${crypto.randomBytes(12).toString("hex")}`;
  responder.api_key = apiKey;
  state.apiKeys.set(apiKey, {
    type: "responder",
    responder_id: responder.responder_id,
    owner_user_id: responder.owner_user_id,
    scopes: responder.scopes,
    hotline_ids: responder.hotline_ids
  });
  return {
    responder_id: responder.responder_id,
    api_key: apiKey,
    hotline_ids: responder.hotline_ids
  };
}

function rotateResponderSigningKey(state, responderId, body = {}) {
  const responder = state.responders.get(responderId);
  if (!responder) {
    return null;
  }
  const nextPublicKeyPem = body.responder_public_key_pem || body.next_public_key_pem;
  if (!nextPublicKeyPem) {
    return {
      error: {
        code: "CONTRACT_INVALID_SIGNING_KEY_ROTATION",
        message: "responder_public_key_pem is required",
        retryable: false
      },
      statusCode: 400
    };
  }
  const previousKeys = Array.isArray(body.previous_public_keys_pem)
    ? body.previous_public_keys_pem.filter(Boolean)
    : responder.responder_public_key_pem
      ? [responder.responder_public_key_pem]
      : [];
  const allKeys = Array.from(new Set([nextPublicKeyPem, ...previousKeys]));
  responder.responder_public_key_pem = nextPublicKeyPem;
  responder.responder_public_keys_pem = allKeys;
  responder.signing_key_rotation_window_until = body.rotation_window_until || null;

  for (const item of state.catalog.values()) {
    if (item.responder_id !== responderId) {
      continue;
    }
    item.responder_public_key_pem = nextPublicKeyPem;
    item.responder_public_keys_pem = allKeys;
    item.signing_key_rotation_window_until = body.rotation_window_until || null;
  }

  return {
    responder_id: responderId,
    responder_public_key_pem: nextPublicKeyPem,
    responder_public_keys_pem: allKeys,
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
      : readBooleanEnv(process.env.ENABLE_BOOTSTRAP_RESPONDERS, true);
  const bootstrapResponderSigning =
    process.env.BOOTSTRAP_RESPONDER_PUBLIC_KEY_PEM && process.env.BOOTSTRAP_RESPONDER_PRIVATE_KEY_PEM
      ? {
          publicKeyPem: decodePemEnv(process.env.BOOTSTRAP_RESPONDER_PUBLIC_KEY_PEM),
          privateKeyPem: decodePemEnv(process.env.BOOTSTRAP_RESPONDER_PRIVATE_KEY_PEM)
        }
      : null;

  const bootstrapResponders = bootstrapEnabled
    ? [
        createResponderIdentity({
          responderId: process.env.BOOTSTRAP_RESPONDER_ID || "responder_starlight",
          hotlineId: process.env.BOOTSTRAP_HOTLINE_ID || "starlight.creative.studio.v1",
          templateRef: "docs/templates/hotlines/starlight.creative.studio.v1/",
          displayName: "Starlight AI 创意工坊",
          taskDeliveryAddress:
            process.env.BOOTSTRAP_TASK_DELIVERY_ADDRESS || "local://relay/responder_starlight/starlight.creative.studio.v1",
          taskTypes: ["creative_generation", "image_synthesis"],
          capabilities: ["image.generate", "style.transfer", "multi_model.orchestrate"],
          tags: ["creative", "image", "ai-generation", "design"],
          summary: "提交创作提示词，AI 后端多模型编排管线生成创意图像。提示词是公开的，生成智能是私有的。",
          description: "Starlight AI 创意工坊展示了 Hotline 的核心价值：Caller 只需提供文字描述，Responder 后端的多阶段模型编排、专有 Prompt 增强模板、风格迁移算法和微调模型全部私有运行。参考图仅作软风格信号，不作直接条件输入。这是\"对外发布接口，不是大脑\"的典型实现。",
          recommendedFor: ["产品摄影和电商视觉素材生成", "营销 Banner 和社交媒体内容创作", "概念图和创意探索", "品牌一致性视觉资产批量生产", "视觉营销方案的快速原型制作"],
          notRecommendedFor: ["需要实时修改循环的交互式编辑工作流", "需要严格法律准确性的图示（医疗、法律、金融图表）", "无专项协议情况下的超高分辨率印刷生产（> 4K）"],
          limitations: ["最大提示词长度：2,000 字符", "每次调用最多生成 4 个变体", "参考图仅作为软风格信号，不作为直接条件输入", "pipeline_stage_count 不透露具体阶段详情"],
          inputSummary: "提供创作提示词（必需，最大 2,000 字符），可选指定风格预设、输出格式、生成数量和宽高比，可附带参考图",
          outputSummary: "返回 generated_items 数组（含附件角色引用和尺寸），所有图像文件通过输出附件返回，至少保证一个资产",
          inputSchema: {
            type: "object",
            required: ["prompt"],
            properties: {
              prompt: { type: "string", description: "创作提示词，自然语言描述期望的创意产出", minLength: 1, maxLength: 2000 },
              style_preset: { type: "string", enum: ["cinematic", "illustration", "product_clean", "editorial", "abstract", "anime", "photorealistic"], default: "photorealistic", description: "风格预设" },
              output_format: { type: "string", enum: ["jpeg", "png", "webp"], default: "jpeg", description: "输出格式" },
              quantity: { type: "integer", minimum: 1, maximum: 4, default: 1, description: "生成变体数量（1–4）" },
              aspect_ratio: { type: "string", enum: ["1:1", "4:3", "16:9", "9:16", "3:4"], default: "1:1", description: "输出宽高比" },
              reference_image_hint: { type: "string", const: "reference_image", description: "参考图附件角色名（可选）" }
            },
            additionalProperties: false
          },
          outputSchema: {
            type: "object",
            required: ["generated_items", "metadata"],
            properties: {
              generated_items: { type: "array", minItems: 1, items: { type: "object", required: ["attachment_role", "format", "width", "height"], properties: { attachment_role: { type: "string" }, format: { type: "string" }, width: { type: "integer" }, height: { type: "integer" }, seed: { type: "integer" } } } },
              metadata: { type: "object", required: ["generation_time_ms"], properties: { generation_time_ms: { type: "integer" }, pipeline_stage_count: { type: "integer" }, model_version: { type: "string" }, style_applied: { type: "string" } } }
            },
            additionalProperties: false
          },
          inputAttachments: {
            accepts_files: true,
            max_files: 1,
            max_total_size_bytes: 10485760,
            accepted_mime_types: ["image/jpeg", "image/png", "image/webp"],
            file_roles: [{ role: "reference_image", required: false, description: "可选参考图，用于风格或构图引导（最大 10MB）", accepted_types: ["image/jpeg", "image/png", "image/webp"], max_size_bytes: 10485760 }]
          },
          outputAttachments: {
            includes_files: true,
            max_files: 4,
            max_total_size_bytes: 52428800,
            possible_mime_types: ["image/jpeg", "image/png", "image/webp"],
            file_roles: [
              { role: "generated_asset_1", guaranteed: true, description: "第一张生成图（quantity >= 1 时必返回）", possible_types: ["image/jpeg", "image/png", "image/webp"] },
              { role: "generated_asset_2", guaranteed: false, description: "第二张生成图（quantity >= 2 时返回）", possible_types: ["image/jpeg", "image/png", "image/webp"] },
              { role: "generated_asset_3", guaranteed: false, description: "第三张生成图（quantity >= 3 时返回）", possible_types: ["image/jpeg", "image/png", "image/webp"] },
              { role: "generated_asset_4", guaranteed: false, description: "第四张生成图（quantity = 4 时返回）", possible_types: ["image/jpeg", "image/png", "image/webp"] }
            ]
          },
          inputExamples: [
            {
              title: "产品宣传图生成",
              description: "生成一款高端护肤品的产品宣传图，无参考图",
              params: { prompt: "一款高端护肤精华的产品宣传图，背景简洁纯白，柔和的影棚光线，高端编辑风格", style_preset: "product_clean", output_format: "jpeg", quantity: 2, aspect_ratio: "1:1" },
              attachments: []
            }
          ],
          outputExamples: [
            {
              title: "双变体生成结果",
              result: { generated_items: [{ attachment_role: "generated_asset_1", format: "jpeg", width: 1024, height: 1024, seed: 8472910 }, { attachment_role: "generated_asset_2", format: "jpeg", width: 1024, height: 1024, seed: 8472911 }], metadata: { generation_time_ms: 14200, pipeline_stage_count: 5, model_version: "starlight-v3.2", style_applied: "product_clean" } },
              attachments: [{ role: "generated_asset_1", filename: "render_001.jpg", mime_type: "image/jpeg" }, { role: "generated_asset_2", filename: "render_002.jpg", mime_type: "image/jpeg" }]
            }
          ],
          templateVersion: "1.0.0",
          apiKey: process.env.BOOTSTRAP_RESPONDER_API_KEY || null,
          ownerUserId: process.env.BOOTSTRAP_RESPONDER_OWNER_USER_ID || null,
          signing: bootstrapResponderSigning
        }),
        createResponderIdentity({
          responderId: "responder_atlas",
          hotlineId: "atlas.knowledge.qa.v1",
          templateRef: "docs/templates/hotlines/atlas.knowledge.qa.v1/",
          displayName: "Atlas 企业知识问答",
          taskDeliveryAddress: "local://relay/responder_atlas/atlas.knowledge.qa.v1",
          taskTypes: ["knowledge_qa", "rag_retrieval"],
          capabilities: ["knowledge.retrieve", "qa.grounded", "multilingual"],
          tags: ["enterprise", "rag", "knowledge-base", "qa"],
          summary: "提问，从企业私有知识库获得有据可查的回答与引用来源。问题是公开的，知识是私有的。",
          description: "Atlas 企业知识问答展示了 Hotline 的第二种典型模式：Caller 只发送一个问题字符串，Responder 的私有知识语料库、检索策略、领域微调嵌入模型和重排序算法全部私有运行，知识本身永远不会向外流出。适合企业将内部 HR、政策、合规、技术文档等知识服务化。",
          recommendedFor: ["企业内部 HR、政策、合规问答", "客户支持知识库检索", "工程团队技术文档助手", "新员工入职知识查询", "专有文档集合的研究综合"],
          notRecommendedFor: ["需要实时外部数据的问题（股价、实时新闻）", "需要严格逐字法律引用的任务", "开放域通用知识问答（更适合通用 LLM）"],
          limitations: ["最大问题长度：1,000 字符", "retrieval_coverage: 'none' 表示知识库无相关覆盖", "置信度低于 0.6 时请谨慎对待答案", "sources[].excerpt 可能因策略限制被省略"],
          inputSummary: "提供自然语言问题（必需，最大 1,000 字符），可选指定响应语言、最大引用数量和检索焦点提示，无文件附件",
          outputSummary: "返回 answer（有据可查的自然语言回答）、confidence（0.0–1.0）、sources（引用列表）、可选 follow_up_questions 和 retrieval_coverage，无文件附件",
          inputSchema: {
            type: "object",
            required: ["question"],
            properties: {
              question: { type: "string", description: "自然语言问题", minLength: 1, maxLength: 1000 },
              language: { type: "string", pattern: "^[a-z]{2}(-[A-Z]{2})?$", default: "zh-CN", description: "响应语言 BCP-47 标签" },
              max_sources: { type: "integer", minimum: 1, maximum: 10, default: 3, description: "最大引用数量（1–10，默认 3）" },
              context_hint: { type: "string", maxLength: 200, description: "可选，领域或主题提示（如 'HR policy'、'Q3 financial report'）" }
            },
            additionalProperties: false
          },
          outputSchema: {
            type: "object",
            required: ["answer", "confidence"],
            properties: {
              answer: { type: "string", description: "基于私有知识库的回答" },
              confidence: { type: "number", minimum: 0, maximum: 1, description: "置信度（0.0–1.0）" },
              sources: { type: "array", items: { type: "object", required: ["title", "relevance_score"], properties: { title: { type: "string" }, excerpt: { type: "string" }, relevance_score: { type: "number", minimum: 0, maximum: 1 } } } },
              follow_up_questions: { type: "array", items: { type: "string" }, maxItems: 3 },
              retrieval_coverage: { type: "string", enum: ["full", "partial", "none"] }
            },
            additionalProperties: false
          },
          inputAttachments: { accepts_files: false },
          outputAttachments: { includes_files: false },
          inputExamples: [
            {
              title: "差旅报销政策查询",
              description: "查询公司差旅报销标准",
              params: { question: "我们公司对员工出差报销的标准是什么？国内二线城市的住宿上限是多少？", language: "zh-CN", max_sources: 3, context_hint: "HR policy" },
              attachments: []
            }
          ],
          outputExamples: [
            {
              title: "有据可查的回答",
              result: { answer: "根据公司差旅管理规定（2024年修订版），国内二线城市的住宿报销上限为每晚 450 元人民币（税后）。", confidence: 0.92, sources: [{ title: "差旅管理规定（2024年修订版）- 第3章 住宿标准", excerpt: "二线城市住宿费用报销上限为每晚人民币450元（税后），超标须提前审批。", relevance_score: 0.97 }], follow_up_questions: ["差旅报销流程需要提交哪些材料？", "超标住宿的审批流程是什么？"], retrieval_coverage: "full" },
              attachments: []
            }
          ],
          templateVersion: "1.0.0"
        }),
        createResponderIdentity({
          responderId: "responder_pixel",
          hotlineId: "pixel.product.renderer.v1",
          templateRef: "docs/templates/hotlines/pixel.product.renderer.v1/",
          displayName: "Pixel 产品图渲染器",
          taskDeliveryAddress: "local://relay/responder_pixel/pixel.product.renderer.v1",
          taskTypes: ["product_render", "image_compositing"],
          capabilities: ["image.render", "background.synthesis", "product.retouch"],
          tags: ["ecommerce", "product-photo", "rendering", "image-ai"],
          summary: "上传产品照片，私有微调渲染模型生成高质量电商视觉素材。产品是公开的，渲染智能是私有的。",
          description: "Pixel 产品图渲染器展示了 Hotline 文件输入+图像输出模式：Caller 上传产品照片和描述，Responder 的专有微调渲染模型、背景合成算法、多道合成管线和后处理预设全部私有运行。源照片处理后不被存储。适合电商和品牌客户批量生产高质量产品视觉素材。",
          recommendedFor: ["电商平台产品详情页视觉素材", "产品发布营销资产批量生产", "多角度产品渲染用于目录生成", "广告投放的快速视觉 A/B 测试", "经销商白牌产品摄影替换"],
          notRecommendedFor: ["需要物理触感细节精确还原的产品（如面料质地认证）", "严格的工程制图或技术线图", "视频或动态产品渲染（仅生成静态图像）"],
          limitations: ["源照片最大大小：15MB", "支持输入格式：JPEG、PNG、WebP", "每次调用最多生成 4 张渲染图", "background_removal_applied: false 表示背景复杂，建议预先裁剪"],
          inputSummary: "提供产品描述（必需，最大 1,500 字符）和 product_photo 附件（必需，最大 15MB），可选指定背景风格、角度、分辨率和数量",
          outputSummary: "返回 renders 数组（含附件角色引用和风格信息），所有图像通过输出附件返回，至少返回一张渲染图",
          inputSchema: {
            type: "object",
            required: ["product_description"],
            properties: {
              product_description: { type: "string", description: "产品描述（材质、颜色、关键特征、渲染需求等）", minLength: 10, maxLength: 1500 },
              background_style: { type: "string", enum: ["pure_white", "gradient_soft", "lifestyle_studio", "outdoor_natural", "dark_premium", "transparent"], default: "pure_white", description: "背景风格" },
              angle: { type: "string", enum: ["front", "three_quarter", "top_down", "side", "hero_45"], default: "three_quarter", description: "主要拍摄角度" },
              resolution: { type: "string", enum: ["1024x1024", "1500x1500", "2048x2048", "1080x1350"], default: "1500x1500", description: "输出分辨率预设" },
              quantity: { type: "integer", minimum: 1, maximum: 4, default: 1, description: "生成渲染图数量（1–4）" }
            },
            additionalProperties: false
          },
          outputSchema: {
            type: "object",
            required: ["renders", "metadata"],
            properties: {
              renders: { type: "array", minItems: 1, items: { type: "object", required: ["attachment_role", "width", "height", "format"], properties: { attachment_role: { type: "string" }, width: { type: "integer" }, height: { type: "integer" }, format: { type: "string" }, background_applied: { type: "string" }, angle_applied: { type: "string" } } } },
              metadata: { type: "object", required: ["render_time_ms"], properties: { render_time_ms: { type: "integer" }, model_version: { type: "string" }, background_removal_applied: { type: "boolean" } } }
            },
            additionalProperties: false
          },
          inputAttachments: {
            accepts_files: true,
            max_files: 1,
            max_total_size_bytes: 15728640,
            accepted_mime_types: ["image/jpeg", "image/png", "image/webp"],
            file_roles: [{ role: "product_photo", required: true, description: "待渲染的产品照片（JPEG/PNG/WebP，最大 15MB）", accepted_types: ["image/jpeg", "image/png", "image/webp"], max_size_bytes: 15728640 }]
          },
          outputAttachments: {
            includes_files: true,
            max_files: 4,
            max_total_size_bytes: 52428800,
            possible_mime_types: ["image/jpeg", "image/png", "image/webp"],
            file_roles: [
              { role: "rendered_image_1", guaranteed: true, description: "第一张渲染图（quantity >= 1 时必返回）", possible_types: ["image/jpeg", "image/png", "image/webp"] },
              { role: "rendered_image_2", guaranteed: false, description: "第二张渲染图（quantity >= 2 时返回）", possible_types: ["image/jpeg", "image/png", "image/webp"] },
              { role: "rendered_image_3", guaranteed: false, description: "第三张渲染图（quantity >= 3 时返回）", possible_types: ["image/jpeg", "image/png", "image/webp"] },
              { role: "rendered_image_4", guaranteed: false, description: "第四张渲染图（quantity = 4 时返回）", possible_types: ["image/jpeg", "image/png", "image/webp"] }
            ]
          },
          inputExamples: [
            {
              title: "蓝牙耳机产品渲染",
              description: "上传一张耳机照片，生成深色高端背景的产品渲染图",
              params: { product_description: "一款黑色哑光铝合金外壳的蓝牙耳机，弧形头梁，带软垫耳罩，侧面有金属品牌标识。展示科技感和高端质感。", background_style: "dark_premium", angle: "three_quarter", resolution: "1500x1500", quantity: 2 },
              attachments: [{ role: "product_photo", filename: "headphone_raw.jpg", mime_type: "image/jpeg" }]
            }
          ],
          outputExamples: [
            {
              title: "双角度渲染结果",
              result: { renders: [{ attachment_role: "rendered_image_1", width: 1500, height: 1500, format: "jpeg", background_applied: "dark_premium", angle_applied: "three_quarter" }, { attachment_role: "rendered_image_2", width: 1500, height: 1500, format: "jpeg", background_applied: "dark_premium", angle_applied: "hero_45" }], metadata: { render_time_ms: 22400, model_version: "pixel-renderer-v2.4", background_removal_applied: true } },
              attachments: [{ role: "rendered_image_1", filename: "render_three_quarter.jpg", mime_type: "image/jpeg" }, { role: "rendered_image_2", filename: "render_hero_45.jpg", mime_type: "image/jpeg" }]
            }
          ],
          templateVersion: "1.0.0"
        })
      ]
    : [];

  const users = new Map();
  const apiKeys = new Map();
  const responders = new Map();
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

  for (const item of bootstrapResponders) {
    responders.set(item.responder.responder_id, item.responder);
    apiKeys.set(item.responder.api_key, {
      type: "responder",
      responder_id: item.responder.responder_id,
      owner_user_id: item.responder.owner_user_id,
      scopes: item.responder.scopes,
      hotline_ids: item.responder.hotline_ids
    });
    catalog.set(item.catalogItem.hotline_id, { ...item.catalogItem });
    templates.set(
      item.catalogItem.template_ref,
      createTemplateBundle(item.catalogItem.template_ref, item.templateOptions)
    );
  }

  return {
    tokenSecret,
    tokenTtlSeconds,
    limits: options.limits || buildPlatformLimits(),
    users,
    apiKeys,
    responders,
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
      responders: bootstrapResponders.map((item) => ({
        responder_id: item.responder.responder_id,
        hotline_id: item.catalogItem.hotline_id,
        api_key: item.responder.api_key,
        signing: item.signing
      }))
    }
  };
}

export function serializePlatformState(state) {
  return {
    users: Array.from(state.users.entries()),
    apiKeys: Array.from(state.apiKeys.entries()),
    responders: Array.from(state.responders.entries()),
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
    ["responders", state.responders],
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

function requireCaller(req, res, state) {
  const auth = requireAuth(req, res, state);
  if (!auth) {
    return null;
  }
  if (auth.type !== "caller") {
    sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "caller lacks the required caller scope");
    return null;
  }
  return auth;
}

function requireResponder(req, res, state, { responderId, hotlineId } = {}) {
  const auth = requireAuth(req, res, state);
  if (!auth) {
    return null;
  }
  if (auth.type !== "responder") {
    sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "caller lacks the required responder scope");
    return null;
  }
  if (responderId && auth.responder_id !== responderId) {
    sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "responder_id does not match caller identity");
    return null;
  }
  if (hotlineId && !auth.hotline_ids.includes(hotlineId)) {
    sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "hotline_id is not owned by caller");
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
  if (auth.type !== "caller") {
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
      caller_id: null,
      responder_id: null,
      hotline_id: null,
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

function findMatchingRequestEvent(request, { eventType, responderId, hotlineId }) {
  return (request.events || []).find(
    (event) => event.event_type === eventType && event.responder_id === responderId && event.hotline_id === hotlineId
  );
}

function buildResponderAdminSummary(state, responder, catalogItems = []) {
  return {
    responder_id: responder.responder_id,
    owner_user_id: responder.owner_user_id,
    contact_email: responder.contact_email,
    support_email: responder.support_email,
    status: responder.status || "disabled",
    review_status: responder.review_status || "pending",
    reviewed_at: responder.reviewed_at || null,
    reviewed_by: responder.reviewed_by || null,
    review_reason: responder.review_reason || null,
    availability_status: responder.availability_status,
    last_heartbeat_at: responder.last_heartbeat_at,
    hotline_ids: responder.hotline_ids,
    hotline_count: catalogItems.length,
    hotlines: catalogItems.map((item) => ({
      hotline_id: item.hotline_id,
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
    caller_id: request.caller_id,
    responder_id: request.responder_id,
    hotline_id: request.hotline_id,
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
  if (auth.type === "caller") {
    return { actor_type: "caller", actor_id: auth.user_id };
  }
  return { actor_type: auth.type || "unknown", actor_id: auth.user_id || auth.responder_id || null };
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
    responder_id: body.responder_id,
    hotline_id: body.hotline_id,
    display_name: body.display_name,
    description: body.description || null,
    summary: body.summary || null,
    template_ref: body.template_ref || `${body.hotline_id}@v1`,
    responder_public_key_pem: body.responder_public_key_pem,
    task_delivery_address: body.task_delivery_address || `local://relay/${body.responder_id}/${body.hotline_id}`,
    task_types: normalizeStringList(body.task_types),
    capabilities: normalizeStringList(body.capabilities),
    tags: normalizeStringList(body.tags),
    input_schema: body.input_schema || null,
    output_schema: body.output_schema || null,
    input_attachments: body.input_attachments || null,
    output_attachments: body.output_attachments || null,
    input_examples: Array.isArray(body.input_examples) ? body.input_examples : null,
    output_examples: Array.isArray(body.output_examples) ? body.output_examples : null,
    recommended_for: Array.isArray(body.recommended_for) ? body.recommended_for : null,
    not_recommended_for: Array.isArray(body.not_recommended_for) ? body.not_recommended_for : null,
    limitations: Array.isArray(body.limitations) ? body.limitations : null,
    input_summary: body.input_summary || null,
    output_summary: body.output_summary || null,
    contact_email: body.contact_email || null,
    support_email: body.support_email || null
  };
}

function determineSubmissionVersion(state, hotlineId) {
  const current = state.submissions.get(hotlineId);
  return Number(current?.submission_version || 0) + 1;
}

function createTaskClaims(state, {
  callerId,
  requestId,
  responderId,
  hotlineId,
  requestKind = "remote_request"
}) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const tokenTtlSeconds = Number(process.env.TOKEN_TTL_SECONDS || state.tokenTtlSeconds);
  const claims = {
    iss: "delexec-platform-api",
    sub: callerId,
    aud: responderId,
    jti: randomId("tok"),
    iat: issuedAt,
    exp: issuedAt + tokenTtlSeconds,
    caller_id: callerId,
    request_id: requestId,
    responder_id: responderId,
    hotline_id: hotlineId,
    request_kind: requestKind
  };
  return {
    claims,
    task_token: signToken(state.tokenSecret, claims)
  };
}

function createDeliveryMeta(state, request, catalogItem, resultDelivery) {
  request.expected_signer_public_key_pem = catalogItem.responder_public_key_pem;
  request.delivery_meta = {
    request_id: request.request_id,
    responder_id: catalogItem.responder_id,
    hotline_id: catalogItem.hotline_id,
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
    responder_public_key_pem: catalogItem.responder_public_key_pem
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
    resultPackage.responder_id !== request.responder_id ||
    resultPackage.hotline_id !== request.hotline_id
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
    from: REVIEW_TEST_CALLER_ID,
    to: request.delivery_meta.task_delivery.address,
    type: "task.requested",
    request_id: request.request_id,
    responder_id: request.responder_id,
    hotline_id: request.hotline_id,
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
  const catalogItem = state.catalog.get(body.hotline_id);
  const responder = state.responders.get(body.responder_id);
  if (
    !catalogItem ||
    !responder ||
    catalogItem.responder_id !== body.responder_id ||
    resolveCatalogVisibility(state, catalogItem) !== "public"
  ) {
    return { error: { code: "CATALOG_HOTLINE_NOT_FOUND", message: "hotline not found or not enabled", retryable: false } };
  }

  const request = getOrCreateRequest(state, body.request_id);
  if (request.caller_id && request.caller_id !== auth.user_id) {
    return { error: { code: "AUTH_RESOURCE_FORBIDDEN", message: "request is owned by another caller", retryable: false }, statusCode: 403 };
  }
  if (request.responder_id && request.responder_id !== body.responder_id) {
    return { error: { code: "REQUEST_BINDING_MISMATCH", message: "responder_id or hotline_id does not match existing request", retryable: false }, statusCode: 409 };
  }
  if (request.hotline_id && request.hotline_id !== body.hotline_id) {
    return { error: { code: "REQUEST_BINDING_MISMATCH", message: "responder_id or hotline_id does not match existing request", retryable: false }, statusCode: 409 };
  }

  const issued = createTaskClaims(state, {
    callerId: auth.user_id,
    requestId: body.request_id,
    responderId: body.responder_id,
    hotlineId: body.hotline_id
  });
  request.caller_id = auth.user_id;
  request.responder_id = body.responder_id;
  request.hotline_id = body.hotline_id;
  request.request_kind ||= "remote_request";
  request.request_visibility ||= "public";
  appendRequestEvent(request, "TASK_TOKEN_ISSUED", { actor_type: "caller" });

  return issued;
}

function submitCatalogHotline(state, body, auth = null, { allowUnauthenticatedCreate = false } = {}) {
  if (!body.responder_id || !body.hotline_id || !body.display_name || !body.responder_public_key_pem) {
    return {
      error: {
        code: "CONTRACT_INVALID_RESPONDER_REGISTER_BODY",
        message: "responder_id, hotline_id, display_name, and responder_public_key_pem are required",
        retryable: false
      },
      statusCode: 400
    };
  }

  const existingResponder = state.responders.get(body.responder_id) || null;
  const existingItem = state.catalog.get(body.hotline_id) || null;
  if (existingItem && existingItem.responder_id !== body.responder_id) {
    return {
      error: { code: "HOTLINE_ID_ALREADY_EXISTS", message: "a hotline with this id is already registered", retryable: false },
      statusCode: 409
    };
  }

  if (existingResponder && !existingItem && (existingResponder.hotline_ids || []).length >= (state.limits?.hotlinesPerResponder || DEFAULT_HOTLINE_QUOTA_PER_RESPONDER)) {
    return {
      error: {
        code: "HOTLINE_QUOTA_EXCEEDED",
        message: `responder has reached the configured hotline quota of ${state.limits?.hotlinesPerResponder || DEFAULT_HOTLINE_QUOTA_PER_RESPONDER}`,
        retryable: false
      },
      statusCode: 429
    };
  }

  if (!existingResponder && !auth && !allowUnauthenticatedCreate) {
    return {
      error: { code: "AUTH_UNAUTHORIZED", message: "caller or responder authentication is required for onboarding", retryable: false },
      statusCode: 401
    };
  }

  if (existingResponder) {
    if (!auth) {
      return {
        error: { code: "AUTH_UNAUTHORIZED", message: "authentication required to manage an existing responder", retryable: false },
        statusCode: 401
      };
    }
    if (!canManageResponder(auth, existingResponder)) {
      const ownerIsRegisteredUser = state.users.has(existingResponder.owner_user_id);
      const publicKeyMatches =
        body.responder_public_key_pem &&
        existingResponder.responder_public_key_pem === body.responder_public_key_pem;
      if (!ownerIsRegisteredUser || publicKeyMatches) {
        existingResponder.owner_user_id = auth.user_id;
        state.responders.set(existingResponder.responder_id, existingResponder);
        addUserRole(state, auth.user_id, "responder");
      } else {
        return {
          error: { code: "AUTH_RESOURCE_FORBIDDEN", message: "caller does not own this responder identity", retryable: false },
          statusCode: 403
        };
      }
    }
  }

  const submissionPayload = buildSubmissionPayload(body);
  const ownerUserId = existingResponder?.owner_user_id || auth?.user_id || body.owner_user_id || randomId("user");
  const responderApiKey = existingResponder?.api_key || `sk_responder_${crypto.randomBytes(12).toString("hex")}`;
  const heartbeatAt = nowIso();
  const templateRef = submissionPayload.template_ref;
  const submissionVersion = determineSubmissionVersion(state, body.hotline_id);

  const responder = existingResponder || {
    responder_id: body.responder_id,
    owner_user_id: ownerUserId,
    api_key: responderApiKey,
    scopes: ["responder"],
    hotline_ids: [],
    status: "disabled",
    review_status: "pending",
    reviewed_at: null,
    reviewed_by: null,
    review_reason: null,
    responder_public_key_pem: body.responder_public_key_pem,
    responder_public_keys_pem: existingResponder?.responder_public_keys_pem || [body.responder_public_key_pem],
    last_heartbeat_at: heartbeatAt,
    availability_status: "healthy",
    contact_email: body.contact_email || state.users.get(ownerUserId)?.contact_email || `${body.responder_id}@test.local`,
    support_email: body.support_email || `support+${body.responder_id}@test.local`
  };

  const responderChanged =
    !existingResponder ||
    responder.contact_email !== (body.contact_email || responder.contact_email) ||
    responder.support_email !== (body.support_email || responder.support_email) ||
    responder.responder_public_key_pem !== body.responder_public_key_pem;

  responder.contact_email = body.contact_email || responder.contact_email;
  responder.support_email = body.support_email || responder.support_email;
  responder.responder_public_key_pem = body.responder_public_key_pem;
  responder.responder_public_keys_pem = Array.from(new Set([body.responder_public_key_pem, ...(responder.responder_public_keys_pem || [])]));
  responder.hotline_ids = Array.from(new Set([...(responder.hotline_ids || []), body.hotline_id]));
  responder.last_heartbeat_at = responder.last_heartbeat_at || heartbeatAt;
  responder.availability_status ||= "healthy";
  if (!existingResponder || responderChanged) {
    responder.review_status = "pending";
    responder.status = "disabled";
    responder.reviewed_at = null;
    responder.reviewed_by = null;
    responder.review_reason = null;
  }

  const catalogItem = {
    responder_id: body.responder_id,
    hotline_id: body.hotline_id,
    display_name: body.display_name,
    description: body.description || existingItem?.description || null,
    summary: submissionPayload.summary || existingItem?.summary || null,
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
    input_attachments: submissionPayload.input_attachments || existingItem?.input_attachments || null,
    output_attachments: submissionPayload.output_attachments || existingItem?.output_attachments || null,
    input_examples: submissionPayload.input_examples || existingItem?.input_examples || null,
    output_examples: submissionPayload.output_examples || existingItem?.output_examples || null,
    recommended_for: submissionPayload.recommended_for || existingItem?.recommended_for || null,
    not_recommended_for: submissionPayload.not_recommended_for || existingItem?.not_recommended_for || null,
    limitations: submissionPayload.limitations || existingItem?.limitations || null,
    input_summary: submissionPayload.input_summary || existingItem?.input_summary || null,
    output_summary: submissionPayload.output_summary || existingItem?.output_summary || null,
    responder_public_key_pem: submissionPayload.responder_public_key_pem,
    responder_public_keys_pem: responder.responder_public_keys_pem,
    task_delivery_address: submissionPayload.task_delivery_address
  };

  state.responders.set(responder.responder_id, responder);
  state.apiKeys.set(responderApiKey, {
    type: "responder",
    responder_id: responder.responder_id,
    owner_user_id: ownerUserId,
    scopes: responder.scopes,
    hotline_ids: responder.hotline_ids
  });
  state.catalog.set(catalogItem.hotline_id, catalogItem);
  state.templates.set(
    templateRef,
    createTemplateBundle(templateRef, {
      inputSchema: catalogItem.input_schema,
      outputSchema: catalogItem.output_schema,
      inputAttachments: catalogItem.input_attachments,
      outputAttachments: catalogItem.output_attachments,
      inputExamples: catalogItem.input_examples,
      outputExamples: catalogItem.output_examples
    })
  );
  state.submissions.set(catalogItem.hotline_id, {
    responder_id: responder.responder_id,
    hotline_id: catalogItem.hotline_id,
    owner_user_id: ownerUserId,
    submitted_at: heartbeatAt,
    submitted_by: auth?.user_id || auth?.responder_id || "system",
    review_reason: body.review_reason || body.reason || null,
    submission_version: submissionVersion,
    submitted_payload: submissionPayload,
    latest_review_test_request_id: existingItem ? state.submissions.get(catalogItem.hotline_id)?.latest_review_test_request_id || null : null
  });

  if (auth?.user_id) {
    addUserRole(state, auth.user_id, "responder");
  }

  if (!existingResponder || responderChanged) {
    appendReviewEvent(
      state,
      auth,
      "pending",
      { type: "responder", id: responder.responder_id },
      {
        responder_id: responder.responder_id,
        hotline_id: catalogItem.hotline_id,
        submission_version: submissionVersion,
        reason: body.review_reason || body.reason || null
      }
    );
  }
  appendReviewEvent(
    state,
    auth,
    "pending",
    { type: "hotline", id: catalogItem.hotline_id },
    {
      responder_id: responder.responder_id,
      hotline_id: catalogItem.hotline_id,
      submission_version: submissionVersion,
      reason: body.review_reason || body.reason || null
    }
  );

  return {
    responder_id: responder.responder_id,
    hotline_id: catalogItem.hotline_id,
    responder_api_key: responderApiKey,
    api_key: responderApiKey,
    owner_user_id: ownerUserId,
    task_delivery_address: catalogItem.task_delivery_address,
    responder_public_key_pem: catalogItem.responder_public_key_pem,
    status: catalogItem.status,
    responder_status: responder.status,
    hotline_status: catalogItem.status,
    responder_review_status: responder.review_status,
    hotline_review_status: catalogItem.review_status,
    review_status: catalogItem.review_status,
    catalog_visibility: resolveCatalogVisibility(state, catalogItem),
    submission_version: submissionVersion,
    task_types: catalogItem.task_types,
    capabilities: catalogItem.capabilities,
    tags: catalogItem.tags
  };
}

function registerResponderIdentity(state, body, auth = null) {
  return submitCatalogHotline(state, body, auth, {
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
      "# HELP rsp_platform_catalog_public_hotlines Total public hotlines visible in catalog.",
      "# TYPE rsp_platform_catalog_public_hotlines gauge",
      `rsp_platform_catalog_public_hotlines ${Array.from(state.catalog.values()).filter((item) => resolveCatalogVisibility(state, item) === "public").length}`,
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
        const user = registerCallerUser(state, body);
        if (user.error) {
          sendJson(res, user.statusCode || 400, { error: user.error });
          return;
        }
        await persistPlatformState(onStateChanged, state);

        sendJson(res, 201, user);
        return;
      }

      if (method === "POST" && pathname === "/v2/responders/register") {
        const body = await parseJsonBody(req);
        const auth = resolveAuth(req, state);
        if (auth && auth.type !== "caller" && auth.type !== "responder") {
          sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "only caller or responder callers may register");
          return;
        }
        if (!enforceRateLimit(req, res, "registerResponderMax", auth)) {
          return;
        }
        const registered = registerResponderIdentity(state, body, auth);
        if (registered.error) {
          sendJson(res, registered.statusCode || 400, { error: registered.error });
          return;
        }
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 201, registered);
        return;
      }

      if (method === "POST" && pathname === "/v2/hotlines") {
        const auth = requireAuth(req, res, state);
        if (!auth) {
          return;
        }
        if (auth.type !== "caller" && auth.type !== "responder") {
          sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "only caller or responder callers may submit onboarding");
          return;
        }
        if (!enforceRateLimit(req, res, "catalogSubmitMax", auth)) {
          return;
        }

        const body = await parseJsonBody(req);
        const registered = submitCatalogHotline(state, body, auth);
        if (registered.error) {
          sendJson(res, registered.statusCode || 400, { error: registered.error });
          return;
        }
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 201, registered);
        return;
      }

      if (method === "GET" && pathname === "/v2/hotlines") {
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

      if (method === "GET" && pathname === "/marketplace/hotlines") {
        const taskTypeFilter = url.searchParams.get("task_type");
        const capabilityFilter = url.searchParams.get("capability");
        const tagFilter = url.searchParams.get("tag");
        const responderFilter = url.searchParams.get("responder_id");
        const items = Array.from(state.catalog.values())
          .filter((item) => resolveCatalogVisibility(state, item) === "public")
          .filter((item) => !taskTypeFilter || (item.task_types || []).includes(taskTypeFilter))
          .filter((item) => !capabilityFilter || (item.capabilities || []).includes(capabilityFilter))
          .filter((item) => !tagFilter || (item.tags || []).includes(tagFilter))
          .filter((item) => !responderFilter || item.responder_id === responderFilter)
          .map((item) => buildMarketplaceHotlineSummary(state, item));

        sendJson(res, 200, { items });
        return;
      }

      if (method === "GET" && pathname === "/marketplace/meta") {
        sendJson(res, 200, buildMarketplaceMeta(state));
        return;
      }

      const marketplaceHotlineMatch = pathname.match(/^\/marketplace\/hotlines\/([^/]+)$/);
      if (method === "GET" && marketplaceHotlineMatch) {
        const item = state.catalog.get(marketplaceHotlineMatch[1]);
        if (!item || resolveCatalogVisibility(state, item) !== "public") {
          sendError(res, 404, "MARKETPLACE_HOTLINE_NOT_FOUND", "hotline not found in marketplace");
          return;
        }
        sendJson(res, 200, buildMarketplaceHotlineDetail(state, item));
        return;
      }

      const marketplaceTemplateBundleMatch = pathname.match(/^\/marketplace\/hotlines\/([^/]+)\/template-bundle$/);
      if (method === "GET" && marketplaceTemplateBundleMatch) {
        const hotlineId = marketplaceTemplateBundleMatch[1];
        const templateRef = url.searchParams.get("template_ref");
        const item = state.catalog.get(hotlineId);
        if (!item || resolveCatalogVisibility(state, item) !== "public") {
          sendError(res, 404, "TEMPLATE_NOT_FOUND", "hotline or template not found in marketplace");
          return;
        }
        if (templateRef && item.template_ref !== templateRef) {
          sendError(res, 409, "TEMPLATE_REF_MISMATCH", "template_ref does not match catalog entry");
          return;
        }
        const bundle = state.templates.get(item.template_ref);
        if (!bundle) {
          sendError(res, 404, "TEMPLATE_NOT_FOUND", "template bundle not found");
          return;
        }
        sendJson(res, 200, bundle);
        return;
      }

      const marketplaceResponderMatch = pathname.match(/^\/marketplace\/responders\/([^/]+)$/);
      if (method === "GET" && marketplaceResponderMatch) {
        const responder = state.responders.get(marketplaceResponderMatch[1]);
        const hasPublicHotlines = Array.from(state.catalog.values()).some(
          (item) => item.responder_id === marketplaceResponderMatch[1] && resolveCatalogVisibility(state, item) === "public"
        );
        if (!responder || !hasPublicHotlines) {
          sendError(res, 404, "MARKETPLACE_RESPONDER_NOT_FOUND", "responder not found in marketplace");
          return;
        }
        sendJson(res, 200, buildMarketplaceResponderProfile(state, responder));
        return;
      }

      const catalogDetailMatch = pathname.match(/^\/v1\/catalog\/hotlines\/([^/]+)$/);
      if (method === "GET" && catalogDetailMatch) {
        const item = state.catalog.get(catalogDetailMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_HOTLINE_NOT_FOUND", "hotline not found in catalog");
          return;
        }
        const auth = resolveAuth(req, state);
        if (!canViewCatalogItemDetail(state, auth, item)) {
          sendError(res, 404, "CATALOG_HOTLINE_NOT_FOUND", "hotline not found in catalog");
          return;
        }
        if (resolveCatalogVisibility(state, item) === "public" && !isOperatorAuth(auth, state) && !canManageResponder(auth, state.responders.get(item.responder_id))) {
          sendJson(res, 200, sanitizeCatalogItemForResponse(state, item));
          return;
        }
        sendJson(res, 200, buildCatalogDetail(state, item));
        return;
      }

      const templateMatch = pathname.match(/^\/v1\/catalog\/hotlines\/([^/]+)\/template-bundle$/);
      if (method === "GET" && templateMatch) {
        const hotlineId = templateMatch[1];
        const templateRef = url.searchParams.get("template_ref");
        const catalogItem = state.catalog.get(hotlineId);
        if (!catalogItem) {
          sendError(res, 404, "TEMPLATE_NOT_FOUND", "hotline or template not found");
          return;
        }
        const auth = resolveAuth(req, state);
        if (!canViewCatalogItemDetail(state, auth, catalogItem)) {
          sendError(res, 404, "TEMPLATE_NOT_FOUND", "hotline or template not found");
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
        const auth = requireCaller(req, res, state);
        if (!auth) {
          return;
        }

        const body = await parseJsonBody(req);
        if (!body.request_id || !body.responder_id || !body.hotline_id) {
          sendError(res, 400, "CONTRACT_INVALID_TOKEN_REQUEST", "request_id, responder_id, and hotline_id are required");
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

        const auth = parsed.claims?.responder_id
          ? requireResponder(req, res, state, {
              responderId: parsed.claims.responder_id,
              hotlineId: parsed.claims.hotline_id
            })
          : requireAuth(req, res, state);
        if (!auth) {
          return;
        }

        if (auth.type !== "responder") {
          sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "only responder callers may introspect tokens");
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
        const auth = requireCaller(req, res, state);
        if (!auth) {
          return;
        }

        const requestId = deliveryMetaMatch[1];
        const body = await parseJsonBody(req);
        const taskToken = body.task_token || body.token || null;
        if (!body.responder_id || !body.hotline_id) {
          sendError(res, 400, "CONTRACT_INVALID_DELIVERY_META_REQUEST", "responder_id and hotline_id are required");
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

        const catalogItem = state.catalog.get(body.hotline_id);
        if (
          !catalogItem ||
          catalogItem.responder_id !== body.responder_id ||
          resolveCatalogVisibility(state, catalogItem) !== "public"
        ) {
          sendError(res, 404, "CATALOG_HOTLINE_NOT_FOUND", "hotline not found or not enabled");
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
            parsed.claims.responder_id !== body.responder_id ||
            parsed.claims.hotline_id !== body.hotline_id ||
            parsed.claims.caller_id !== auth.user_id
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
        if (request.caller_id && request.caller_id !== auth.user_id) {
          sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "request is owned by another caller");
          return;
        }
        if (request.responder_id && request.responder_id !== body.responder_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "responder_id does not match existing request");
          return;
        }
        if (request.hotline_id && request.hotline_id !== body.hotline_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "hotline_id does not match existing request");
          return;
        }
        request.caller_id = auth.user_id;
        request.responder_id = body.responder_id;
        request.hotline_id = body.hotline_id;
        request.request_kind ||= "remote_request";
        request.request_visibility ||= "public";
        createDeliveryMeta(state, request, catalogItem, normalizedResultDelivery);
        appendRequestEvent(request, "DELIVERY_META_ISSUED", { actor_type: "caller" });
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
        if (auth.type !== "responder") {
          sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "only responder callers may ack requests");
          return;
        }
        const body = await parseJsonBody(req);
        if (!body.responder_id || !body.hotline_id) {
          sendError(res, 400, "CONTRACT_INVALID_ACK_REQUEST", "responder_id and hotline_id are required");
          return;
        }
        if (auth.responder_id !== body.responder_id || !auth.hotline_ids.includes(body.hotline_id)) {
          sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "caller does not own the specified responder or hotline");
          return;
        }

        const request = state.requests.get(requestId);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
          return;
        }
        if (request.responder_id && request.responder_id !== body.responder_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "responder_id does not match existing request");
          return;
        }
        if (request.hotline_id && request.hotline_id !== body.hotline_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "hotline_id does not match existing request");
          return;
        }
        request.responder_id = body.responder_id;
        request.hotline_id = body.hotline_id;
        if (!request.events.some((event) => event.event_type === "ACKED" && event.actor_type === "responder")) {
          appendRequestEvent(request, "ACKED", {
            actor_type: "responder",
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
        if (auth.type !== "responder") {
          sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "only responder callers may append request events");
          return;
        }

        const body = await parseJsonBody(req);
        if (!body.responder_id || !body.hotline_id || !body.event_type) {
          sendError(
            res,
            400,
            "CONTRACT_INVALID_REQUEST_EVENT",
            "responder_id, hotline_id, and event_type are required"
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
        if (auth.responder_id !== body.responder_id || !auth.hotline_ids.includes(body.hotline_id)) {
          sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "caller does not own the specified responder or hotline");
          return;
        }

        const request = state.requests.get(requestId);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
          return;
        }
        if (request.responder_id && request.responder_id !== body.responder_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "responder_id does not match existing request");
          return;
        }
        if (request.hotline_id && request.hotline_id !== body.hotline_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "hotline_id does not match existing request");
          return;
        }

        request.responder_id = body.responder_id;
        request.hotline_id = body.hotline_id;

        const existingEvent = findMatchingRequestEvent(request, {
          eventType: body.event_type,
          responderId: body.responder_id,
          hotlineId: body.hotline_id
        });
        if (existingEvent) {
          sendJson(res, 202, { accepted: true, request_id: requestId, event: existingEvent, deduped: true });
          return;
        }

        appendRequestEvent(request, body.event_type, {
          actor_type: "responder",
          responder_id: body.responder_id,
          hotline_id: body.hotline_id,
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
        if (auth.type === "caller" && request.caller_id !== auth.user_id) {
          sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "request is owned by another caller");
          return;
        }
        if (
          auth.type === "responder" &&
          (request.responder_id !== auth.responder_id ||
            (request.hotline_id && !auth.hotline_ids.includes(request.hotline_id)))
        ) {
          sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "responder does not own this request");
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
          if (auth.type === "caller" && request.caller_id !== auth.user_id) {
            items.push({
              request_id: requestId,
              found: false
            });
            continue;
          }
          if (
            auth.type === "responder" &&
            (request.responder_id !== auth.responder_id || (request.hotline_id && !auth.hotline_ids.includes(request.hotline_id)))
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

      const heartbeatMatch = pathname.match(/^\/v1\/responders\/([^/]+)\/heartbeat$/);
      if (method === "POST" && heartbeatMatch) {
        const responderId = heartbeatMatch[1];
        const auth = requireResponder(req, res, state, { responderId });
        if (!auth) {
          return;
        }

        const body = await parseJsonBody(req);
        const responder = state.responders.get(responderId);
        if (!responder) {
          sendError(res, 404, "RESPONDER_NOT_FOUND", "no responder found with this id");
          return;
        }

        const heartbeatAt = nowIso();
        responder.last_heartbeat_at = heartbeatAt;
        responder.availability_status = body.status || "healthy";

        for (const item of state.catalog.values()) {
          if (item.responder_id === responderId) {
            item.last_heartbeat_at = heartbeatAt;
            item.availability_status = body.status || "healthy";
          }
        }
        await persistPlatformState(onStateChanged, state);

        sendJson(res, 202, {
          accepted: true,
          responder_id: responderId,
          status: responder.availability_status,
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

      if (method === "GET" && pathname === "/v2/admin/responders") {
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

        const items = Array.from(state.responders.values())
          .map((responder) =>
            buildResponderAdminSummary(
              state,
              responder,
              Array.from(state.catalog.values()).filter((item) => item.responder_id === responder.responder_id)
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

      if (method === "GET" && pathname === "/v2/admin/hotlines") {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const { limit, offset } = parsePagination(url);
        const q = url.searchParams.get("q");
        const status = url.searchParams.get("status");
        const reviewStatus = url.searchParams.get("review_status");
        const availabilityStatus = url.searchParams.get("availability_status");
        const responderId = url.searchParams.get("responder_id");
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
          .filter((item) => !responderId || item.responder_id === responderId)
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
        const callerId = url.searchParams.get("caller_id");
        const responderId = url.searchParams.get("responder_id");
        const hotlineId = url.searchParams.get("hotline_id");
        const eventType = url.searchParams.get("event_type");

        const items = Array.from(state.requests.values())
          .map(buildRequestAdminSummary)
          .filter((item) => !callerId || item.caller_id === callerId)
          .filter((item) => !responderId || item.responder_id === responderId)
          .filter((item) => !hotlineId || item.hotline_id === hotlineId)
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
        const responderId = url.searchParams.get("responder_id");
        const hotlineId = url.searchParams.get("hotline_id");
        const status = url.searchParams.get("status");
        const verdict = url.searchParams.get("verdict");

        const items = Array.from(state.reviewTests.values())
          .map(summarizeReviewTest)
          .filter((item) => !responderId || item?.responder_id === responderId)
          .filter((item) => !hotlineId || item?.hotline_id === hotlineId)
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

      const callerKeyRotateMatch = pathname.match(/^\/v1\/admin\/users\/([^/]+)\/api-keys\/rotate$/);
      if (method === "POST" && callerKeyRotateMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const rotated = rotateCallerApiKey(state, callerKeyRotateMatch[1]);
        if (!rotated) {
          sendError(res, 404, "USER_NOT_FOUND", "no user found with this id");
          return;
        }
        appendAuditEvent(state, auth, "user.api_key.rotated", { type: "user", id: rotated.user_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, rotated);
        return;
      }

      const responderKeyRotateMatch = pathname.match(/^\/v1\/admin\/responders\/([^/]+)\/api-keys\/rotate$/);
      if (method === "POST" && responderKeyRotateMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const rotated = rotateResponderApiKey(state, responderKeyRotateMatch[1]);
        if (!rotated) {
          sendError(res, 404, "RESPONDER_NOT_FOUND", "no responder found with this id");
          return;
        }
        appendAuditEvent(state, auth, "responder.api_key.rotated", { type: "responder", id: rotated.responder_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, rotated);
        return;
      }

      const responderSigningRotateMatch = pathname.match(/^\/v1\/admin\/responders\/([^/]+)\/signing-keys\/rotate$/);
      if (method === "POST" && responderSigningRotateMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);
        const rotated = rotateResponderSigningKey(state, responderSigningRotateMatch[1], body);
        if (!rotated) {
          sendError(res, 404, "RESPONDER_NOT_FOUND", "no responder found with this id");
          return;
        }
        if (rotated.error) {
          sendJson(res, rotated.statusCode || 400, { error: rotated.error });
          return;
        }
        appendAuditEvent(state, auth, "responder.signing_key.rotated", { type: "responder", id: rotated.responder_id }, {
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
        appendAuditEvent(state, auth, "api_key.revoked", { type: revoked.type || "api_key", id: revoked.user_id || revoked.responder_id || "unknown" });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          revoked: true,
          type: revoked.type,
          user_id: revoked.user_id || null,
          responder_id: revoked.responder_id || null
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

      const adminReviewTestCreateMatch = pathname.match(/^\/v1\/admin\/hotlines\/([^/]+)\/review-tests$/);
      if (method === "POST" && adminReviewTestCreateMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);
        const item = state.catalog.get(adminReviewTestCreateMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_HOTLINE_NOT_FOUND", "hotline not found in catalog");
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
        request.caller_id = REVIEW_TEST_CALLER_ID;
        request.responder_id = item.responder_id;
        request.hotline_id = item.hotline_id;
        request.request_kind = "review_test";
        request.request_visibility = "hidden";

        const issued = createTaskClaims(state, {
          callerId: REVIEW_TEST_CALLER_ID,
          requestId,
          responderId: item.responder_id,
          hotlineId: item.hotline_id,
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
          responder_id: item.responder_id,
          hotline_id: item.hotline_id,
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

        const submission = state.submissions.get(item.hotline_id);
        if (submission) {
          submission.latest_review_test_request_id = requestId;
        }

        appendAuditEvent(state, auth, "review_test.started", { type: "hotline", id: item.hotline_id }, { request_id: requestId });
        await persistPlatformState(onStateChanged, state);

        void runReviewTestHarness(state, reviewTest, request, transport, onStateChanged)
          .then(async () => {
            appendAuditEvent(
              state,
              auth,
              "review_test.completed",
              { type: "hotline", id: item.hotline_id },
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
              { type: "hotline", id: item.hotline_id },
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
          responder_id: item.responder_id,
          hotline_id: item.hotline_id,
          status: reviewTest.status
        });
        return;
      }

      const adminResponderDisableMatch = pathname.match(/^\/v2\/admin\/responders\/([^/]+)\/disable$/);
      if (method === "POST" && adminResponderDisableMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const responder = state.responders.get(adminResponderDisableMatch[1]);
        if (!responder) {
          sendError(res, 404, "RESPONDER_NOT_FOUND", "no responder found with this id");
          return;
        }
        responder.status = "disabled";
        appendAuditEvent(state, auth, "responder.disabled", { type: "responder", id: responder.responder_id }, { reason: body.reason || null });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          responder_id: responder.responder_id,
          status: responder.status,
          review_status: responder.review_status,
          catalog_visibility: "hidden"
        });
        return;
      }

      const adminResponderApproveMatch = pathname.match(/^\/v2\/admin\/responders\/([^/]+)\/approve$/);
      if (method === "POST" && adminResponderApproveMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const responder = state.responders.get(adminResponderApproveMatch[1]);
        if (!responder) {
          sendError(res, 404, "RESPONDER_NOT_FOUND", "no responder found with this id");
          return;
        }
        responder.review_status = "approved";
        responder.status = "enabled";
        responder.reviewed_at = nowIso();
        responder.reviewed_by = describeActor(auth).actor_id;
        responder.review_reason = body.reason || null;
        appendAuditEvent(state, auth, "responder.approved", { type: "responder", id: responder.responder_id }, { reason: body.reason || null });
        appendReviewEvent(state, auth, "approved", { type: "responder", id: responder.responder_id }, { reason: body.reason || null, responder_id: responder.responder_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          responder_id: responder.responder_id,
          status: responder.status,
          review_status: responder.review_status
        });
        return;
      }

      const adminResponderRejectMatch = pathname.match(/^\/v2\/admin\/responders\/([^/]+)\/reject$/);
      if (method === "POST" && adminResponderRejectMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const responder = state.responders.get(adminResponderRejectMatch[1]);
        if (!responder) {
          sendError(res, 404, "RESPONDER_NOT_FOUND", "no responder found with this id");
          return;
        }
        responder.review_status = "rejected";
        responder.status = "disabled";
        responder.reviewed_at = nowIso();
        responder.reviewed_by = describeActor(auth).actor_id;
        responder.review_reason = body.reason || null;
        appendAuditEvent(state, auth, "responder.rejected", { type: "responder", id: responder.responder_id }, { reason: body.reason || null });
        appendReviewEvent(state, auth, "rejected", { type: "responder", id: responder.responder_id }, { reason: body.reason || null, responder_id: responder.responder_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          responder_id: responder.responder_id,
          status: responder.status,
          review_status: responder.review_status,
          catalog_visibility: "hidden"
        });
        return;
      }

      const adminResponderEnableMatch = pathname.match(/^\/v2\/admin\/responders\/([^/]+)\/enable$/);
      if (method === "POST" && adminResponderEnableMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const responder = state.responders.get(adminResponderEnableMatch[1]);
        if (!responder) {
          sendError(res, 404, "RESPONDER_NOT_FOUND", "no responder found with this id");
          return;
        }
        if (responder.review_status !== "approved") {
          sendError(res, 409, "RESPONDER_NOT_APPROVED", "responder must be approved before it can be enabled");
          return;
        }
        responder.status = "enabled";
        appendAuditEvent(state, auth, "responder.enabled", { type: "responder", id: responder.responder_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          responder_id: responder.responder_id,
          status: responder.status,
          review_status: responder.review_status
        });
        return;
      }

      const adminHotlineDisableMatch = pathname.match(/^\/v2\/admin\/hotlines\/([^/]+)\/disable$/);
      if (method === "POST" && adminHotlineDisableMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const item = state.catalog.get(adminHotlineDisableMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_HOTLINE_NOT_FOUND", "hotline not found in catalog");
          return;
        }
        item.status = "disabled";
        appendAuditEvent(state, auth, "hotline.disabled", { type: "hotline", id: item.hotline_id }, { reason: body.reason || null });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          hotline_id: item.hotline_id,
          status: item.status,
          review_status: item.review_status,
          catalog_visibility: resolveCatalogVisibility(state, item)
        });
        return;
      }

      const adminHotlineApproveMatch = pathname.match(/^\/v2\/admin\/hotlines\/([^/]+)\/approve$/);
      if (method === "POST" && adminHotlineApproveMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const item = state.catalog.get(adminHotlineApproveMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_HOTLINE_NOT_FOUND", "hotline not found in catalog");
          return;
        }
        item.review_status = "approved";
        item.status = "enabled";
        item.reviewed_at = nowIso();
        item.reviewed_by = describeActor(auth).actor_id;
        item.review_reason = body.reason || null;
        appendAuditEvent(state, auth, "hotline.approved", { type: "hotline", id: item.hotline_id }, { reason: body.reason || null });
        appendReviewEvent(state, auth, "approved", { type: "hotline", id: item.hotline_id }, { reason: body.reason || null, responder_id: item.responder_id, hotline_id: item.hotline_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          hotline_id: item.hotline_id,
          status: item.status,
          review_status: item.review_status,
          catalog_visibility: resolveCatalogVisibility(state, item)
        });
        return;
      }

      const adminHotlineRejectMatch = pathname.match(/^\/v2\/admin\/hotlines\/([^/]+)\/reject$/);
      if (method === "POST" && adminHotlineRejectMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const item = state.catalog.get(adminHotlineRejectMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_HOTLINE_NOT_FOUND", "hotline not found in catalog");
          return;
        }
        item.review_status = "rejected";
        item.status = "disabled";
        item.reviewed_at = nowIso();
        item.reviewed_by = describeActor(auth).actor_id;
        item.review_reason = body.reason || null;
        appendAuditEvent(state, auth, "hotline.rejected", { type: "hotline", id: item.hotline_id }, { reason: body.reason || null });
        appendReviewEvent(state, auth, "rejected", { type: "hotline", id: item.hotline_id }, { reason: body.reason || null, responder_id: item.responder_id, hotline_id: item.hotline_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          hotline_id: item.hotline_id,
          status: item.status,
          review_status: item.review_status,
          catalog_visibility: resolveCatalogVisibility(state, item)
        });
        return;
      }

      const adminHotlineEnableMatch = pathname.match(/^\/v2\/admin\/hotlines\/([^/]+)\/enable$/);
      if (method === "POST" && adminHotlineEnableMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const item = state.catalog.get(adminHotlineEnableMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_HOTLINE_NOT_FOUND", "hotline not found in catalog");
          return;
        }
        if (item.review_status !== "approved") {
          sendError(res, 409, "HOTLINE_NOT_APPROVED", "hotline must be approved before it can be enabled");
          return;
        }
        item.status = "enabled";
        appendAuditEvent(state, auth, "hotline.enabled", { type: "hotline", id: item.hotline_id });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, {
          hotline_id: item.hotline_id,
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
