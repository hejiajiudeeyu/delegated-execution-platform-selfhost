// The operator needs a way to end things, or the attention feed can never be
// empty.
//
// Both of the feed's live item kinds were unclearable for retired fixtures. A
// call only leaves `call_stuck` by reaching a terminal execution state, and the
// only things that produced one were the device itself and a signed
// reconciliation report — neither of which is coming from a device that no
// longer exists. `device_unavailable` counts any responder that still holds a
// hotline, and disabling the hotline does not change what the responder holds.
//
// Production on 2026-08-06 had 12 attention items, 11 of them from June/July
// rehearsals, and FR-066 alerting reuses this same computation. Turning
// alerting on would have paged every six hours, forever, about calls nobody
// could close. CHG-2026-197 promised that silence after an alert means
// resolved; an item no action can resolve breaks that promise for every other
// item too.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";

import { buildAttentionItems, createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { createBillingStore } from "../../packages/billing-store/src/index.js";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

const ADMIN_KEY = "sk_admin_closeout";
const LONG_AGO = "2026-06-13T20:32:00.000Z";

async function createBillingTestStore() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const store = await createBillingStore({ pool });
  await store.migrate();
  return { store, close: () => pool.end() };
}

describe("operator closeout", () => {
  let server;
  let baseUrl;
  let state;
  let adminAuth;
  let callerAuth;
  let billing;

  beforeEach(async () => {
    billing = await createBillingTestStore();
    state = createPlatformState({ adminApiKey: ADMIN_KEY, bootstrapEnabled: true, billingStore: billing.store });
    server = createPlatformServer({ serviceName: "closeout-test", state });
    baseUrl = await listenServer(server);
    adminAuth = { Authorization: `Bearer ${ADMIN_KEY}` };
    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "closeout@test.local" }
    });
    callerAuth = { Authorization: `Bearer ${caller.body.api_key}` };
  });

  afterEach(async () => {
    await closeServer(server);
    await billing.close();
  });

  async function abandonedCall(requestId, billingState = null) {
    const responder = state.bootstrap.responders[0];
    const issued = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: callerAuth,
      body: { request_id: requestId, responder_id: responder.responder_id, hotline_id: responder.hotline_id }
    });
    expect(issued.status).toBe(201);
    const request = state.requests.get(requestId);
    // Age it past the grace window: the device stopped reporting months ago.
    for (const event of request.events) {
      event.at = LONG_AGO;
    }
    if (billingState) {
      request.billing = {
        state: billingState,
        tenant_id: "tenant_closeout",
        hold_amount_cents: 500,
        held_at: LONG_AGO
      };
    }
    return request;
  }

  function close(requestId, body) {
    return jsonRequest(baseUrl, `/v1/admin/requests/${requestId}/close`, {
      method: "POST",
      headers: adminAuth,
      body
    });
  }

  it("ends a call nothing else will ever end", async () => {
    await abandonedCall("req_abandoned");
    expect(buildAttentionItems(state).find((item) => item.kind === "call_stuck")?.count).toBe(1);

    const response = await close("req_abandoned", { reason: "device retired in June; no report is coming" });

    expect(response.status).toBe(200);
    expect(response.body.execution).toBe("canceled");
    expect(buildAttentionItems(state).find((item) => item.kind === "call_stuck")).toBeUndefined();
  });

  it("refuses to close without a stated reason", async () => {
    await abandonedCall("req_no_reason");
    expect((await close("req_no_reason", {})).status).toBe(400);
    expect((await close("req_no_reason", { reason: "   " })).status).toBe(400);
    // Still open — a refused close must not half-close anything.
    expect(buildAttentionItems(state).find((item) => item.kind === "call_stuck")?.count).toBe(1);
  });

  it("records who closed it and why", async () => {
    await abandonedCall("req_audited");
    await close("req_audited", { reason: "rehearsal leftover" });

    const audited = state.auditEvents.filter((event) => event.action === "call.closed_by_operator");
    expect(audited).toHaveLength(1);
    expect(JSON.stringify(audited[0])).toContain("rehearsal leftover");
  });

  it("refunds money that was still held", async () => {
    await billing.store.createTenant("tenant_closeout");
    await abandonedCall("req_held", "held");

    const response = await close("req_held", { reason: "abandoned with funds held" });

    expect(response.body.billing).toBe("refunded");
    expect(state.requests.get("req_held").billing.state).toBe("refunded");
  });

  it("never reverses a settlement — closing is not an acceptance decision", async () => {
    await abandonedCall("req_settled", "settled");

    const response = await close("req_settled", { reason: "settled long ago, execution never finished" });

    expect(response.body.billing).toBe("left_as_settled");
    expect(state.requests.get("req_settled").billing.state).toBe("settled");
  });

  it("refuses to close a call that already ended", async () => {
    const request = await abandonedCall("req_done");
    request.events.push({ event_type: "COMPLETED", at: LONG_AGO });

    const response = await close("req_done", { reason: "tidying" });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONTRACT_EXECUTION_TERMINAL");
  });

  it("keeps closing behind operator credentials", async () => {
    await abandonedCall("req_authz");
    expect((await jsonRequest(baseUrl, "/v1/admin/requests/req_authz/close", { method: "POST", body: { reason: "x" } })).status).toBe(401);
    expect(
      (await jsonRequest(baseUrl, "/v1/admin/requests/req_authz/close", { method: "POST", headers: callerAuth, body: { reason: "x" } })).status
    ).toBe(403);
  });
});

