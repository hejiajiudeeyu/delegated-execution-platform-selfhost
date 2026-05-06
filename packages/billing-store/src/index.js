import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  BillingCurrencyUnsupportedError,
  BillingInternalError,
  QuotaExceededError,
  RechargeDuplicateKeyError,
  TenantNotFoundError
} from "./errors.js";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, "../../postgres-store/migrations");
const DEFAULT_RATE_LIMIT_PER_SECOND = 2;
const DEFAULT_CREDIT_MODE = "prepaid";
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const WINDOW_KINDS = ["daily", "monthly", "total"];
export const MAX_CAS_RETRIES = 5;

async function readMigrationFiles(migrationsDir) {
  const names = (await fs.readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({
      version: name,
      sql: await fs.readFile(path.join(migrationsDir, name), "utf8")
    }))
  );
}

function toDate(value) {
  if (value instanceof Date) {
    return new Date(value.toISOString());
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("invalid_utc_datetime");
  }
  return date;
}

function toIso(value) {
  return toDate(value).toISOString();
}

function toSafeInteger(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("unsafe_integer_value");
    }
    return value;
  }
  if (typeof value === "bigint") {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw new RangeError("unsafe_integer_value");
    }
    return number;
  }
  const number = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(number)) {
    throw new RangeError("unsafe_integer_value");
  }
  return number;
}

function encodeBase32(value, length) {
  let current = value;
  let output = "";
  while (output.length < length) {
    output = ULID_ALPHABET[Number(current % 32n)] + output;
    current /= 32n;
  }
  return output;
}

function createUlid(nowUtc = new Date()) {
  const timestamp = BigInt(toDate(nowUtc).getTime());
  const randomness = crypto.randomBytes(10);
  let randomValue = 0n;
  for (const byte of randomness) {
    randomValue = (randomValue << 8n) | BigInt(byte);
  }
  return `${encodeBase32(timestamp, 10)}${encodeBase32(randomValue, 16)}`;
}

function encodeCursor(recordedAt, ledgerId) {
  return Buffer.from(JSON.stringify([toIso(recordedAt), ledgerId]), "utf8").toString("base64");
}

function decodeCursor(cursor) {
  if (!cursor) {
    return null;
  }
  const [recordedAt, ledgerId] = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
  return {
    recordedAt: toIso(recordedAt),
    ledgerId
  };
}

function normalizeKinds(kind) {
  if (kind === undefined || kind === null) {
    return [];
  }
  const values = Array.isArray(kind) ? kind : [kind];
  return [...new Set(values.filter(Boolean))];
}

function normalizeLimit(limit) {
  const parsed = limit === undefined || limit === null ? 50 : Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new RangeError("ledger_limit_out_of_range");
  }
  return parsed;
}

function formatWindow(row) {
  return {
    window_kind: row.window_kind,
    window_started_at: toIso(row.window_started_at),
    max_amount_cents: row.max_amount_cents === null ? null : toSafeInteger(row.max_amount_cents),
    used_as_caller_cents: toSafeInteger(row.used_as_caller_cents),
    earned_as_responder_cents: toSafeInteger(row.earned_as_responder_cents),
    hard_block_on_exceed: row.hard_block_on_exceed
  };
}

function formatBalance(balanceRow, windowRows) {
  return {
    tenant_id: balanceRow.tenant_id,
    credit_balance_cents: toSafeInteger(balanceRow.credit_balance_cents),
    pending_credit_cents: toSafeInteger(balanceRow.pending_credit_cents),
    currency: balanceRow.currency,
    windows: windowRows.map(formatWindow),
    rate_limit_per_second: DEFAULT_RATE_LIMIT_PER_SECOND,
    credit_mode: DEFAULT_CREDIT_MODE
  };
}

function formatLedgerRow(row) {
  return {
    ledger_id: row.ledger_id,
    tenant_id: row.tenant_id,
    kind: row.kind,
    direction: row.direction,
    amount_cents: toSafeInteger(row.amount_cents),
    request_id: row.request_id,
    quote_id: row.quote_id,
    prev_balance_cents: toSafeInteger(row.prev_balance_cents),
    new_balance_cents: toSafeInteger(row.new_balance_cents),
    prev_pending_credit_cents: toSafeInteger(row.prev_pending_credit_cents),
    new_pending_credit_cents: toSafeInteger(row.new_pending_credit_cents),
    recorded_at: toIso(row.recorded_at)
  };
}

