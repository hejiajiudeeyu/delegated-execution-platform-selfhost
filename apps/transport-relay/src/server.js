import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildInfoPayload, readPackageVersion } from "@delexec/build-info";
import { buildStructuredError } from "@delexec/contracts";
import { buildOpsEnvSearchPaths, loadEnvFiles } from "@delexec/runtime-utils";
import Database from "better-sqlite3";

import { createRelayAuth } from "./auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../../..");
const RELAY_VERSION = readPackageVersion(import.meta.url);

// How long a polled message stays invisible to other pollers before it becomes
// claimable again (A-02 visibility lease). Long enough for a Provider to finish
// handling and ack; short enough that a crashed consumer's work is retried.
const DEFAULT_VISIBILITY_TIMEOUT_S = 60;

loadEnvFiles([
  ...buildOpsEnvSearchPaths(ROOT_DIR, "relay"),
  path.join(ROOT_DIR, "deploy/all-in-one/.env"),
  path.join(ROOT_DIR, "deploy/all-in-one/.env.local")
]);

function isDirectRun() {
  if (!process.argv[1]) {
    return false;
  }
  return fs.realpathSync.native(path.resolve(process.argv[1])) === fs.realpathSync.native(__filename);
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function newLeaseId() {
  return `lease_${crypto.randomUUID().replace(/-/g, "")}`;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, code, message, { retryable, ...extra } = {}) {
  sendJson(res, statusCode, buildStructuredError(code, message, { retryable, ...extra }));
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

// Shared lease decision so both stores behave identically.
// A message is claimable when it has never been leased or its lease expired.
function isVisible(record, now) {
  return !record.lease_expires_at || Date.parse(record.lease_expires_at) <= now;
}

// Ack outcome shared by both stores. A lease_id is optional for compatibility,
// but when supplied it must match the current lease: that is what stops a
// consumer whose lease already expired from deleting work another consumer has
// since claimed.
function ackDecision(record, leaseId, now) {
  if (!record) {
    return { acked: false, reason: "not_found" };
  }
  if (leaseId && record.lease_id && leaseId !== record.lease_id) {
    return { acked: false, reason: "lease_mismatch" };
  }
  if (leaseId && !record.lease_id) {
    return { acked: false, reason: "lease_expired" };
  }
  if (leaseId && record.lease_expires_at && Date.parse(record.lease_expires_at) <= now) {
    return { acked: false, reason: "lease_expired" };
  }
  return { acked: true };
}

export function createMemoryRelayStore() {
  const queues = new Map();

  function getQueue(receiver) {
    if (!queues.has(receiver)) {
      queues.set(receiver, []);
    }
    return queues.get(receiver);
  }

  return {
    enqueue(receiver, envelope) {
      const queue = getQueue(receiver);
      const existing = queue.findIndex((item) => item.envelope.message_id === envelope.message_id);
      const record = { envelope, lease_id: null, lease_expires_at: null };
      if (existing >= 0) {
        queue[existing] = record;
      } else {
        queue.push(record);
      }
      return envelope;
    },
    poll(receiver, limit = 10, { visibilityTimeoutMs = DEFAULT_VISIBILITY_TIMEOUT_S * 1000, now = Date.now() } = {}) {
      const leaseId = newLeaseId();
      const leaseExpiresAt = nowIso(now + visibilityTimeoutMs);
      const claimed = [];
      for (const record of getQueue(receiver)) {
        if (claimed.length >= limit) {
          break;
        }
        if (!isVisible(record, now)) {
          continue;
        }
        record.lease_id = leaseId;
        record.lease_expires_at = leaseExpiresAt;
        claimed.push({ ...record.envelope, lease_id: leaseId, lease_expires_at: leaseExpiresAt });
      }
      return { items: claimed, lease_id: claimed.length > 0 ? leaseId : null, lease_expires_at: leaseExpiresAt };
    },
    ack(receiver, messageId, { leaseId = null, now = Date.now() } = {}) {
      const queue = getQueue(receiver);
      const index = queue.findIndex((item) => item.envelope.message_id === messageId);
      const decision = ackDecision(index >= 0 ? queue[index] : null, leaseId, now);
      if (decision.acked) {
        queue.splice(index, 1);
      }
      return decision;
    },
    peek(receiver, threadId = null, { now = Date.now() } = {}) {
      return getQueue(receiver)
        .filter((record) => !threadId || record.envelope.thread_id === threadId)
        .map((record) => ({
          ...record.envelope,
          lease_id: record.lease_id,
          lease_expires_at: record.lease_expires_at,
          visible: isVisible(record, now)
        }));
    },
    queueDepth(receiver, { now = Date.now() } = {}) {
      const queue = getQueue(receiver);
      return { total: queue.length, visible: queue.filter((record) => isVisible(record, now)).length };
    },
    close() {}
  };
}

export function createSqliteRelayStore(databasePath) {
  const resolvedPath = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new Database(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_messages (
      receiver TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_id TEXT,
      envelope_json TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      PRIMARY KEY (receiver, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_relay_messages_receiver_queued_at
      ON relay_messages (receiver, queued_at, message_id);
  `);

  // Lease columns are added in place so an existing relay volume keeps its
  // queued messages across the upgrade; sqlite has no ADD COLUMN IF NOT EXISTS.
  const columns = new Set(db.prepare(`PRAGMA table_info(relay_messages)`).all().map((row) => row.name));
  if (!columns.has("lease_id")) {
    db.exec(`ALTER TABLE relay_messages ADD COLUMN lease_id TEXT`);
  }
  if (!columns.has("lease_expires_at")) {
    db.exec(`ALTER TABLE relay_messages ADD COLUMN lease_expires_at TEXT`);
  }

  function rowToRecord(row) {
    return {
      envelope: JSON.parse(row.envelope_json),
      lease_id: row.lease_id || null,
      lease_expires_at: row.lease_expires_at || null
    };
  }

  return {
    enqueue(receiver, envelope) {
      db.prepare(
        `INSERT OR REPLACE INTO relay_messages
           (receiver, message_id, thread_id, envelope_json, queued_at, lease_id, lease_expires_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`
      ).run(
        receiver,
        envelope.message_id,
        envelope.thread_id || null,
        JSON.stringify(envelope),
        envelope.queued_at || nowIso()
      );
      return envelope;
    },
    poll(receiver, limit = 10, { visibilityTimeoutMs = DEFAULT_VISIBILITY_TIMEOUT_S * 1000, now = Date.now() } = {}) {
      const leaseId = newLeaseId();
      const leaseExpiresAt = nowIso(now + visibilityTimeoutMs);
      const nowStamp = nowIso(now);
      const claim = db.transaction(() => {
        const rows = db
          .prepare(
            `SELECT message_id, envelope_json FROM relay_messages
             WHERE receiver = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
             ORDER BY queued_at ASC, message_id ASC
             LIMIT ?`
          )
          .all(receiver, nowStamp, limit);
        const update = db.prepare(
          `UPDATE relay_messages SET lease_id = ?, lease_expires_at = ? WHERE receiver = ? AND message_id = ?`
        );
        for (const row of rows) {
          update.run(leaseId, leaseExpiresAt, receiver, row.message_id);
        }
        return rows;
      });
      const claimed = claim().map((row) => ({
        ...JSON.parse(row.envelope_json),
        lease_id: leaseId,
        lease_expires_at: leaseExpiresAt
      }));
      return { items: claimed, lease_id: claimed.length > 0 ? leaseId : null, lease_expires_at: leaseExpiresAt };
    },
    ack(receiver, messageId, { leaseId = null, now = Date.now() } = {}) {
      const row = db
        .prepare(`SELECT envelope_json, lease_id, lease_expires_at FROM relay_messages WHERE receiver = ? AND message_id = ?`)
        .get(receiver, messageId);
      const decision = ackDecision(row ? rowToRecord(row) : null, leaseId, now);
      if (decision.acked) {
        db.prepare(`DELETE FROM relay_messages WHERE receiver = ? AND message_id = ?`).run(receiver, messageId);
      }
      return decision;
    },
    peek(receiver, threadId = null, { now = Date.now() } = {}) {
      const sql = threadId
        ? `SELECT envelope_json, lease_id, lease_expires_at FROM relay_messages
           WHERE receiver = ? AND thread_id = ? ORDER BY queued_at ASC, message_id ASC`
        : `SELECT envelope_json, lease_id, lease_expires_at FROM relay_messages
           WHERE receiver = ? ORDER BY queued_at ASC, message_id ASC`;
      const rows = threadId ? db.prepare(sql).all(receiver, threadId) : db.prepare(sql).all(receiver);
      return rows.map((row) => {
        const record = rowToRecord(row);
        return {
          ...record.envelope,
          lease_id: record.lease_id,
          lease_expires_at: record.lease_expires_at,
          visible: isVisible(record, now)
        };
      });
    },
    queueDepth(receiver, { now = Date.now() } = {}) {
      const total = db.prepare(`SELECT COUNT(*) AS count FROM relay_messages WHERE receiver = ?`).get(receiver);
      const visible = db
        .prepare(
          `SELECT COUNT(*) AS count FROM relay_messages
           WHERE receiver = ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
        )
        .get(receiver, nowIso(now));
      return { total: total?.count || 0, visible: visible?.count || 0 };
    },
    close() {
      db.close();
    }
  };
}

export function createRelayServer({
  serviceName = "transport-relay",
  store = createMemoryRelayStore(),
  auth: authOptions = {},
  visibilityTimeoutSeconds = DEFAULT_VISIBILITY_TIMEOUT_S
} = {}) {
  const auth = createRelayAuth(authOptions);
  const visibilityTimeoutMs = Math.max(1, Number(visibilityTimeoutSeconds)) * 1000;

  // Reject before reading the body so an unauthenticated caller never gets to
  // push bytes through, and never learns whether a receiver exists.
  function authorize(req, res, { receiver = null, adminOnly = false } = {}) {
    const identity = auth.resolve(req);
    if (identity.error) {
      const message =
        identity.error === "expired" ? "receiver token has expired" : "a valid relay bearer token is required";
      sendError(res, 401, "RELAY_UNAUTHORIZED", message, { reason: identity.error });
      return null;
    }
    if (adminOnly && !auth.isAdmin(identity)) {
      sendError(res, 403, "RELAY_FORBIDDEN", "this operation requires the relay admin token");
      return null;
    }
    if (receiver && !auth.allowsReceiver(identity, receiver)) {
      sendError(res, 403, "RELAY_FORBIDDEN", "token is not scoped to this receiver");
      return null;
    }
    return identity;
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
          "access-control-allow-headers": "Content-Type, Authorization"
        });
        res.end();
        return;
      }

      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true, service: serviceName });
        return;
      }

      // Observed build facts for workspace drift checking (FR-082 / A-09).
      if (method === "GET" && pathname === "/buildz") {
        sendJson(res, 200, buildInfoPayload({ component: "transport-relay", version: RELAY_VERSION }));
        return;
      }

      if (method === "GET" && pathname === "/") {
        sendJson(res, 200, { service: serviceName, status: "running", auth_enforced: auth.enforced });
        return;
      }

      // Mint a receiver-scoped token. Admin only: handing out inbox access is
      // an operator action, never something a Provider can do for itself.
      const tokenMintMatch = pathname.match(/^\/v1\/receivers\/([^/]+)\/tokens$/);
      if (method === "POST" && tokenMintMatch) {
        if (!authorize(req, res, { adminOnly: true })) {
          return;
        }
        if (!auth.canMintTokens) {
          sendError(res, 409, "RELAY_TOKEN_SECRET_NOT_CONFIGURED", "relay has no token secret configured");
          return;
        }
        const receiver = decodeURIComponent(tokenMintMatch[1]);
        const body = await parseJsonBody(req);
        sendJson(res, 201, auth.issue(receiver, Number(body.ttl_seconds || 0)));
        return;
      }

      if (method === "POST" && pathname === "/v1/messages/send") {
        // Any authenticated party may send: a Responder must be able to deliver
        // results to the Caller's inbox. Forged results are still blocked by the
        // Ed25519 signature on the result package.
        if (!authorize(req, res)) {
          return;
        }
        const body = await parseJsonBody(req);
        if (!body.receiver || !body.envelope || !body.envelope.message_id) {
          sendError(res, 400, "CONTRACT_INVALID_SEND_REQUEST", "required fields are missing in send request");
          return;
        }
        const message = store.enqueue(body.receiver, {
          ...body.envelope,
          queued_at: body.envelope.queued_at || nowIso()
        });
        sendJson(res, 201, message);
        return;
      }

      if (method === "POST" && pathname === "/v1/messages/poll") {
        const body = await parseJsonBody(req);
        if (!body.receiver) {
          sendError(res, 400, "CONTRACT_INVALID_POLL_REQUEST", "receiver is required for poll");
          return;
        }
        if (!authorize(req, res, { receiver: body.receiver })) {
          return;
        }
        const claimed = store.poll(body.receiver, Number(body.limit || 10), { visibilityTimeoutMs });
        sendJson(res, 200, claimed);
        return;
      }

      if (method === "POST" && pathname === "/v1/messages/ack") {
        const body = await parseJsonBody(req);
        if (!body.receiver || !body.message_id) {
          sendError(res, 400, "CONTRACT_INVALID_ACK_REQUEST", "receiver and message_id are required for ack");
          return;
        }
        if (!authorize(req, res, { receiver: body.receiver })) {
          return;
        }
        const result = store.ack(body.receiver, body.message_id, { leaseId: body.lease_id || null });
        if (result.reason === "lease_mismatch" || result.reason === "lease_expired") {
          // The message now belongs to another consumer's lease; refusing keeps
          // ack idempotent without letting a stale worker delete live work.
          sendError(res, 409, "RELAY_LEASE_CONFLICT", "lease is no longer valid for this message", {
            retryable: false,
            reason: result.reason
          });
          return;
        }
        sendJson(res, 200, result);
        return;
      }

      if (method === "GET" && pathname === "/v1/messages/peek") {
        const receiver = url.searchParams.get("receiver");
        if (!receiver) {
          sendError(res, 400, "CONTRACT_INVALID_PEEK_REQUEST", "receiver is required for peek");
          return;
        }
        if (!authorize(req, res, { receiver })) {
          return;
        }
        sendJson(res, 200, {
          items: store.peek(receiver, url.searchParams.get("thread_id"))
        });
        return;
      }

      const healthMatch = pathname.match(/^\/v1\/receivers\/([^/]+)\/health$/);
      if (method === "GET" && healthMatch) {
        const receiver = decodeURIComponent(healthMatch[1]);
        if (!authorize(req, res, { receiver })) {
          return;
        }
        const depth = store.queueDepth(receiver);
        sendJson(res, 200, {
          ok: true,
          receiver,
          queue_depth: depth.total,
          visible_depth: depth.visible
        });
        return;
      }

      sendError(res, 404, "not_found", "no matching route", { path: pathname });
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_json") {
        sendError(res, 400, "CONTRACT_INVALID_JSON", "request body is not valid JSON");
        return;
      }
      sendError(res, 500, "RELAY_INTERNAL_ERROR", error instanceof Error ? error.message : "unknown_error", { retryable: true });
    }
  });
}

