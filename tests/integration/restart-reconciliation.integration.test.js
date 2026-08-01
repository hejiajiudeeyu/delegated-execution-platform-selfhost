// Restart reconciliation (A-03, PRD Flow E, FR-035, NFR-R02).
//
// A responder process that dies mid-execution leaves a call whose outcome
// nobody observed. The reconciliation endpoint is how that call reaches a
// terminal state — and the invariant under test throughout is that unknown
// work can only ever cost the caller nothing. A reconciliation may refund. It
// may never settle, and it may never claim a delivery it cannot prove.
import crypto from "node:crypto";

import { describe, expect, it } from "vitest";
import { newDb } from "pg-mem";

import { PRICING_MODEL, TRUST_TIER } from "@delexec/contracts";
import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { createBillingStore } from "../../packages/billing-store/src/index.js";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

async function createBillingTestStore() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const store = await createBillingStore({ pool });
  await store.migrate();
  return { store, close: () => pool.end() };
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

function billingConsent(amountCents = 500) {
  return {
    acknowledged: true,
    pricing_model: PRICING_MODEL.FIXED_PRICE,
    currency: "PTS",
    max_charge_cents: amountCents,
    consent_at: "2026-08-01T00:00:00.000Z",
    trust_tier_seen: TRUST_TIER.UNTRUSTED
  };
}

// Deliberately re-derived here rather than imported from the server: a test
// that signs with the implementation's own canonicalizer would pass even if
// both sides drifted away from what the responder actually sends.
function signReport(report, privateKey) {
  const ordered = {};
  for (const key of Object.keys(report).sort()) {
    if (report[key] !== undefined) {
      ordered[key] = report[key];
    }
  }
  return {
    report: ordered,
    signature: {
      signature_algorithm: "Ed25519",
      signer_public_key_pem: crypto
        .createPublicKey(privateKey)
        .export({ type: "spki", format: "pem" })
        .toString(),
      signature_base64: crypto
        .sign(null, Buffer.from(JSON.stringify(ordered), "utf8"), privateKey)
        .toString("base64")
    }
  };
}

function reportFor(requestId, overrides = {}) {
  return {
    call_id: requestId,
    attempt_id: "attempt_interrupted_1",
    boot_id: "boot_that_died",
    observed_execution: "failed",
    reconciled_by_boot_id: "boot_that_came_back",
    reconciled_at: "2026-08-01T00:05:00.000Z",
    reason: "interrupted_attempt_outcome_unobserved",
    recoverability: "non_recoverable",
    ...overrides
  };
}

/**
 * A paid, held call bound to a responder whose signing key the platform knows
 * — i.e. the state a device is in at the instant it loses power mid-execution.
 */
async function setupHeldCall(serviceName, requestId, options = {}) {
  const billing = await createBillingTestStore();
  const state = createPlatformState({
    billingStore: billing.store,
    billingEnforcement: "enforced",
    bootstrapEnabled: true
  });
  const responder = markBootstrapHotlinePaid(state);
  const server = createPlatformServer({ serviceName, state });
  const baseUrl = await listenServer(server);

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const responderRecord = state.responders.get(responder.responder_id);
  responderRecord.responder_public_key_pem = publicKeyPem;
  responderRecord.responder_public_keys_pem = [publicKeyPem];

  const caller = await jsonRequest(baseUrl, "/v1/users/register", {
    method: "POST",
    body: { contact_email: `${requestId}@test.local` }
  });
  expect(caller.status).toBe(201);
  await billing.store.createTenant(caller.body.user_id);
  await billing.store.createRecharge({
    recharge_id: `rch_${requestId}`,
    tenant_id: caller.body.user_id,
    amount_cents: 500,
    currency: "PTS"
  });

  const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
    method: "POST",
    headers: { Authorization: `Bearer ${caller.body.api_key}` },
    body: {
      request_id: requestId,
      responder_id: responder.responder_id,
      hotline_id: responder.hotline_id,
      billing: billingConsent()
    }
  });
  expect(token.status).toBe(201);
  // The hold is real: the caller's balance is already spent-in-escrow.
  expect((await billing.store.getBalance(caller.body.user_id)).credit_balance_cents).toBe(0);

  if (options.ack !== false) {
    await jsonRequest(baseUrl, `/v1/requests/${requestId}/ack`, {
      method: "POST",
      headers: { Authorization: `Bearer ${responder.api_key}` },
      body: { responder_id: responder.responder_id, hotline_id: responder.hotline_id }
    });
  }

  return {
    state,
    baseUrl,
    billing,
    caller: caller.body,
    responder,
    privateKey,
    publicKeyPem,
    responderHeaders: { Authorization: `Bearer ${responder.api_key}` },
    balance: () => billing.store.getBalance(caller.body.user_id).then((b) => b.credit_balance_cents),
    ledgerKinds: async () => {
      const ledger = await billing.store.getLedger(caller.body.user_id, { kind: ["hold", "refund", "debit"] });
      return ledger.items.map((item) => item.kind).sort();
    },
    teardown: async () => {
      await closeServer(server);
      await billing.close();
    }
  };
}