async function selectTenantBalance(client, tenantId) {
  const result = await client.query(
    "SELECT tenant_id, credit_balance_cents, pending_credit_cents, currency, version, created_at, updated_at FROM tenant_balance WHERE tenant_id = $1",
    [tenantId]
  );
  if (result.rowCount === 0) {
    throw new TenantNotFoundError(tenantId);
  }
  return result.rows[0];
}

async function selectQuotaWindows(client, tenantId) {
  const result = await client.query(
    `SELECT tenant_id, window_kind, window_started_at, max_amount_cents,
            used_as_caller_cents, earned_as_responder_cents, hard_block_on_exceed,
            created_at, updated_at
       FROM tenant_quota_window
      WHERE tenant_id = $1
   ORDER BY CASE window_kind
              WHEN 'daily' THEN 1
              WHEN 'monthly' THEN 2
              WHEN 'total' THEN 3
            END`,
    [tenantId]
  );
  if (result.rowCount !== WINDOW_KINDS.length) {
    throw new BillingInternalError("quota_window_missing");
  }
  return result.rows;
}

function boundaryFor(kind, nowUtc) {
  const date = toDate(nowUtc);
  if (kind === "daily") {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
  }
  if (kind === "monthly") {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
  }
  if (kind === "total") {
    return date;
  }
  throw new TypeError(`unknown_window_kind:${kind}`);
}

function normalizeEnsureArgs(args) {
  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null && !(args[0] instanceof Date)) {
    return {
      tx: args[0].tx ?? null,
      tenantId: args[0].tenantId ?? args[0].tenant_id,
      kind: args[0].kind,
      nowUtc: args[0].nowUtc ?? args[0].now_utc ?? new Date()
    };
  }
  return {
    tx: args[0] ?? null,
    tenantId: args[1],
    kind: args[2],
    nowUtc: args[3] ?? new Date()
  };
}

function normalizeApplyArgs(args) {
  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null && !Array.isArray(args[0])) {
    return {
      tx: args[0].tx ?? null,
      tenantId: args[0].tenantId ?? args[0].tenant_id,
      deltaCents: args[0].deltaCents ?? args[0].delta_cents,
      kind: args[0].kind,
      direction: args[0].direction,
      requestId: args[0].requestId ?? args[0].request_id ?? null,
      quoteId: args[0].quoteId ?? args[0].quote_id ?? null,
      pendingDeltaCents: args[0].pendingDeltaCents ?? args[0].pending_delta_cents ?? 0,
      nowUtc: args[0].nowUtc ?? args[0].now_utc ?? new Date(),
      recordedAt: args[0].recordedAt ?? args[0].recorded_at ?? args[0].nowUtc ?? args[0].now_utc ?? new Date()
    };
  }
  return {
    tx: args[0] ?? null,
    tenantId: args[1],
    deltaCents: args[2],
    kind: args[3],
    direction: args[4],
    requestId: args[5] ?? null,
    quoteId: args[6] ?? null,
    pendingDeltaCents: args[7] ?? 0,
    nowUtc: args[8] ?? new Date(),
    recordedAt: args[9] ?? args[8] ?? new Date()
  };
}

