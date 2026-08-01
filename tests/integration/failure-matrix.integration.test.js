// The platform half of the M1 exit failure matrix.
//
// The exit condition names nine ways a cross-device call can go wrong and
// requires each to have a defined behavior and evidence. Seven of them are
// platform behavior and live here; the two that are purely responder-runtime
// behavior — a finished result being replayed instead of re-executed, and a
// retry staying a distinct attempt — live in the client repo's
// tests/integration/failure-matrix.integration.test.js.
//
// The rule underneath all of them: uncertainty resolves in the caller's
// favour. Work nobody can prove was delivered is not work anybody is charged
// for, and no failure path may leave a call with no terminal state at all.
import crypto from "node:crypto";

import { describe, expect, it } from "vitest";
import { newDb } from "pg-mem";

import { PRICING_MODEL, TRUST_TIER } from "@delexec/contracts";
import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { createBillingStore } from "../../packages/billing-store/src/index.js";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

const CONSENT = {
  acknowledged: true,
  pricing_model: PRICING_MODEL.FIXED_PRICE,
  currency: "PTS",
  max_charge_cents: 500,
  consent_at: "2026-08-02T00:00:00.000Z",
  trust_tier_seen: TRUST_TIER.UNTRUSTED
};

describe("M1 failure matrix (platform)", () => {
  const cleanup = [];

  async function scenario(name, { paid = false } = {}) {
    let store = null;
    if (paid) {
      const db = newDb();
      const { Pool } = db.adapters.createPg();
      const pool = new Pool();
      store = await createBillingStore({ pool });
      await store.migrate();
      cleanup.push(() => pool.end());
    }

    const state = createPlatformState({
      adminApiKey: `sk_admin_${name}`,
      bootstrapEnabled: true,
      ...(paid ? { billingStore: store, billingEnforcement: "enforced" } : {})
    });
    const responder = state.bootstrap.responders[0];
    if (paid) {
      state.catalog.get(responder.hotline_id).pricing_hint = {
        pricing_model: PRICING_MODEL.FIXED_PRICE,
        currency: "PTS",
        fixed_price_cents: 500,
        base_price_cents: null,
        variable_unit: null,
        variable_unit_description: null,
        variable_unit_price_cents: null,
        max_total_cents: 500,
        free_tier: null,
        billing_disclosure_url: "https://callanything.xyz/marketplace/responders/test",
        trust_tier: TRUST_TIER.UNTRUSTED
      };
    }

    const server = createPlatformServer({ serviceName: `matrix-${name}`, state });
    const baseUrl = await listenServer(server);
    cleanup.push(() => closeServer(server));

    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: `${name}@test.local` }
    });
    const requestId = `req_${name}`;
    if (paid) {
      await store.createTenant(caller.body.user_id);
      await store.createRecharge({
        recharge_id: `rch_${name}`,
        tenant_id: caller.body.user_id,
        amount_cents: 500,
        currency: "PTS"
      });
    }

    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: { Authorization: `Bearer ${caller.body.api_key}` },
      body: {
        request_id: requestId,
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        ...(paid ? { billing: CONSENT } : {})
      }
    });
    expect(token.status).toBe(201);

    return {
      state,
      baseUrl,
      store,
      caller: caller.body,
      responder,
      requestId,
      responderHeaders: { Authorization: `Bearer ${responder.api_key}` },
      adminHeaders: { Authorization: `Bearer ${state.adminApiKey}` },
      callerHeaders: { Authorization: `Bearer ${caller.body.api_key}` },
      balance: async () => (await store.getBalance(caller.body.user_id)).credit_balance_cents,
      ledgerKinds: async () =>
        (await store.getLedger(caller.body.user_id, { kind: ["hold", "refund", "debit"] })).items
          .map((item) => item.kind)
          .sort()
    };
  }

  async function teardown() {
    while (cleanup.length > 0) {
      await cleanup.pop()();
    }
  }

  // 1 —— 接受前离线: the device never acks. The call must be visible as
  // needing attention rather than sitting silently forever.
  it("offline before accept: surfaced as needing attention, never acked", async () => {
    const ctx = await scenario("offline_before_accept");
    try {
      const request = ctx.state.requests.get(ctx.requestId);
      // Age the events the platform actually wrote, rather than inventing a
      // field on them. Hand-stamping `recorded_at` is what hid the fact that
      // isStuckCall never fired on real calls.
      for (const event of request.events) {
        event.at = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
      }

      const attention = await jsonRequest(ctx.baseUrl, "/v1/admin/attention", { headers: ctx.adminHeaders });
      expect(attention.status).toBe(200);
      expect(attention.body.nothing_to_do).toBe(false);
      expect(JSON.stringify(attention.body.items)).toContain(ctx.requestId);
      expect(request.events.some((event) => event.event_type === "ACKED")).toBe(false);
    } finally {
      await teardown();
    }
  });

  // 3 —— 重复提交: the same request_id twice holds money once (FR-023).
  it("duplicate submission: one hold, not two", async () => {
    const ctx = await scenario("dup_submit", { paid: true });
    try {
      expect(await ctx.balance()).toBe(0);
      const again = await jsonRequest(ctx.baseUrl, "/v1/tokens/task", {
        method: "POST",
        headers: ctx.callerHeaders,
        body: {
          request_id: ctx.requestId,
          responder_id: ctx.responder.responder_id,
          hotline_id: ctx.responder.hotline_id,
          billing: CONSENT
        }
      });
      expect([200, 201]).toContain(again.status);
      expect(await ctx.balance()).toBe(0);
      expect(await ctx.ledgerKinds()).toEqual(["hold"]);
    } finally {
      await teardown();
    }
  });

  // 4 —— 重复交付: two COMPLETED reports settle once (NFR-R04).
  it("duplicate delivery: money moves once", async () => {
    const ctx = await scenario("dup_delivery", { paid: true });
    try {
      const body = {
        responder_id: ctx.responder.responder_id,
        hotline_id: ctx.responder.hotline_id,
        event_type: "COMPLETED",
        status: "ok",
        finished_at: "2026-08-02T00:02:00.000Z"
      };
      const first = await jsonRequest(ctx.baseUrl, `/v1/requests/${ctx.requestId}/events`, {
        method: "POST",
        headers: ctx.responderHeaders,
        body
      });
      const second = await jsonRequest(ctx.baseUrl, `/v1/requests/${ctx.requestId}/events`, {
        method: "POST",
        headers: ctx.responderHeaders,
        body
      });
      expect(first.status).toBe(202);
      expect(second.body.deduped).toBe(true);
      expect((await ctx.ledgerKinds()).filter((kind) => kind === "debit")).toHaveLength(1);
    } finally {
      await teardown();
    }
  });

  // 5 —— 部分 artifact: an allocated-but-uncommitted slot serves no bytes and
  // is never mistaken for a delivered artifact (NFR-R03).
  it("partial artifacts: the uncommitted slot yields nothing and stays allocated", async () => {
    const ctx = await scenario("partial_artifacts");
    try {
      const allocated = await jsonRequest(ctx.baseUrl, `/v1/requests/${ctx.requestId}/artifacts`, {
        method: "POST",
        headers: ctx.responderHeaders,
        body: { role: "output", media_type: "text/markdown" }
      });
      expect(allocated.status).toBe(201);
      expect(allocated.body.lifecycle_state).toBe("allocated");

      const detail = await jsonRequest(ctx.baseUrl, `/v1/artifacts/${allocated.body.artifact_id}`, {
        headers: ctx.responderHeaders
      });
      const content = await fetch(`${ctx.baseUrl}/v1/artifacts/${allocated.body.artifact_id}/content`, {
        headers: { Authorization: `Bearer ${detail.body.download_grant}` }
      });
      expect(content.status).not.toBe(200);
      expect(ctx.state.artifacts.get(allocated.body.artifact_id).lifecycle_state).toBe("allocated");
    } finally {
      await teardown();
    }
  });

  // 6 —— 重启: an interrupted attempt is closed out as failed and refunded,
  // never settled (A-03).
  it("restart mid-execution: refunded, never settled", async () => {
    const ctx = await scenario("restart", { paid: true });
    try {
      const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
      const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const record = ctx.state.responders.get(ctx.responder.responder_id);
      record.responder_public_key_pem = publicKeyPem;
      record.responder_public_keys_pem = [publicKeyPem];

      const report = {
        attempt_id: "attempt_died",
        boot_id: "boot_died",
        call_id: ctx.requestId,
        observed_execution: "failed",
        reason: "interrupted_attempt_outcome_unobserved"
      };
      const ordered = {};
      for (const key of Object.keys(report).sort()) {
        ordered[key] = report[key];
      }
      const response = await jsonRequest(ctx.baseUrl, `/v1/requests/${ctx.requestId}/reconcile`, {
        method: "POST",
        headers: ctx.responderHeaders,
        body: {
          report: ordered,
          signature: {
            signature_algorithm: "Ed25519",
            signer_public_key_pem: publicKeyPem,
            signature_base64: crypto
              .sign(null, Buffer.from(JSON.stringify(ordered), "utf8"), privateKey)
              .toString("base64")
          }
        }
      });

      expect(response.status).toBe(202);
      expect(await ctx.balance()).toBe(500);
      expect(await ctx.ledgerKinds()).toEqual(["hold", "refund"]);
      expect(ctx.state.requests.get(ctx.requestId).billing.state).toBe("refunded");
    } finally {
      await teardown();
    }
  });

  // 7 —— 超时+宽限: past the grace window with no terminal event, the call is
  // surfaced rather than left for someone to stumble across.
  it("timeout plus grace: the stuck call reaches the attention feed", async () => {
    const ctx = await scenario("timeout_grace");
    try {
      // Acked, then nothing — execution started and never reached a terminal
      // event, which is the shape the grace window is meant to catch.
      const acked = await jsonRequest(ctx.baseUrl, `/v1/requests/${ctx.requestId}/ack`, {
        method: "POST",
        headers: ctx.responderHeaders,
        body: { responder_id: ctx.responder.responder_id, hotline_id: ctx.responder.hotline_id }
      });
      expect(acked.status).toBe(202);

      const request = ctx.state.requests.get(ctx.requestId);
      const aged = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
      for (const event of request.events) {
        event.at = aged;
      }

      const attention = await jsonRequest(ctx.baseUrl, "/v1/admin/attention", { headers: ctx.adminHeaders });
      expect(attention.body.nothing_to_do).toBe(false);
      expect(JSON.stringify(attention.body.items)).toContain(ctx.requestId);
      // And it is flagged specifically as stuck, not merely present for some
      // unrelated reason.
      expect(JSON.stringify(attention.body.items)).toContain("call_stuck");
    } finally {
      await teardown();
    }
  });

  // 8 —— 过期版本: an expired or unknown task token reports inactive, so the
  // device refuses the work before doing any of it.
  it("expired task token: introspection reports inactive", async () => {
    const ctx = await scenario("expired_token");
    try {
      const introspected = await jsonRequest(ctx.baseUrl, "/v1/tokens/introspect", {
        method: "POST",
        headers: ctx.responderHeaders,
        body: { task_token: "not-a-valid-token" }
      });
      expect(introspected.status).toBe(200);
      expect(introspected.body.active).toBe(false);
    } finally {
      await teardown();
    }
  });
});
