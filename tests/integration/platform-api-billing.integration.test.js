import { describe, expect, it } from "vitest";
import { newDb } from "pg-mem";

import { PRICING_MODEL, TRUST_TIER } from "@delexec/contracts";
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

function markBootstrapHotlinePaid(state, amountCents = 500) {
  const responder = state.bootstrap.responders[0];
  const item = state.catalog.get(responder.hotline_id);
  item.pricing_hint = {
    pricing_model: PRICING_MODEL.FIXED_PRICE,
    currency: "PTS",
    fixed_price_cents: amountCents,
    base_price_cents: null,
    variable_unit: null,
    variable_unit_description: null,
    variable_unit_price_cents: null,
    max_total_cents: amountCents,
    free_tier: null,
    billing_disclosure_url: "https://callanything.xyz/marketplace/responders/test",
    trust_tier: TRUST_TIER.UNTRUSTED
  };
  return responder;
}

async function registerCaller(baseUrl, email) {
  const caller = await jsonRequest(baseUrl, "/v1/users/register", {
    method: "POST",
    body: { contact_email: email }
  });
  expect(caller.status).toBe(201);
  return caller.body;
}

function billingConsent(amountCents = 500) {
  return {
    acknowledged: true,
    pricing_model: PRICING_MODEL.FIXED_PRICE,
    currency: "PTS",
    max_charge_cents: amountCents,
    consent_at: "2026-06-12T00:00:00.000Z",
    trust_tier_seen: TRUST_TIER.UNTRUSTED
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

describe("platform-api billing enforcement integration", () => {
  it("keeps token issuance unchanged when billing enforcement is disabled", async () => {
    const state = createPlatformState({ billingEnforcement: "disabled" });
    const responder = markBootstrapHotlinePaid(state);
    const server = createPlatformServer({
      serviceName: "platform-api-billing-disabled-test",
      state
    });
    const baseUrl = await listenServer(server);

    try {
      const caller = await registerCaller(baseUrl, "billing-disabled@test.local");
      const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
        method: "POST",
        headers: { Authorization: `Bearer ${caller.api_key}` },
        body: {
          request_id: "req_billing_disabled_paid_1",
          responder_id: responder.responder_id,
          hotline_id: responder.hotline_id
        }
      });
      expect(token.status).toBe(201);
      expect(token.body.claims.billing).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it("rejects enforced paid token issuance when prepaid balance is insufficient", async () => {
    const billing = await createBillingTestStore();
    const state = createPlatformState({ billingStore: billing.store, billingEnforcement: "enforced" });
    const responder = markBootstrapHotlinePaid(state);
    const server = createPlatformServer({
      serviceName: "platform-api-billing-insufficient-test",
      state
    });
    const baseUrl = await listenServer(server);

    try {
      const caller = await registerCaller(baseUrl, "billing-insufficient@test.local");
      await billing.store.createTenant(caller.user_id);

      const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
        method: "POST",
        headers: { Authorization: `Bearer ${caller.api_key}` },
        body: {
          request_id: "req_billing_insufficient_1",
          responder_id: responder.responder_id,
          hotline_id: responder.hotline_id,
          billing: billingConsent()
        }
      });
      expect(token.status).toBe(402);
      expect(token.body.error).toMatchObject({
        code: "ERR_PREPAID_BALANCE_INSUFFICIENT",
        retryable: true
      });

      const ledger = await billing.store.getLedger(caller.user_id);
      expect(ledger.items).toHaveLength(0);
    } finally {
      await closeServer(server);
      await billing.close();
    }
  });

  it("holds prepaid balance at enforced paid token issuance and settles on completion", async () => {
    const billing = await createBillingTestStore();
    const state = createPlatformState({ billingStore: billing.store, billingEnforcement: "enforced" });
    const responder = markBootstrapHotlinePaid(state);
    const server = createPlatformServer({
      serviceName: "platform-api-billing-success-test",
      state
    });
    const baseUrl = await listenServer(server);

    try {
      const caller = await registerCaller(baseUrl, "billing-success@test.local");
      await billing.store.createTenant(caller.user_id);
      await billing.store.createRecharge({
        recharge_id: "rch_billing_success_1",
        tenant_id: caller.user_id,
        amount_cents: 1000,
        currency: "PTS"
      });

      const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
        method: "POST",
        headers: { Authorization: `Bearer ${caller.api_key}` },
        body: {
          request_id: "req_billing_success_1",
          responder_id: responder.responder_id,
          hotline_id: responder.hotline_id,
          billing: billingConsent()
        }
      });
      expect(token.status).toBe(201);
      expect(token.body.claims.billing).toMatchObject({
        acknowledged: true,
        max_charge_cents: 500,
        pricing_model: PRICING_MODEL.FIXED_PRICE
      });

      const afterHold = await billing.store.getBalance(caller.user_id);
      expect(afterHold.credit_balance_cents).toBe(500);

      const responderAuth = { Authorization: `Bearer ${responder.api_key}` };
      const completed = await jsonRequest(baseUrl, "/v1/requests/req_billing_success_1/events", {
        method: "POST",
        headers: responderAuth,
        body: {
          responder_id: responder.responder_id,
          hotline_id: responder.hotline_id,
          event_type: "COMPLETED",
          status: "ok",
          usage: {
            pricing_model: PRICING_MODEL.FIXED_PRICE,
            total_cents: 500
          },
          finished_at: "2026-06-12T00:01:00.000Z"
        }
      });
      expect(completed.status).toBe(202);
      expect((await billing.store.getBalance(caller.user_id)).credit_balance_cents).toBe(500);

      const ledger = await billing.store.getLedger(caller.user_id, {
        kind: ["hold", "debit"]
      });
      expect(ledger.items.map((item) => item.kind).sort()).toEqual(["debit", "hold"]);
      expect(ledger.items.find((item) => item.kind === "hold")).toMatchObject({
        amount_cents: -500,
        request_id: "req_billing_success_1"
      });
      expect(ledger.items.find((item) => item.kind === "debit")).toMatchObject({
        amount_cents: 0,
        request_id: "req_billing_success_1"
      });
    } finally {
      await closeServer(server);
      await billing.close();
    }
  });

  it("refunds prepaid holds on enforced paid failed calls", async () => {
    const billing = await createBillingTestStore();
    const state = createPlatformState({ billingStore: billing.store, billingEnforcement: "enforced" });
    const responder = markBootstrapHotlinePaid(state);
    const server = createPlatformServer({
      serviceName: "platform-api-billing-refund-test",
      state
    });
    const baseUrl = await listenServer(server);

    try {
      const caller = await registerCaller(baseUrl, "billing-refund@test.local");
      await billing.store.createTenant(caller.user_id);
      await billing.store.createRecharge({
        recharge_id: "rch_billing_refund_1",
        tenant_id: caller.user_id,
        amount_cents: 500,
        currency: "PTS"
      });

      const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
        method: "POST",
        headers: { Authorization: `Bearer ${caller.api_key}` },
        body: {
          request_id: "req_billing_refund_1",
          responder_id: responder.responder_id,
          hotline_id: responder.hotline_id,
          billing: billingConsent()
        }
      });
      expect(token.status).toBe(201);
      expect((await billing.store.getBalance(caller.user_id)).credit_balance_cents).toBe(0);

      const failed = await jsonRequest(baseUrl, "/v1/requests/req_billing_refund_1/events", {
        method: "POST",
        headers: { Authorization: `Bearer ${responder.api_key}` },
        body: {
          responder_id: responder.responder_id,
          hotline_id: responder.hotline_id,
          event_type: "FAILED",
          status: "error",
          error_code: "EXEC_INTERNAL_ERROR",
          finished_at: "2026-06-12T00:02:00.000Z"
        }
      });
      expect(failed.status).toBe(202);
      expect((await billing.store.getBalance(caller.user_id)).credit_balance_cents).toBe(500);

      const ledger = await billing.store.getLedger(caller.user_id, {
        kind: ["hold", "refund"]
      });
      expect(ledger.items.map((item) => item.kind).sort()).toEqual(["hold", "refund"]);
      expect(ledger.items.find((item) => item.kind === "refund")).toMatchObject({
        amount_cents: 500,
        request_id: "req_billing_refund_1"
      });
    } finally {
      await closeServer(server);
      await billing.close();
    }
  });
});
