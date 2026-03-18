import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildStructuredError } from "@delexec/contracts";
import { buildOpsEnvSearchPaths, loadEnvFiles } from "@delexec/runtime-utils";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../../..");

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

function nowIso() {
  return new Date().toISOString();
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

function createMemoryRelayStore() {
  const queues = new Map();

  function getQueue(receiver) {
    if (!queues.has(receiver)) {
      queues.set(receiver, []);
    }
    return queues.get(receiver);
  }

  return {
    enqueue(receiver, envelope) {
      getQueue(receiver).push(envelope);
      return envelope;
    },
    poll(receiver, limit = 10) {
      return getQueue(receiver).slice(0, limit);
    },
    ack(receiver, messageId) {
      const queue = getQueue(receiver);
      const index = queue.findIndex((item) => item.message_id === messageId);
      if (index >= 0) {
        queue.splice(index, 1);
        return true;
      }
      return false;
    },
    peek(receiver, threadId = null) {
      const queue = getQueue(receiver);
      return threadId ? queue.filter((item) => item.thread_id === threadId) : [...queue];
    },
    queueDepth(receiver) {
      return getQueue(receiver).length;
    },
    close() {}
  };
}

function createSqliteRelayStore(databasePath) {
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

  return {
    enqueue(receiver, envelope) {
      db.prepare(
        `INSERT OR REPLACE INTO relay_messages (receiver, message_id, thread_id, envelope_json, queued_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(receiver, envelope.message_id, envelope.thread_id || null, JSON.stringify(envelope), envelope.queued_at || nowIso());
      return envelope;
    },
    poll(receiver, limit = 10) {
      return db
        .prepare(
          `SELECT envelope_json FROM relay_messages
           WHERE receiver = ?
           ORDER BY queued_at ASC, message_id ASC
           LIMIT ?`
        )
        .all(receiver, limit)
        .map((row) => JSON.parse(row.envelope_json));
    },
    ack(receiver, messageId) {
      const result = db.prepare(`DELETE FROM relay_messages WHERE receiver = ? AND message_id = ?`).run(receiver, messageId);
      return result.changes > 0;
    },
    peek(receiver, threadId = null) {
      const sql = threadId
        ? `SELECT envelope_json FROM relay_messages WHERE receiver = ? AND thread_id = ? ORDER BY queued_at ASC, message_id ASC`
        : `SELECT envelope_json FROM relay_messages WHERE receiver = ? ORDER BY queued_at ASC, message_id ASC`;
      const rows = threadId ? db.prepare(sql).all(receiver, threadId) : db.prepare(sql).all(receiver);
      return rows.map((row) => JSON.parse(row.envelope_json));
    },
    queueDepth(receiver) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM relay_messages WHERE receiver = ?`).get(receiver);
      return row?.count || 0;
    },
    close() {
      db.close();
    }
  };
}

export function createRelayServer({ serviceName = "transport-relay", store = createMemoryRelayStore() } = {}) {
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

      if (method === "GET" && pathname === "/") {
        sendJson(res, 200, { service: serviceName, status: "running" });
        return;
      }

      if (method === "POST" && pathname === "/v1/messages/send") {
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
        sendJson(res, 200, {
          items: store.poll(body.receiver, Number(body.limit || 10))
        });
        return;
      }

      if (method === "POST" && pathname === "/v1/messages/ack") {
        const body = await parseJsonBody(req);
        if (!body.receiver || !body.message_id) {
          sendError(res, 400, "CONTRACT_INVALID_ACK_REQUEST", "receiver and message_id are required for ack");
          return;
        }
        sendJson(res, 200, { acked: store.ack(body.receiver, body.message_id) });
        return;
      }

      if (method === "GET" && pathname === "/v1/messages/peek") {
        const receiver = url.searchParams.get("receiver");
        if (!receiver) {
          sendError(res, 400, "CONTRACT_INVALID_PEEK_REQUEST", "thread_id is required for peek");
          return;
        }
        const threadId = url.searchParams.get("thread_id");
        sendJson(res, 200, {
          items: store.peek(receiver, threadId)
        });
        return;
      }

      const healthMatch = pathname.match(/^\/v1\/receivers\/([^/]+)\/health$/);
      if (method === "GET" && healthMatch) {
        const receiver = decodeURIComponent(healthMatch[1]);
        sendJson(res, 200, {
          ok: true,
          receiver,
          queue_depth: store.queueDepth(receiver)
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
  const store = sqlitePath ? createSqliteRelayStore(sqlitePath) : createMemoryRelayStore();
  const server = createRelayServer({ serviceName, store });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[${serviceName}] listening on ${port}`);
  });
  server.on("close", () => {
    store.close();
  });
}