export async function createBillingStore({
  connectionString = null,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  pool = null,
  maxCasRetries = MAX_CAS_RETRIES,
  hooks = {}
} = {}) {
  const ownsPool = !pool;
  const clientPool = pool || new Pool({ connectionString });
  const stats = {
    applyBalanceDeltaCalls: 0,
    applyBalanceDeltaRetries: 0,
    lastCasAttempts: 0
  };

  async function query(text, params = []) {
    return clientPool.query(text, params);
  }

  async function withClient(tx, work) {
    if (tx) {
      return work(tx);
    }
    const client = await clientPool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function migrate() {
    const migrations = await readMigrationFiles(migrationsDir);
    await query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT, applied_at TEXT)");

    for (const migration of migrations) {
      const existing = await query("SELECT version FROM schema_migrations WHERE version = $1", [migration.version]);
      if (existing.rowCount > 0) {
        continue;
      }

      const client = await clientPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)", [
          migration.version,
          new Date().toISOString()
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async function createTenant(tenantId, registeredAt = new Date()) {
    const registeredDate = toDate(registeredAt);
    return withClient(null, async (client) => {
      await client.query(
        `INSERT INTO tenant_balance (tenant_id, created_at, updated_at)
         VALUES ($1, $2, $2)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenantId, registeredDate]
      );

      for (const kind of WINDOW_KINDS) {
        const windowStartedAt = kind === "total" ? registeredDate : boundaryFor(kind, registeredDate);
        await client.query(
          `INSERT INTO tenant_quota_window (
             tenant_id, window_kind, window_started_at, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (tenant_id, window_kind) DO NOTHING`,
          [tenantId, kind, windowStartedAt, registeredDate]
        );
      }

      const balanceRow = await selectTenantBalance(client, tenantId);
      const windowRows = await selectQuotaWindows(client, tenantId);
      return formatBalance(balanceRow, windowRows);
    });
  }

  async function ensureWindowFresh(...args) {
    const { tx, tenantId, kind, nowUtc } = normalizeEnsureArgs(args);
    const nowDate = toDate(nowUtc);

    return withClient(tx, async (client) => {
      await selectTenantBalance(client, tenantId);
      const result = await client.query(
        `SELECT tenant_id, window_kind, window_started_at, max_amount_cents,
                used_as_caller_cents, earned_as_responder_cents, hard_block_on_exceed,
                created_at, updated_at
           FROM tenant_quota_window
          WHERE tenant_id = $1 AND window_kind = $2
          FOR UPDATE`,
        [tenantId, kind]
      );
      if (result.rowCount === 0) {
        throw new BillingInternalError("quota_window_missing");
      }

      const current = result.rows[0];
      if (kind === "total") {
        return { rolled: false, window: formatWindow(current) };
      }

      const expectedStartedAt = boundaryFor(kind, nowDate);
      if (toDate(current.window_started_at) < expectedStartedAt) {
        await client.query(
          `UPDATE tenant_quota_window
              SET window_started_at = $1,
                  used_as_caller_cents = 0,
                  earned_as_responder_cents = 0,
                  updated_at = now()
            WHERE tenant_id = $2 AND window_kind = $3`,
          [expectedStartedAt, tenantId, kind]
        );
        const refreshed = await client.query(
          `SELECT tenant_id, window_kind, window_started_at, max_amount_cents,
                  used_as_caller_cents, earned_as_responder_cents, hard_block_on_exceed,
                  created_at, updated_at
             FROM tenant_quota_window
            WHERE tenant_id = $1 AND window_kind = $2`,
          [tenantId, kind]
        );
        return { rolled: true, window: formatWindow(refreshed.rows[0]) };
      }

      return { rolled: false, window: formatWindow(current) };
    });
  }

  async function accumulateWindow(client, tenantId, windowKind, deltaCents, direction) {
    if (direction === "system") {
      return;
    }
    if (direction === "caller_spend") {
      const amount = Math.abs(deltaCents);
      await client.query(
        `UPDATE tenant_quota_window
            SET used_as_caller_cents = used_as_caller_cents + $1,
                updated_at = now()
          WHERE tenant_id = $2 AND window_kind = $3`,
        [amount, tenantId, windowKind]
      );
      return;
    }
    if (direction === "responder_earn") {
      await client.query(
        `UPDATE tenant_quota_window
            SET earned_as_responder_cents = earned_as_responder_cents + $1,
                updated_at = now()
          WHERE tenant_id = $2 AND window_kind = $3`,
        [Math.abs(deltaCents), tenantId, windowKind]
      );
      return;
    }
    throw new BillingInternalError("unknown_ledger_direction");
  }

  async function applyBalanceDelta(...args) {
    const {
      tx,
      tenantId,
      deltaCents,
      kind,
      direction,
      requestId,
      quoteId,
      pendingDeltaCents,
      nowUtc,
      recordedAt
    } = normalizeApplyArgs(args);
    const delta = toSafeInteger(deltaCents);
    const pendingDelta = toSafeInteger(pendingDeltaCents);
    const nowDate = toDate(nowUtc);
    const recordedDate = toDate(recordedAt);

    return withClient(tx, async (client) => {
      for (let attempt = 1; attempt <= maxCasRetries; attempt += 1) {
        const selected = await client.query(
          `SELECT tenant_id, credit_balance_cents, pending_credit_cents, currency, version, created_at, updated_at
             FROM tenant_balance
            WHERE tenant_id = $1
            FOR UPDATE`,
          [tenantId]
        );
        if (selected.rowCount === 0) {
          throw new TenantNotFoundError(tenantId);
        }
        const row = selected.rows[0];
        const prevBalance = toSafeInteger(row.credit_balance_cents);
        const prevPending = toSafeInteger(row.pending_credit_cents);
        const version = toSafeInteger(row.version);
        const newBalance = prevBalance + delta;
        const newPending = prevPending + pendingDelta;

        if (newBalance < 0 || newPending < 0) {
          throw new BillingInternalError("would_break_invariant");
        }

        if (typeof hooks.beforeBalanceUpdate === "function") {
          await hooks.beforeBalanceUpdate({
            attempt,
            tenantId,
            version,
            row,
            client,
            pool: clientPool
          });
        }

        const update = await client.query(
          `UPDATE tenant_balance
              SET credit_balance_cents = $1,
                  pending_credit_cents = $2,
                  version = version + 1,
                  updated_at = now()
            WHERE tenant_id = $3 AND version = $4`,
          [newBalance, newPending, tenantId, version]
        );

        if (update.rowCount === 0) {
          stats.applyBalanceDeltaRetries += 1;
          if (attempt === maxCasRetries) {
            throw new BillingInternalError("cas_exhausted");
          }
          continue;
        }

        for (const windowKind of WINDOW_KINDS) {
          await ensureWindowFresh({ tx: client, tenantId, kind: windowKind, nowUtc: nowDate });
          await accumulateWindow(client, tenantId, windowKind, delta, direction);
        }

        const ledgerId = createUlid(recordedDate);
        await client.query(
          `INSERT INTO tenant_balance_ledger (
             ledger_id, tenant_id, kind, direction, amount_cents, request_id, quote_id,
             prev_balance_cents, new_balance_cents,
             prev_pending_credit_cents, new_pending_credit_cents, recorded_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9,
             $10, $11, $12
           )`,
          [
            ledgerId,
            tenantId,
            kind,
            direction,
            delta,
            requestId,
            quoteId,
            prevBalance,
            newBalance,
            prevPending,
            newPending,
            recordedDate
          ]
        );

        stats.applyBalanceDeltaCalls += 1;
        stats.lastCasAttempts = attempt;

        return {
          ledger_id: ledgerId,
          tenant_id: tenantId,
          kind,
          direction,
          amount_cents: delta,
          request_id: requestId,
          quote_id: quoteId,
          prev_balance_cents: prevBalance,
          new_balance_cents: newBalance,
          prev_pending_credit_cents: prevPending,
          new_pending_credit_cents: newPending,
          recorded_at: recordedDate.toISOString(),
          casAttempts: attempt
        };
      }

      throw new BillingInternalError("cas_exhausted");
    });
  }

  async function getBalance(tenantId, { nowUtc = new Date(), tx = null } = {}) {
    const nowDate = toDate(nowUtc);
    return withClient(tx, async (client) => {
      for (const kind of WINDOW_KINDS) {
        await ensureWindowFresh({ tx: client, tenantId, kind, nowUtc: nowDate });
      }
      const balanceRow = await selectTenantBalance(client, tenantId);
      const windowRows = await selectQuotaWindows(client, tenantId);
      return formatBalance(balanceRow, windowRows);
    });
  }

  async function getLedger(tenantId, opts = {}) {
    const limit = normalizeLimit(opts.limit);
    const cursor = decodeCursor(opts.cursor);
    const kinds = normalizeKinds(opts.kind ?? opts.kinds);
    const since = opts.since ? toIso(opts.since) : null;

    return withClient(null, async (client) => {
      await selectTenantBalance(client, tenantId);

      const where = ["tenant_id = $1"];
      const params = [tenantId];

      if (since) {
        params.push(since);
        where.push(`recorded_at >= $${params.length}`);
      }

      if (kinds.length > 0) {
        const placeholders = kinds.map((value) => {
          params.push(value);
          return `$${params.length}`;
        });
        where.push(`kind IN (${placeholders.join(", ")})`);
      }

      if (cursor) {
        params.push(cursor.recordedAt, cursor.ledgerId);
        where.push(`(recorded_at < $${params.length - 1} OR (recorded_at = $${params.length - 1} AND ledger_id < $${params.length}))`);
      }

      params.push(limit + 1);
      const sql = `SELECT ledger_id, tenant_id, kind, direction, amount_cents, request_id, quote_id,
                          prev_balance_cents, new_balance_cents,
                          prev_pending_credit_cents, new_pending_credit_cents, recorded_at
                     FROM tenant_balance_ledger
                    WHERE ${where.join(" AND ")}
                 ORDER BY recorded_at DESC, ledger_id DESC
                    LIMIT $${params.length}`;
      const result = await client.query(sql, params);
      const rows = result.rows.slice(0, limit).map(formatLedgerRow);
      const hasMore = result.rows.length > limit;
      const last = rows.at(-1);
      return {
        items: rows,
        next_cursor: hasMore && last ? encodeCursor(last.recorded_at, last.ledger_id) : null,
        has_more: hasMore
      };
    });
  }

  async function createRecharge({
    recharge_id,
    tenant_id,
    amount_cents,
    currency = "PTS",
    provider = null,
    external_reference = null,
    recorded_at = new Date()
  }) {
    const amount = toSafeInteger(amount_cents);
    if (amount <= 0) {
      throw new RangeError("recharge_amount_must_be_positive");
    }
    if (currency !== "PTS") {
      throw new BillingCurrencyUnsupportedError(currency);
    }

    return withClient(null, async (client) => {
      const existing = await client.query(
        `SELECT recharge_id, tenant_id, amount_cents, currency, state, captured_ledger_id
           FROM tenant_recharge_request
          WHERE recharge_id = $1`,
        [recharge_id]
      );

      if (existing.rowCount > 0) {
        const row = existing.rows[0];
        if (
          toSafeInteger(row.amount_cents) !== amount ||
          row.currency !== currency ||
          row.tenant_id !== tenant_id
        ) {
          throw new RechargeDuplicateKeyError(recharge_id);
        }
        const balance = await selectTenantBalance(client, tenant_id);
        return {
          recharge_id,
          state: row.state,
          credit_balance_cents_after: toSafeInteger(balance.credit_balance_cents),
          captured_ledger_id: row.captured_ledger_id,
          httpStatus: 200,
          duplicate: true
        };
      }

      await selectTenantBalance(client, tenant_id);
      const ledger = await applyBalanceDelta({
        tx: client,
        tenantId: tenant_id,
        deltaCents: amount,
        kind: "recharge",
        direction: "system",
        nowUtc: recorded_at,
        recordedAt: recorded_at
      });

      await client.query(
        `INSERT INTO tenant_recharge_request (
           recharge_id, tenant_id, amount_cents, currency, state,
           captured_ledger_id, provider, external_reference, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'captured', $5, $6, $7, $8, $8)`,
        [recharge_id, tenant_id, amount, currency, ledger.ledger_id, provider, external_reference, toDate(recorded_at)]
      );

      return {
        recharge_id,
        state: "captured",
        credit_balance_cents_after: ledger.new_balance_cents,
        captured_ledger_id: ledger.ledger_id,
        httpStatus: 201,
        duplicate: false,
        casAttempts: ledger.casAttempts
      };
    });
  }

  async function close() {
    if (ownsPool) {
      await clientPool.end();
    }
  }

  return {
    migrate,
    createTenant,
    getBalance,
    getLedger,
    applyBalanceDelta,
    ensureWindowFresh,
    createRecharge,
    close,
    pool: clientPool,
    stats
  };
}

export {
  BillingCurrencyUnsupportedError,
  BillingInternalError,
  QuotaExceededError,
  RechargeDuplicateKeyError,
  TenantNotFoundError,
  boundaryFor
};
