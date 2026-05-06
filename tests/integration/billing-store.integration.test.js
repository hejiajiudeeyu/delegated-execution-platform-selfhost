import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { createBillingStore } from "../../packages/billing-store/src/index.js";

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ||
  process.env.BILLING_TEST_DATABASE_URL ||
  "postgresql://croc:croc@127.0.0.1:5432/croc";

async function hasDatabase(url) {
  const probe = new Pool({ connectionString: url });
  try {
    await probe.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}

describe("billing-store integration (postgres)", async () => {
  const available = await hasDatabase(DATABASE_URL);
  let pool;
  let store;
  let schemaName;

  beforeAll(async () => {
    if (!available) {
      return;
    }
    schemaName = `billing_store_it_${Date.now()}`;
    const adminPool = new Pool({ connectionString: DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    await adminPool.end();
    pool = new Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${schemaName},public`
    });
    store = await createBillingStore({ pool });
    await store.migrate();
  });

  afterAll(async () => {
    if (!available) {
      return;
    }
    try {
      await pool.end();
      const adminPool = new Pool({ connectionString: DATABASE_URL });
      try {
        await adminPool.query(`DROP SCHEMA ${schemaName} CASCADE`);
      } finally {
        await adminPool.end();
      }
    } finally {
    }
  });

  it.skipIf(!available)("applies migration 002 in postgres and skips already-applied versions on rerun", async () => {
    const first = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(first.rows.map((row) => row.version)).toEqual([
      "001_l0_state_snapshots.sql",
      "002_p1_tenant_balance.sql"
    ]);

    await store.migrate();

    const second = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(second.rows.map((row) => row.version)).toEqual([
      "001_l0_state_snapshots.sql",
      "002_p1_tenant_balance.sql"
    ]);
  });

  it.skipIf(!available)("persists tenant, recharge, and ledger rows in real postgres", async () => {
    await store.createTenant("tenant_pg", "2026-05-06T08:00:00.000Z");

    const first = await store.createRecharge({
      recharge_id: "rch_pg_1",
      tenant_id: "tenant_pg",
      amount_cents: 120,
      currency: "PTS"
    });
    const second = await store.createRecharge({
      recharge_id: "rch_pg_1",
      tenant_id: "tenant_pg",
      amount_cents: 120,
      currency: "PTS"
    });

    expect(first.httpStatus).toBe(201);
    expect(second.httpStatus).toBe(200);

    const balance = await store.getBalance("tenant_pg");
    expect(balance.credit_balance_cents).toBe(120);

    const ledger = await store.getLedger("tenant_pg", { limit: 10 });
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]).toMatchObject({
      kind: "recharge",
      direction: "system",
      amount_cents: 120,
      new_balance_cents: 120
    });
  });
});
