import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";

import {
  BillingCurrencyUnsupportedError,
  BillingInternalError,
  RechargeDuplicateKeyError,
  boundaryFor,
  createBillingStore
} from "../../packages/billing-store/src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLATFORM_ROOT = path.resolve(__dirname, "../..");

function createMemoryPool() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

async function createStore() {
  const pool = createMemoryPool();
  const store = await createBillingStore({ pool });
  await store.migrate();
  return store;
}

describe("billing-store unit", () => {
  const cleanup = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()();
    }
  });

  it("boundaryFor computes daily, monthly, and total UTC anchors", () => {
    const now = new Date("2026-05-06T10:31:45.123Z");

    expect(boundaryFor("daily", now).toISOString()).toBe("2026-05-06T00:00:00.000Z");
    expect(boundaryFor("monthly", now).toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(boundaryFor("total", now).toISOString()).toBe("2026-05-06T10:31:45.123Z");
  });

  it("createTenant initializes balance row plus daily monthly total windows idempotently", async () => {
    const store = await createStore();
    cleanup.push(() => store.close());

    const registeredAt = new Date("2026-05-06T10:31:45.123Z");
    await store.createTenant("tenant_setup", registeredAt);
    await store.createTenant("tenant_setup", registeredAt);

    const balance = await store.getBalance("tenant_setup", { nowUtc: registeredAt });
    expect(balance.credit_balance_cents).toBe(0);
    expect(balance.pending_credit_cents).toBe(0);
    expect(balance.windows).toEqual([
      {
        window_kind: "daily",
        window_started_at: "2026-05-06T00:00:00.000Z",
        max_amount_cents: null,
        used_as_caller_cents: 0,
        earned_as_responder_cents: 0,
        hard_block_on_exceed: false
      },
      {
        window_kind: "monthly",
        window_started_at: "2026-05-01T00:00:00.000Z",
        max_amount_cents: null,
        used_as_caller_cents: 0,
        earned_as_responder_cents: 0,
        hard_block_on_exceed: false
      },
      {
        window_kind: "total",
        window_started_at: "2026-05-06T10:31:45.123Z",
        max_amount_cents: null,
        used_as_caller_cents: 0,
        earned_as_responder_cents: 0,
        hard_block_on_exceed: false
      }
    ]);
  });

  it("migrate applies 002 on top of a database that already recorded 001 exactly once", async () => {
    const pool = createMemoryPool();
    cleanup.push(() => pool.end());

    const migrationsDir = path.resolve(PLATFORM_ROOT, "packages/postgres-store/migrations");
    const migration001 = await fs.readFile(path.join(migrationsDir, "001_l0_state_snapshots.sql"), "utf8");
    await pool.query(migration001);
    await pool.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)", [
      "001_l0_state_snapshots.sql",
      new Date("2026-05-06T00:00:00.000Z").toISOString()
    ]);

    const store = await createBillingStore({ pool, migrationsDir });
    await store.migrate();
    await store.migrate();

    const versions = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(versions.rows.map((row) => row.version)).toEqual([
      "001_l0_state_snapshots.sql",
      "002_p1_tenant_balance.sql"
    ]);
  });

  it("applyBalanceDelta happy path (recharge system kind) appends ledger and updates balance", async () => {
    const store = await createStore();
    cleanup.push(() => store.close());
    await store.createTenant("tenant_recharge", "2026-05-06T08:00:00.000Z");

    const result = await store.applyBalanceDelta({
      tenantId: "tenant_recharge",
      deltaCents: 10000,
      kind: "recharge",
      direction: "system",
      recordedAt: "2026-05-06T10:00:00.000Z",
      nowUtc: "2026-05-06T10:00:00.000Z"
    });

    expect(result.kind).toBe("recharge");
    expect(result.direction).toBe("system");
    expect(result.prev_balance_cents).toBe(0);
    expect(result.new_balance_cents).toBe(10000);
    expect(result.casAttempts).toBe(1);

    const balance = await store.getBalance("tenant_recharge", { nowUtc: "2026-05-06T10:00:00.000Z" });
    expect(balance.credit_balance_cents).toBe(10000);
    expect(balance.windows.every((window) => window.used_as_caller_cents === 0 && window.earned_as_responder_cents === 0)).toBe(true);
  });

  it("applyBalanceDelta throws BillingInternalError(would_break_invariant) when balance would go negative", async () => {
    const store = await createStore();
    cleanup.push(() => store.close());
    await store.createTenant("tenant_invariant", "2026-05-06T08:00:00.000Z");

    await expect(
      store.applyBalanceDelta({
        tenantId: "tenant_invariant",
        deltaCents: -1,
        kind: "admin_adjustment",
        direction: "system"
      })
    ).rejects.toMatchObject({
      code: "ERR_BILLING_INTERNAL",
      reason: "would_break_invariant"
    });
  });

  it("applyBalanceDelta retries once when the version column drifts before UPDATE", async () => {
    const pool = createMemoryPool();
    cleanup.push(() => pool.end());

    const store = await createBillingStore({
      pool,
      hooks: {
        beforeBalanceUpdate: async ({ attempt, pool: retryPool, tenantId }) => {
          if (attempt === 1) {
            await retryPool.query("UPDATE tenant_balance SET version = version + 1 WHERE tenant_id = $1", [tenantId]);
          }
        }
      }
    });
    await store.migrate();
    await store.createTenant("tenant_cas", "2026-05-06T08:00:00.000Z");

    const result = await store.applyBalanceDelta({
      tenantId: "tenant_cas",
      deltaCents: 25,
      kind: "admin_adjustment",
      direction: "system",
      recordedAt: "2026-05-06T10:00:00.000Z",
      nowUtc: "2026-05-06T10:00:00.000Z"
    });

    expect(result.casAttempts).toBe(2);
    expect(store.stats.applyBalanceDeltaRetries).toBe(1);
    const version = await pool.query("SELECT version FROM tenant_balance WHERE tenant_id = 'tenant_cas'");
    expect(Number(version.rows[0].version)).toBe(2);
  });

  it("ensureWindowFresh rolls daily across day boundary", async () => {
    const store = await createStore();
    cleanup.push(() => store.close());
    await store.createTenant("tenant_daily", "2026-05-05T23:59:00.000Z");
    await store.applyBalanceDelta({
      tenantId: "tenant_daily",
      deltaCents: 10,
      kind: "credit",
      direction: "responder_earn",
      nowUtc: "2026-05-05T23:59:30.000Z",
      recordedAt: "2026-05-05T23:59:30.000Z"
    });

    const rolled = await store.ensureWindowFresh({
      tenantId: "tenant_daily",
      kind: "daily",
      nowUtc: "2026-05-06T10:00:00.000Z"
    });

    expect(rolled.rolled).toBe(true);
    expect(rolled.window.window_started_at).toBe("2026-05-06T00:00:00.000Z");
    expect(rolled.window.earned_as_responder_cents).toBe(0);
  });

  it("ensureWindowFresh rolls monthly across month boundary", async () => {
    const store = await createStore();
    cleanup.push(() => store.close());
    await store.createTenant("tenant_monthly", "2026-04-30T23:59:00.000Z");
    await store.applyBalanceDelta({
      tenantId: "tenant_monthly",
      deltaCents: -5,
      kind: "admin_adjustment",
      direction: "caller_spend",
      nowUtc: "2026-04-30T23:59:30.000Z",
      recordedAt: "2026-04-30T23:59:30.000Z"
    }).catch(() => {});

    const client = await store.pool.connect();
    try {
      await client.query(
        "UPDATE tenant_quota_window SET used_as_caller_cents = 15 WHERE tenant_id = $1 AND window_kind = 'monthly'",
        ["tenant_monthly"]
      );
    } finally {
      client.release();
    }

    const rolled = await store.ensureWindowFresh({
      tenantId: "tenant_monthly",
      kind: "monthly",
      nowUtc: "2026-05-06T10:00:00.000Z"
    });

    expect(rolled.rolled).toBe(true);
    expect(rolled.window.window_started_at).toBe("2026-05-01T00:00:00.000Z");
    expect(rolled.window.used_as_caller_cents).toBe(0);
  });

  it("ensureWindowFresh never rolls total windows", async () => {
    const store = await createStore();
    cleanup.push(() => store.close());
    await store.createTenant("tenant_total", "2026-03-12T08:11:00.000Z");

    const rolled = await store.ensureWindowFresh({
      tenantId: "tenant_total",
      kind: "total",
      nowUtc: "2026-05-06T10:00:00.000Z"
    });

    expect(rolled.rolled).toBe(false);
    expect(rolled.window.window_started_at).toBe("2026-03-12T08:11:00.000Z");
  });

  it("createRecharge same recharge_id second submit returns prior captured result without double credit", async () => {
    const store = await createStore();
    cleanup.push(() => store.close());
    await store.createTenant("tenant_recharge_same", "2026-05-06T08:00:00.000Z");

    const first = await store.createRecharge({
      recharge_id: "rch_same_1",
      tenant_id: "tenant_recharge_same",
      amount_cents: 100,
      currency: "PTS"
    });
    const second = await store.createRecharge({
      recharge_id: "rch_same_1",
      tenant_id: "tenant_recharge_same",
      amount_cents: 100,
      currency: "PTS"
    });

    expect(first.httpStatus).toBe(201);
    expect(second.httpStatus).toBe(200);
    expect(second.captured_ledger_id).toBe(first.captured_ledger_id);
    const balance = await store.getBalance("tenant_recharge_same");
    expect(balance.credit_balance_cents).toBe(100);
  });

  it("createRecharge rejects duplicate key with mismatched amount or currency", async () => {
    const store = await createStore();
    cleanup.push(() => store.close());
    await store.createTenant("tenant_recharge_dup", "2026-05-06T08:00:00.000Z");
    await store.createRecharge({
      recharge_id: "rch_dup_1",
      tenant_id: "tenant_recharge_dup",
      amount_cents: 100,
      currency: "PTS"
    });

    await expect(
      store.createRecharge({
        recharge_id: "rch_dup_1",
        tenant_id: "tenant_recharge_dup",
        amount_cents: 101,
        currency: "PTS"
      })
    ).rejects.toBeInstanceOf(RechargeDuplicateKeyError);
  });

  it("createRecharge rejects non-PTS currency", async () => {
    const store = await createStore();
    cleanup.push(() => store.close());
    await store.createTenant("tenant_currency", "2026-05-06T08:00:00.000Z");

    await expect(
      store.createRecharge({
        recharge_id: "rch_currency_1",
        tenant_id: "tenant_currency",
        amount_cents: 100,
        currency: "USD"
      })
    ).rejects.toBeInstanceOf(BillingCurrencyUnsupportedError);
  });

  it("getLedger keyset pagination returns next_cursor for the next page", async () => {
    const store = await createStore();
    cleanup.push(() => store.close());
    await store.createTenant("tenant_ledger_paging", "2026-05-06T08:00:00.000Z");

    await store.applyBalanceDelta({
      tenantId: "tenant_ledger_paging",
      deltaCents: 10,
      kind: "recharge",
      direction: "system",
      recordedAt: "2026-05-06T10:00:01.000Z",
      nowUtc: "2026-05-06T10:00:01.000Z"
    });
    await store.applyBalanceDelta({
      tenantId: "tenant_ledger_paging",
      deltaCents: 20,
      kind: "admin_adjustment",
      direction: "system",
      recordedAt: "2026-05-06T10:00:02.000Z",
      nowUtc: "2026-05-06T10:00:02.000Z"
    });
    await store.applyBalanceDelta({
      tenantId: "tenant_ledger_paging",
      deltaCents: 30,
      kind: "recharge",
      direction: "system",
      recordedAt: "2026-05-06T10:00:03.000Z",
      nowUtc: "2026-05-06T10:00:03.000Z"
    });

    const firstPage = await store.getLedger("tenant_ledger_paging", { limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.has_more).toBe(true);
    expect(firstPage.next_cursor).toBeTruthy();

    const secondPage = await store.getLedger("tenant_ledger_paging", {
      limit: 2,
      cursor: firstPage.next_cursor
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0].recorded_at).toBe("2026-05-06T10:00:01.000Z");
    expect(secondPage.has_more).toBe(false);
  });

  it("getLedger repeated kind filter de-duplicates query kinds and returns only matching rows", async () => {
    const store = await createStore();
    cleanup.push(() => store.close());
    await store.createTenant("tenant_kind_filter", "2026-05-06T08:00:00.000Z");

    await store.applyBalanceDelta({
      tenantId: "tenant_kind_filter",
      deltaCents: 10,
      kind: "recharge",
      direction: "system",
      recordedAt: "2026-05-06T10:00:01.000Z",
      nowUtc: "2026-05-06T10:00:01.000Z"
    });
    await store.applyBalanceDelta({
      tenantId: "tenant_kind_filter",
      deltaCents: 20,
      kind: "admin_adjustment",
      direction: "system",
      recordedAt: "2026-05-06T10:00:02.000Z",
      nowUtc: "2026-05-06T10:00:02.000Z"
    });

    const ledger = await store.getLedger("tenant_kind_filter", {
      kind: ["recharge", "recharge", "credit"]
    });

    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0].kind).toBe("recharge");
  });
});
