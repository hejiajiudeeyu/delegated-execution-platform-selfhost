// The two reads the console cannot build from resource-shaped endpoints:
// "what needs me now" and "the whole story of one call". The properties that
// matter are honesty ones — an untracked state axis must not look tracked, and
// an empty attention list must be a real answer rather than a missing one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

const ADMIN_KEY = "sk_admin_console_aggregates";

describe("console aggregate views", () => {
  let server;
  let baseUrl;
  let state;
  let adminAuth;
  let callerAuth;

  beforeEach(async () => {
    state = createPlatformState({ adminApiKey: ADMIN_KEY, bootstrapEnabled: true });
    server = createPlatformServer({ serviceName: "console-aggregates-test", state });
    baseUrl = await listenServer(server);
    adminAuth = { Authorization: `Bearer ${ADMIN_KEY}` };

    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "aggregates-caller@test.local" }
    });
    callerAuth = { Authorization: `Bearer ${caller.body.api_key}` };
  });

  afterEach(async () => {
    await closeServer(server);
  });

  async function issueCall(requestId) {
    const responder = state.bootstrap.responders[0];
    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: callerAuth,
      body: { request_id: requestId, responder_id: responder.responder_id, hotline_id: responder.hotline_id }
    });
    expect(token.status).toBe(201);
    return responder;
  }

  describe("attention feed", () => {
    it("requires operator credentials", async () => {
      expect((await jsonRequest(baseUrl, "/v1/admin/attention")).status).toBe(401);
      expect((await jsonRequest(baseUrl, "/v1/admin/attention", { headers: callerAuth })).status).toBe(403);
    });

    it("says plainly when there is nothing to do", async () => {
      // bootstrap fixtures are pre-approved, so a fresh network is quiet apart
      // from device availability, which we neutralize by removing hotlines
      for (const responder of state.responders.values()) {
        responder.hotline_ids = [];
      }
      const response = await jsonRequest(baseUrl, "/v1/admin/attention", { headers: adminAuth });
      expect(response.status).toBe(200);
      expect(response.body.nothing_to_do).toBe(true);
      expect(response.body.items).toEqual([]);
    });

    it("surfaces hotlines waiting for review with their targets", async () => {
      await jsonRequest(baseUrl, "/v2/responders/register", {
        method: "POST",
        headers: callerAuth,
        body: {
          responder_id: "responder_pending_review",
          hotline_id: "pending.review.v1",
          display_name: "Pending Review Hotline",
          responder_public_key_pem: state.bootstrap.responders[0].signing.publicKeyPem
        }
      });

      const response = await jsonRequest(baseUrl, "/v1/admin/attention", { headers: adminAuth });
      const item = response.body.items.find((entry) => entry.kind === "hotline_review_pending");
      expect(item).toBeTruthy();
      expect(item.count).toBeGreaterThanOrEqual(1);
      expect(item.targets.some((target) => target.id === "pending.review.v1")).toBe(true);
    });

    it("flags a call that passed its grace window without a terminal event", async () => {
      await issueCall("req_stuck_1");
      const request = state.requests.get("req_stuck_1");
      // Push its last event far enough back to exceed the grace window, on the
      // field appendRequestEvent actually writes. This used to set
      // `recorded_at`, a field no production event ever carries, which made the
      // case pass while isStuckCall returned false for every real call.
      request.events[request.events.length - 1].at = new Date(Date.now() - 3600_000).toISOString();

      const response = await jsonRequest(baseUrl, "/v1/admin/attention", { headers: adminAuth });
      const item = response.body.items.find((entry) => entry.kind === "call_stuck");
      expect(item).toBeTruthy();
      expect(item.targets.some((target) => target.id === "req_stuck_1")).toBe(true);
    });

    it("does not flag a recent in-flight call as stuck", async () => {
      await issueCall("req_fresh_1");
      const response = await jsonRequest(baseUrl, "/v1/admin/attention", { headers: adminAuth });
      const item = response.body.items.find((entry) => entry.kind === "call_stuck");
      expect(item).toBeFalsy();
    });

    it("flags funds still held after the call ended", async () => {
      await issueCall("req_held_after_end");
      const request = state.requests.get("req_held_after_end");
      request.billing = { state: "held", tenant_id: "tenant_x", hold_amount_cents: 500 };
      request.events.push({ event_type: "COMPLETED", recorded_at: new Date().toISOString() });

      const response = await jsonRequest(baseUrl, "/v1/admin/attention", { headers: adminAuth });
      const item = response.body.items.find((entry) => entry.kind === "funds_held_after_end");
      expect(item).toBeTruthy();
      expect(item.targets[0].id).toBe("req_held_after_end");
    });

    it("names what it cannot yet watch instead of pretending coverage", async () => {
      const response = await jsonRequest(baseUrl, "/v1/admin/attention", { headers: adminAuth });
      const kinds = response.body.not_tracked.map((entry) => entry.kind);
      expect(kinds).toContain("dispute_open");
      expect(kinds).toContain("acceptance_expiring");
    });
  });

  describe("call detail", () => {
    it("returns 404 for an unknown call rather than an empty shell", async () => {
      const response = await jsonRequest(baseUrl, "/v1/admin/requests/req_does_not_exist", { headers: adminAuth });
      expect(response.status).toBe(404);
    });

    it("joins timeline, responder, hotline and billing into one read", async () => {
      const responder = await issueCall("req_detail_1");

      const response = await jsonRequest(baseUrl, "/v1/admin/requests/req_detail_1", { headers: adminAuth });
      expect(response.status).toBe(200);
      expect(response.body.request_id).toBe("req_detail_1");
      expect(response.body.timeline.length).toBeGreaterThan(0);
      expect(response.body.responder.responder_id).toBe(responder.responder_id);
      expect(response.body.hotline.hotline_id).toBe(responder.hotline_id);
      // the console no longer has to fetch three endpoints and join them itself
      expect(response.body).toHaveProperty("artifacts");
      expect(response.body).toHaveProperty("audit_events");
    });

    it("reports untracked state axes as untracked rather than inventing a value", async () => {
      await issueCall("req_detail_axes");
      const response = await jsonRequest(baseUrl, "/v1/admin/requests/req_detail_axes", { headers: adminAuth });
      const axes = response.body.state;

      expect(axes.execution.tracked).toBe(true);
      expect(axes.execution.value).toBe("submitted");

      // These land in M3. A fabricated "accepted" would be worse than a blank.
      expect(axes.delivery_integrity.tracked).toBe(false);
      expect(axes.delivery_integrity.value).toBeNull();
      expect(axes.delivery_integrity.reason).toMatch(/M3/);
      expect(axes.acceptance.tracked).toBe(false);
      expect(axes.acceptance.value).toBeNull();
    });

    it("projects execution from the latest meaningful event", async () => {
      await issueCall("req_detail_completed");
      const request = state.requests.get("req_detail_completed");
      request.events.push({ event_type: "COMPLETED", recorded_at: new Date().toISOString() });

      const response = await jsonRequest(baseUrl, "/v1/admin/requests/req_detail_completed", { headers: adminAuth });
      expect(response.body.state.execution.value).toBe("delivered");
    });

    it("reports settlement as untracked when the call never touched billing", async () => {
      await issueCall("req_detail_nobilling");
      const response = await jsonRequest(baseUrl, "/v1/admin/requests/req_detail_nobilling", { headers: adminAuth });
      expect(response.body.state.settlement.tracked).toBe(false);
      expect(response.body.state.settlement.value).toBe("none");
      expect(response.body.billing).toBeNull();
    });

    it("includes committed artifacts belonging to the call", async () => {
      await issueCall("req_detail_artifacts");
      const slot = await jsonRequest(baseUrl, "/v1/requests/req_detail_artifacts/artifacts", {
        method: "POST",
        headers: callerAuth,
        body: { role: "input", media_type: "text/plain" }
      });
      expect(slot.status).toBe(201);

      const response = await jsonRequest(baseUrl, "/v1/admin/requests/req_detail_artifacts", { headers: adminAuth });
      expect(response.body.artifacts).toHaveLength(1);
      expect(response.body.artifacts[0].artifact_id).toBe(slot.body.artifact_id);
      // storage locators must not leak through the aggregate either
      for (const forbidden of ["bucket", "object_key", "presigned_url", "url", "local_path"]) {
        expect(response.body.artifacts[0], forbidden).not.toHaveProperty(forbidden);
      }
    });

    it("keeps a non-operator out of the call detail", async () => {
      await issueCall("req_detail_forbidden");
      const response = await jsonRequest(baseUrl, "/v1/admin/requests/req_detail_forbidden", { headers: callerAuth });
      expect(response.status).toBe(403);
    });
  });
});