describe("retiring a device", () => {
  let server;
  let baseUrl;
  let state;
  let adminAuth;

  beforeEach(async () => {
    state = createPlatformState({ adminApiKey: ADMIN_KEY, bootstrapEnabled: true });
    server = createPlatformServer({ serviceName: "retire-test", state });
    baseUrl = await listenServer(server);
    adminAuth = { Authorization: `Bearer ${ADMIN_KEY}` };
    // Every bootstrap device is offline in a fresh process.
    for (const responder of state.responders.values()) {
      responder.last_heartbeat_at = LONG_AGO;
    }
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("stops a gone device from reporting as a problem forever", async () => {
    const responder = state.bootstrap.responders[0];
    expect(buildAttentionItems(state).find((item) => item.kind === "device_unavailable")?.count).toBeGreaterThan(0);

    const response = await jsonRequest(baseUrl, `/v2/admin/responders/${responder.responder_id}/retire`, {
      method: "POST",
      headers: adminAuth,
      body: { reason: "rehearsal device, machine is gone" }
    });

    expect(response.status).toBe(200);
    expect(response.body.retired_hotline_ids).toContain(responder.hotline_id);

    const unavailable = buildAttentionItems(state).find((item) => item.kind === "device_unavailable");
    const stillListed = (unavailable?.targets || []).some((target) => target.id === responder.responder_id);
    expect(stillListed).toBe(false);
  });

  it("disables what it was serving rather than leaving it callable", async () => {
    const responder = state.bootstrap.responders[0];
    await jsonRequest(baseUrl, `/v2/admin/responders/${responder.responder_id}/retire`, {
      method: "POST",
      headers: adminAuth,
      body: { reason: "gone" }
    });
    expect(state.catalog.get(responder.hotline_id).status).toBe("disabled");
  });

  it("keeps the record — retiring withdraws a claim, it does not erase history", async () => {
    const responder = state.bootstrap.responders[0];
    await jsonRequest(baseUrl, `/v2/admin/responders/${responder.responder_id}/retire`, {
      method: "POST",
      headers: adminAuth,
      body: { reason: "gone" }
    });
    const stored = state.responders.get(responder.responder_id);
    expect(stored).toBeTruthy();
    expect(stored.retired_hotline_ids).toContain(responder.hotline_id);
    expect(stored.retire_reason).toBe("gone");
    expect(state.auditEvents.some((event) => event.action === "responder.retired")).toBe(true);
  });

  it("requires a reason", async () => {
    const responder = state.bootstrap.responders[0];
    const response = await jsonRequest(baseUrl, `/v2/admin/responders/${responder.responder_id}/retire`, {
      method: "POST",
      headers: adminAuth,
      body: {}
    });
    expect(response.status).toBe(400);
  });
});
