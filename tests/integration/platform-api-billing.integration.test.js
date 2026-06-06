import { describe, expect, it } from "vitest";
import { newDb } from "pg-mem";

import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { createBillingStore } from "../../packages/billing-store/src/index.js";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

function createMemoryPool() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

async function createBillingTestStore() {
  const pool = createMemoryPool();
  const store = await createBillingStore({ pool });
  await store.migrate();
  return {
    store,
    close: () => pool.end()
  };
}

describe("platform-api billing admin integration", () => {
  it("exposes admin tenant, balance, recharge, and ledger read model", async () => {
    const billing = await createBillingTestStore();
    const state = createPlatformState({ billingStore: billing.store });
    const server = createPlatformServer({
      serviceName: "platform-api-billing-test",
      state
    });
    const baseUrl = await listenServer(server);

    try {
      const headers = { Authorization: `Bearer ${state.adminApiKey}` };
      const tenant = await jsonRequest(baseUrl, "/v1/admin/billing/tenants", {
        method: "POST",
        headers,
        body: { tenant_id: "tenant_admin_read_model" }
      });
      expect(tenant.status).toBe(201);
      expect(tenant.body.balance.credit_balance_cents).toBe(0);
      expect(tenant.body.balance.windows).toHaveLength(3);

      const recharge = await jsonRequest(baseUrl, "/v1/admin/billing/tenants/tenant_admin_read_model/recharges", {
        method: "POST",
        headers,
        body: {
          recharge_id: "rch_admin_read_model_1",
          amount_cents: 12500,
          currency: "PTS",
          provider: "manual",
          external_reference: "ops-console-adjustment-1"
        }
      });
      expect(recharge.status).toBe(201);
      expect(recharge.body.recharge.state).toBe("captured");
      expect(recharge.body.recharge.credit_balance_cents_after).toBe(12500);

      const balance = await jsonRequest(baseUrl, "/v1/admin/billing/tenants/tenant_admin_read_model/balance", {
        headers
      });
      expect(balance.status).toBe(200);
      expect(balance.body.balance.credit_balance_cents).toBe(12500);

      const ledger = await jsonRequest(
        baseUrl,
        "/v1/admin/billing/tenants/tenant_admin_read_model/ledger?limit=5&kind=recharge",
        { headers }
      );
      expect(ledger.status).toBe(200);
      expect(ledger.body.items).toHaveLength(1);
      expect(ledger.body.items[0]).toMatchObject({
        tenant_id: "tenant_admin_read_model",
        kind: "recharge",
        direction: "system",
        amount_cents: 12500,
        prev_balance_cents: 0,
        new_balance_cents: 12500
      });
      expect(ledger.body.next_cursor).toBe(null);
      expect(ledger.body.has_more).toBe(false);
    } finally {
      await closeServer(server);
      await billing.close();
    }
  });

  it("keeps billing admin routes behind operator auth and maps tenant misses", async () => {
    const billing = await createBillingTestStore();
    const state = createPlatformState({ billingStore: billing.store });
    const server = createPlatformServer({
      serviceName: "platform-api-billing-auth-test",
      state
    });
    const baseUrl = await listenServer(server);

    try {
      const unauthenticated = await jsonRequest(baseUrl, "/v1/admin/billing/tenants", {
        method: "POST",
        body: { tenant_id: "tenant_admin_denied" }
      });
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.body.error.code).toBe("AUTH_UNAUTHORIZED");

      const missingTenant = await jsonRequest(baseUrl, "/v1/admin/billing/tenants/missing_tenant/balance", {
        headers: { Authorization: `Bearer ${state.adminApiKey}` }
      });
      expect(missingTenant.status).toBe(404);
      expect(missingTenant.body.error).toMatchObject({
        code: "ERR_TENANT_NOT_FOUND",
        retryable: false
      });
    } finally {
      await closeServer(server);
      await billing.close();
    }
  });
});