describe("restart reconciliation", () => {
  it("refunds an interrupted call and never settles it", async () => {
    const ctx = await setupHeldCall("reconcile-refund-test", "req_reconcile_refund");
    try {
      const response = await jsonRequest(ctx.baseUrl, "/v1/requests/req_reconcile_refund/reconcile", {
        method: "POST",
        headers: ctx.responderHeaders,
        body: signReport(reportFor("req_reconcile_refund"), ctx.privateKey)
      });

      expect(response.status).toBe(202);
      expect(response.body.accepted).toBe(true);
      expect(response.body.billing_state).toBe("refunded");

      // The caller is whole again, and no debit was ever recorded: work whose
      // outcome nobody saw is not work anyone pays for.
      expect(await ctx.balance()).toBe(500);
      expect(await ctx.ledgerKinds()).toEqual(["hold", "refund"]);

      const request = ctx.state.requests.get("req_reconcile_refund");
      expect(request.billing.state).toBe("refunded");
      expect(request.billing.settled_at).toBeFalsy();

      const reconciled = request.events.find((event) => event.event_type === "RECONCILED");
      expect(reconciled).toMatchObject({
        attempt_id: "attempt_interrupted_1",
        boot_id: "boot_that_died",
        reconciled_by_boot_id: "boot_that_came_back",
        observed_execution: "failed",
        recoverability: "non_recoverable"
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("refuses a report that claims the work was delivered", async () => {
    // The one attack this endpoint has to survive: talking an unobserved
    // attempt into a settlement without producing a signed result package.
    const ctx = await setupHeldCall("reconcile-delivered-test", "req_reconcile_delivered");
    try {
      const response = await jsonRequest(ctx.baseUrl, "/v1/requests/req_reconcile_delivered/reconcile", {
        method: "POST",
        headers: ctx.responderHeaders,
        body: signReport(reportFor("req_reconcile_delivered", { observed_execution: "delivered" }), ctx.privateKey)
      });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("RECONCILIATION_CANNOT_CLAIM_DELIVERY");

      // Nothing moved: still held, still no debit.
      expect(await ctx.balance()).toBe(0);
      expect(await ctx.ledgerKinds()).toEqual(["hold"]);
      expect(ctx.state.requests.get("req_reconcile_delivered").billing.state).toBe("held");
    } finally {
      await ctx.teardown();
    }
  });

  it("refuses a report signed by a key the responder never registered", async () => {
    const ctx = await setupHeldCall("reconcile-badsig-test", "req_reconcile_badsig");
    try {
      const impostor = crypto.generateKeyPairSync("ed25519").privateKey;
      const response = await jsonRequest(ctx.baseUrl, "/v1/requests/req_reconcile_badsig/reconcile", {
        method: "POST",
        headers: ctx.responderHeaders,
        body: signReport(reportFor("req_reconcile_badsig"), impostor)
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("RECONCILIATION_SIGNATURE_INVALID");
      expect(ctx.state.requests.get("req_reconcile_badsig").billing.state).toBe("held");
    } finally {
      await ctx.teardown();
    }
  });

  it("refuses a report whose body was altered after signing", async () => {
    const ctx = await setupHeldCall("reconcile-tamper-test", "req_reconcile_tamper");
    try {
      const envelope = signReport(reportFor("req_reconcile_tamper"), ctx.privateKey);
      envelope.report.reason = "actually_it_finished_fine";

      const response = await jsonRequest(ctx.baseUrl, "/v1/requests/req_reconcile_tamper/reconcile", {
        method: "POST",
        headers: ctx.responderHeaders,
        body: envelope
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("RECONCILIATION_SIGNATURE_INVALID");
      expect(await ctx.balance()).toBe(0);
    } finally {
      await ctx.teardown();
    }
  });

  it("refuses a report about a different call than the one addressed", async () => {
    const ctx = await setupHeldCall("reconcile-mismatch-test", "req_reconcile_mismatch");
    try {
      const response = await jsonRequest(ctx.baseUrl, "/v1/requests/req_reconcile_mismatch/reconcile", {
        method: "POST",
        headers: ctx.responderHeaders,
        body: signReport(reportFor("req_some_other_call"), ctx.privateKey)
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("CONTRACT_INVALID_RECONCILIATION");
      expect(ctx.state.requests.get("req_reconcile_mismatch").billing.state).toBe("held");
    } finally {
      await ctx.teardown();
    }
  });

  it("refuses a report that is not about a terminal execution status", async () => {
    const ctx = await setupHeldCall("reconcile-nonterminal-test", "req_reconcile_nonterminal");
    try {
      const response = await jsonRequest(ctx.baseUrl, "/v1/requests/req_reconcile_nonterminal/reconcile", {
        method: "POST",
        headers: ctx.responderHeaders,
        body: signReport(reportFor("req_reconcile_nonterminal", { observed_execution: "executing" }), ctx.privateKey)
      });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("CONTRACT_INVALID_RECONCILIATION");
      expect(ctx.state.requests.get("req_reconcile_nonterminal").billing.state).toBe("held");
    } finally {
      await ctx.teardown();
    }
  });

  it("moves money once when the same attempt is reported twice", async () => {
    // A device that restarts twice before the response gets home reports the
    // same attempt again. Exactly-once refunds are the point of NFR-R04.
    const ctx = await setupHeldCall("reconcile-idempotent-test", "req_reconcile_idempotent");
    try {
      const envelope = signReport(reportFor("req_reconcile_idempotent"), ctx.privateKey);
      const first = await jsonRequest(ctx.baseUrl, "/v1/requests/req_reconcile_idempotent/reconcile", {
        method: "POST",
        headers: ctx.responderHeaders,
        body: envelope
      });
      const second = await jsonRequest(ctx.baseUrl, "/v1/requests/req_reconcile_idempotent/reconcile", {
        method: "POST",
        headers: ctx.responderHeaders,
        body: envelope
      });

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(second.body.deduped).toBe(true);

      expect(await ctx.balance()).toBe(500);
      expect(await ctx.ledgerKinds()).toEqual(["hold", "refund"]);

      const reconciledEvents = ctx.state.requests
        .get("req_reconcile_idempotent")
        .events.filter((event) => event.event_type === "RECONCILED");
      expect(reconciledEvents).toHaveLength(1);
    } finally {
      await ctx.teardown();
    }
  });

  it("does not re-price a call that already reached a terminal outcome", async () => {
    // Late news. The call settled through the normal path; a reconciliation
    // arriving afterwards is recorded for the audit trail and nothing else.
    const ctx = await setupHeldCall("reconcile-late-test", "req_reconcile_late");
    try {
      const completed = await jsonRequest(ctx.baseUrl, "/v1/requests/req_reconcile_late/events", {
        method: "POST",
        headers: ctx.responderHeaders,
        body: {
          responder_id: ctx.responder.responder_id,
          hotline_id: ctx.responder.hotline_id,
          event_type: "COMPLETED",
          status: "ok",
          finished_at: "2026-08-01T00:02:00.000Z"
        }
      });
      expect(completed.status).toBe(202);
      const settledBalance = await ctx.balance();
      const settledLedger = await ctx.ledgerKinds();

      const response = await jsonRequest(ctx.baseUrl, "/v1/requests/req_reconcile_late/reconcile", {
        method: "POST",
        headers: ctx.responderHeaders,
        body: signReport(reportFor("req_reconcile_late"), ctx.privateKey)
      });

      expect(response.status).toBe(202);
      expect(response.body.superseded_by_existing_terminal).toBe(true);

      expect(await ctx.balance()).toBe(settledBalance);
      expect(await ctx.ledgerKinds()).toEqual(settledLedger);

      const request = ctx.state.requests.get("req_reconcile_late");
      expect(request.billing.state).toBe("settled");
      expect(request.events.find((event) => event.event_type === "RECONCILED")).toMatchObject({
        superseded_by_existing_terminal: true
      });
    } finally {
      await ctx.teardown();
    }
  });

  it("refuses a caller trying to reconcile someone else's execution", async () => {
    const ctx = await setupHeldCall("reconcile-scope-test", "req_reconcile_scope");
    try {
      const response = await jsonRequest(ctx.baseUrl, "/v1/requests/req_reconcile_scope/reconcile", {
        method: "POST",
        headers: { Authorization: `Bearer ${ctx.caller.api_key}` },
        body: signReport(reportFor("req_reconcile_scope"), ctx.privateKey)
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("AUTH_SCOPE_FORBIDDEN");
      expect(ctx.state.requests.get("req_reconcile_scope").billing.state).toBe("held");
    } finally {
      await ctx.teardown();
    }
  });

  it("refuses an unauthenticated reconciliation", async () => {
    const ctx = await setupHeldCall("reconcile-anon-test", "req_reconcile_anon");
    try {
      const response = await jsonRequest(ctx.baseUrl, "/v1/requests/req_reconcile_anon/reconcile", {
        method: "POST",
        body: signReport(reportFor("req_reconcile_anon"), ctx.privateKey)
      });

      expect(response.status).toBe(401);
      expect(ctx.state.requests.get("req_reconcile_anon").billing.state).toBe("held");
    } finally {
      await ctx.teardown();
    }
  });
});