if (isDirectRun()) {
  const port = Number(process.env.PORT || 8090);
  const serviceName = process.env.SERVICE_NAME || "transport-relay";
  const sqlitePath = process.env.RELAY_SQLITE_PATH || null;
  const adminToken = process.env.RELAY_ADMIN_TOKEN || null;
  const tokenSecret = process.env.RELAY_TOKEN_SECRET || null;

  // Fail-safe: the deployable path refuses to serve an open relay. Relay
  // business routes carry task envelopes, so running them unauthenticated must
  // be a deliberate, explicit choice rather than the result of a missing value.
  if (!adminToken && !tokenSecret && process.env.RELAY_ALLOW_UNAUTHENTICATED !== "1") {
    console.error(
      `[${serviceName}] refusing to start without credentials: set RELAY_ADMIN_TOKEN and RELAY_TOKEN_SECRET, ` +
        `or set RELAY_ALLOW_UNAUTHENTICATED=1 to run an open relay on a trusted network`
    );
    process.exit(1);
  }
  if (!adminToken && !tokenSecret) {
    console.warn(`[${serviceName}] running WITHOUT authentication (RELAY_ALLOW_UNAUTHENTICATED=1)`);
  }

  const store = sqlitePath ? createSqliteRelayStore(sqlitePath) : createMemoryRelayStore();
  const server = createRelayServer({
    serviceName,
    store,
    auth: { adminToken, tokenSecret },
    visibilityTimeoutSeconds: Number(process.env.RELAY_VISIBILITY_TIMEOUT_S || DEFAULT_VISIBILITY_TIMEOUT_S)
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[${serviceName}] listening on ${port} auth=${adminToken || tokenSecret ? "required" : "disabled"}`);
  });
  server.on("close", () => {
    store.close();
  });
}
