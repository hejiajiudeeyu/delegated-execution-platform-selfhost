import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { createRelayServer } from "@delexec/transport-relay";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";
import { createRelayHttpTransportAdapter } from "../helpers/relay-http.js";

describe("platform-api integration", () => {
  let server;
  let baseUrl;
  let state;

  beforeAll(async () => {
    state = createPlatformState();
    server = createPlatformServer({ serviceName: "platform-api-test", state });
    baseUrl = await listenServer(server);
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("registers user, issues token, introspects token", async () => {
    const register = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { email: "integration-platform@test.local" }
    });
    expect(register.status).toBe(201);

    const auth = { Authorization: `Bearer ${register.body.api_key}` };

    const catalog = await jsonRequest(baseUrl, "/v2/hotlines?status=enabled");
    expect(catalog.status).toBe(200);
    expect(catalog.body.items.length).toBeGreaterThan(0);

    const selected = catalog.body.items[0];

    const tokenRes = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: auth,
      body: {
        request_id: "req_integration_platform_1",
        responder_id: selected.responder_id,
        hotline_id: selected.hotline_id
      }
    });
    expect(tokenRes.status).toBe(201);
    expect(tokenRes.body.task_token).toBeTruthy();
    expect(tokenRes.body.claims).toMatchObject({
      request_id: "req_integration_platform_1",
      responder_id: selected.responder_id,
      hotline_id: selected.hotline_id,
      aud: selected.responder_id
    });
    expect(typeof tokenRes.body.claims.exp).toBe("number");

    const responderAuth = {
      Authorization: `Bearer ${state.bootstrap.responders.find((item) => item.responder_id === selected.responder_id).api_key}`
    };
    const introspect = await jsonRequest(baseUrl, "/v1/tokens/introspect", {
      method: "POST",
      headers: responderAuth,
      body: { task_token: tokenRes.body.task_token }
    });
    expect(introspect.status).toBe(200);
    expect(introspect.body.active).toBe(true);

    const template = await jsonRequest(
      baseUrl,
      `/v2/hotlines/${selected.hotline_id}/template-bundle?template_ref=${encodeURIComponent(selected.template_ref)}`
    );
    expect(template.status).toBe(200);
    expect(template.body.input_schema).toBeTypeOf("object");
    expect(template.body.output_schema).toBeTypeOf("object");
  });

  it("rejects token issuance without auth", async () => {
    const tokenRes = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      body: {
        request_id: "req_no_auth_1",
        responder_id: "responder_foxlab",
        hotline_id: "foxlab.text.classifier.v1"
      }
    });
    expect(tokenRes.status).toBe(401);
    expect(tokenRes.body.error.code).toBe("AUTH_UNAUTHORIZED");
  });

  it("updates catalog availability via heartbeat", async () => {
    const register = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-heartbeat@test.local" }
    });
    const before = await jsonRequest(baseUrl, "/v2/hotlines?availability_status=healthy");
    expect(before.status).toBe(200);
    expect(before.body.items.length).toBeGreaterThan(0);

    const target = before.body.items[0];
    const responderAuth = {
      Authorization: `Bearer ${state.bootstrap.responders.find((item) => item.responder_id === target.responder_id).api_key}`
    };
    const heartbeat = await jsonRequest(baseUrl, `/v2/responders/${target.responder_id}/heartbeat`, {
      method: "POST",
      headers: responderAuth,
      body: { status: "degraded" }
    });
    expect(heartbeat.status).toBe(202);

    const degraded = await jsonRequest(baseUrl, "/v2/hotlines?availability_status=degraded");
    expect(degraded.status).toBe(200);
    expect(degraded.body.items.some((item) => item.responder_id === target.responder_id)).toBe(true);
  });

  it("enforces request ownership and keeps ACK idempotent", async () => {
    const callerOne = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-owner-1@test.local" }
    });
    const callerTwo = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-owner-2@test.local" }
    });
    const requestId = "req_request_ownership_1";
    const responder = state.bootstrap.responders[0];

    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: { Authorization: `Bearer ${callerOne.body.api_key}` },
      body: {
        request_id: requestId,
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id
      }
    });
    expect(token.status).toBe(201);

    const deliveryMeta = await jsonRequest(baseUrl, `/v1/requests/${requestId}/delivery-meta`, {
      method: "POST",
      headers: { Authorization: `Bearer ${callerOne.body.api_key}` },
      body: {
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        task_token: token.body.task_token,
        result_delivery: {
          kind: "local",
          address: "caller-controller"
        }
      }
    });
    expect(deliveryMeta.status).toBe(200);
    expect(deliveryMeta.body.task_delivery.address.startsWith("local://")).toBe(true);
    expect(deliveryMeta.body.result_delivery.address).toBe("caller-controller");
    expect(deliveryMeta.body.verification.display_code).toBeTypeOf("string");

    const foreignEvents = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      headers: { Authorization: `Bearer ${callerTwo.body.api_key}` }
    });
    expect(foreignEvents.status).toBe(403);
    expect(foreignEvents.body.error.code).toBe("AUTH_RESOURCE_FORBIDDEN");

    const foreignDeliveryMeta = await jsonRequest(baseUrl, `/v1/requests/${requestId}/delivery-meta`, {
      method: "POST",
      headers: { Authorization: `Bearer ${callerTwo.body.api_key}` },
      body: {
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        result_delivery: {
          kind: "local",
          address: "caller-controller"
        }
      }
    });
    expect(foreignDeliveryMeta.status).toBe(403);
    expect(foreignDeliveryMeta.body.error.code).toBe("AUTH_RESOURCE_FORBIDDEN");

    const responderAuth = {
      Authorization: `Bearer ${state.bootstrap.responders.find((item) => item.responder_id === responder.responder_id).api_key}`
    };
    const firstAck = await jsonRequest(baseUrl, `/v1/requests/${requestId}/ack`, {
      method: "POST",
      headers: responderAuth,
      body: {
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        eta_hint_s: 2
      }
    });
    expect(firstAck.status).toBe(202);

    const secondAck = await jsonRequest(baseUrl, `/v1/requests/${requestId}/ack`, {
      method: "POST",
      headers: responderAuth,
      body: {
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        eta_hint_s: 3
      }
    });
    expect(secondAck.status).toBe(202);

    const events = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      headers: { Authorization: `Bearer ${callerOne.body.api_key}` }
    });
    expect(events.status).toBe(200);
    expect(events.body.events.filter((event) => event.event_type === "ACKED")).toHaveLength(1);
  });

  it("allows responder to append COMPLETED and FAILED request events idempotently", async () => {
    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-request-events@test.local" }
    });
    const responder = state.bootstrap.responders[0];
    const responderAuth = {
      Authorization: `Bearer ${state.bootstrap.responders.find((item) => item.responder_id === responder.responder_id).api_key}`
    };
    const callerAuth = {
      Authorization: `Bearer ${caller.body.api_key}`
    };
    const requestId = "req_request_events_1";

    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: callerAuth,
      body: {
        request_id: requestId,
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id
      }
    });
    expect(token.status).toBe(201);

    const deliveryMeta = await jsonRequest(baseUrl, `/v1/requests/${requestId}/delivery-meta`, {
      method: "POST",
      headers: callerAuth,
      body: {
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        task_token: token.body.task_token,
        result_delivery: {
          kind: "local",
          address: "caller-controller"
        }
      }
    });
    expect(deliveryMeta.status).toBe(200);

    const completed = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      method: "POST",
      headers: responderAuth,
      body: {
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        event_type: "COMPLETED",
        status: "ok",
        finished_at: "2026-03-11T10:00:00Z"
      }
    });
    expect(completed.status).toBe(202);
    expect(completed.body.event.event_type).toBe("COMPLETED");

    const completedAgain = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      method: "POST",
      headers: responderAuth,
      body: {
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        event_type: "COMPLETED",
        status: "ok",
        finished_at: "2026-03-11T10:00:01Z"
      }
    });
    expect(completedAgain.status).toBe(202);
    expect(completedAgain.body.deduped).toBe(true);

    const failedRequestId = "req_request_events_2";
    const failedToken = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: callerAuth,
      body: {
        request_id: failedRequestId,
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id
      }
    });
    expect(failedToken.status).toBe(201);

    await jsonRequest(baseUrl, `/v1/requests/${failedRequestId}/delivery-meta`, {
      method: "POST",
      headers: callerAuth,
      body: {
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        task_token: failedToken.body.task_token,
        result_delivery: {
          kind: "local",
          address: "caller-controller"
        }
      }
    });

    const failed = await jsonRequest(baseUrl, `/v1/requests/${failedRequestId}/events`, {
      method: "POST",
      headers: responderAuth,
      body: {
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        event_type: "FAILED",
        status: "error",
        error_code: "EXEC_INTERNAL_ERROR",
        finished_at: "2026-03-11T10:01:00Z"
      }
    });
    expect(failed.status).toBe(202);
    expect(failed.body.event.error_code).toBe("EXEC_INTERNAL_ERROR");

    const events = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      headers: callerAuth
    });
    expect(events.status).toBe(200);
    expect(events.body.events.filter((event) => event.event_type === "COMPLETED")).toHaveLength(1);
  });

  it("rejects request event writes from non-responder callers and mismatched bindings", async () => {
    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-request-events-auth@test.local" }
    });
    const responder = state.bootstrap.responders[0];
    const responderAuth = {
      Authorization: `Bearer ${state.bootstrap.responders.find((item) => item.responder_id === responder.responder_id).api_key}`
    };
    const callerAuth = {
      Authorization: `Bearer ${caller.body.api_key}`
    };
    const requestId = "req_request_events_auth_1";

    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: callerAuth,
      body: {
        request_id: requestId,
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id
      }
    });
    expect(token.status).toBe(201);

    await jsonRequest(baseUrl, `/v1/requests/${requestId}/delivery-meta`, {
      method: "POST",
      headers: callerAuth,
      body: {
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        task_token: token.body.task_token,
        result_delivery: {
          kind: "local",
          address: "caller-controller"
        }
      }
    });

    const callerWrite = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      method: "POST",
      headers: callerAuth,
      body: {
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        event_type: "COMPLETED"
      }
    });
    expect(callerWrite.status).toBe(403);
    expect(callerWrite.body.error.code).toBe("AUTH_SCOPE_FORBIDDEN");

    const mismatch = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      method: "POST",
      headers: responderAuth,
      body: {
        responder_id: responder.responder_id,
        hotline_id: "wrong.agent.v1",
        event_type: "FAILED"
      }
    });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error.code).toBe("AUTH_RESOURCE_FORBIDDEN");
  });

  it("returns inactive for expired token", async () => {
    const register = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-expired@test.local" }
    });
    const auth = { Authorization: `Bearer ${register.body.api_key}` };

    const originalTtl = process.env.TOKEN_TTL_SECONDS;
    process.env.TOKEN_TTL_SECONDS = "1";

    try {
      const issue = await jsonRequest(baseUrl, "/v1/tokens/task", {
        method: "POST",
        headers: auth,
        body: {
          request_id: "req_expired_token_case",
          responder_id: "responder_foxlab",
          hotline_id: "foxlab.text.classifier.v1"
        }
      });
      expect(issue.status).toBe(201);

      await new Promise((resolve) => setTimeout(resolve, 1200));

      const responderAuth = {
        Authorization: `Bearer ${state.bootstrap.responders.find((item) => item.responder_id === "responder_foxlab").api_key}`
      };
      const introspect = await jsonRequest(baseUrl, "/v1/tokens/introspect", {
        method: "POST",
        headers: responderAuth,
        body: { task_token: issue.body.task_token }
      });
      expect(introspect.status).toBe(200);
      expect(introspect.body.active).toBe(false);
      expect(introspect.body.error.code).toBe("AUTH_TOKEN_EXPIRED");
    } finally {
      if (originalTtl === undefined) {
        delete process.env.TOKEN_TTL_SECONDS;
      } else {
        process.env.TOKEN_TTL_SECONDS = originalTtl;
      }
    }
  });

  it("returns not implemented for platform_inbox result delivery", async () => {
    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-platform-inbox@test.local" }
    });
    const responder = state.bootstrap.responders[0];

    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: { Authorization: `Bearer ${caller.body.api_key}` },
      body: {
        request_id: "req_platform_inbox_1",
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id
      }
    });
    expect(token.status).toBe(201);

    const deliveryMeta = await jsonRequest(baseUrl, "/v1/requests/req_platform_inbox_1/delivery-meta", {
      method: "POST",
      headers: { Authorization: `Bearer ${caller.body.api_key}` },
      body: {
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        task_token: token.body.task_token,
        result_delivery: {
          kind: "platform_inbox",
          address: "platform://requests/req_platform_inbox_1/result"
        }
      }
    });
    expect(deliveryMeta.status).toBe(501);
    expect(deliveryMeta.body.error.code).toBe("RESULT_DELIVERY_KIND_NOT_IMPLEMENTED");
  });

  it("rejects protected endpoints with invalid api key", async () => {
    const badAuth = { Authorization: "Bearer sk_test_invalid_key" };

    const endpoints = [
      { method: "POST", path: "/v1/tokens/task", body: { request_id: "req_bad_1" } },
      { method: "POST", path: "/v1/tokens/introspect", body: { token: "x" } },
      { method: "POST", path: "/v1/requests/req_bad_1/delivery-meta", body: {} },
      { method: "POST", path: "/v1/metrics/events", body: { event_name: "x", source: "test" } },
      { method: "GET", path: "/v1/metrics/summary" },
      { method: "POST", path: "/v1/requests/req_bad_1/ack", body: {} },
      { method: "GET", path: "/v1/requests/req_bad_1/events" },
      { method: "POST", path: "/v2/responders/responder_foxlab/heartbeat", body: { status: "healthy" } }
    ];

    for (const endpoint of endpoints) {
      const response = await jsonRequest(baseUrl, endpoint.path, {
        method: endpoint.method,
        headers: badAuth,
        body: endpoint.body
      });
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(401);
      expect(response.body.error.code).toBe("AUTH_UNAUTHORIZED");
    }
  });

  it("registers responder identities and filters catalog by capability", async () => {
    const registered = await jsonRequest(baseUrl, "/v2/responders/register", {
      method: "POST",
      body: {
        responder_id: "responder_legalworks",
        hotline_id: "legalworks.contract.extractor.v1",
        display_name: "LegalWorks Contract Extractor",
        responder_public_key_pem: state.bootstrap.responders[0].signing.publicKeyPem,
        task_types: ["contract_extract"],
        capabilities: ["contract.extract", "legal.review"],
        tags: ["legal", "contracts"]
      }
    });
    expect(registered.status).toBe(201);
    expect(registered.body.api_key).toMatch(/^sk_responder_/);

    expect(registered.body.status).toBe("disabled");
    expect(registered.body.review_status).toBe("pending");
    expect(registered.body.responder_review_status).toBe("pending");
    expect(registered.body.hotline_review_status).toBe("pending");
    expect(registered.body.catalog_visibility).toBe("hidden");

    const filteredBeforeApproval = await jsonRequest(baseUrl, "/v2/hotlines?capability=contract.extract");
    expect(filteredBeforeApproval.status).toBe(200);
    expect(filteredBeforeApproval.body.items).toHaveLength(0);

    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "pending-responder-caller@test.local" }
    });
    const tokenBeforeApproval = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${caller.body.api_key}`
      },
      body: {
        request_id: "req_pending_responder_1",
        responder_id: "responder_legalworks",
        hotline_id: "legalworks.contract.extractor.v1"
      }
    });
    expect(tokenBeforeApproval.status).toBe(404);
    expect(tokenBeforeApproval.body.error.code).toBe("CATALOG_HOTLINE_NOT_FOUND");

    const approved = await jsonRequest(baseUrl, "/v2/admin/hotlines/legalworks.contract.extractor.v1/approve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.adminApiKey}`
      },
      body: {
        reason: "initial review passed"
      }
    });
    expect(approved.status).toBe(200);

    const filteredAfterHotlineOnly = await jsonRequest(baseUrl, "/v2/hotlines?capability=contract.extract");
    expect(filteredAfterHotlineOnly.status).toBe(200);
    expect(filteredAfterHotlineOnly.body.items).toHaveLength(0);

    const approveResponder = await jsonRequest(baseUrl, "/v2/admin/responders/responder_legalworks/approve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.adminApiKey}`
      },
      body: {
        reason: "responder review passed"
      }
    });
    expect(approveResponder.status).toBe(200);

    const filtered = await jsonRequest(baseUrl, "/v2/hotlines?capability=contract.extract");
    expect(filtered.status).toBe(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0]).toMatchObject({
      responder_id: "responder_legalworks",
      hotline_id: "legalworks.contract.extractor.v1"
    });

    const publicDetail = await jsonRequest(baseUrl, "/v2/hotlines/legalworks.contract.extractor.v1");
    expect(publicDetail.status).toBe(200);
    expect(publicDetail.body.catalog_visibility).toBe("public");

    const tagged = await jsonRequest(baseUrl, "/v2/hotlines?tag=legal");
    expect(tagged.status).toBe(200);
    expect(tagged.body.items.some((item) => item.hotline_id === "legalworks.contract.extractor.v1")).toBe(true);
  });

  it("allows a caller to add the responder role on the same user", async () => {
    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "dual-role@test.local" }
    });
    expect(caller.status).toBe(201);

    const registered = await jsonRequest(baseUrl, "/v2/responders/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${caller.body.api_key}`
      },
      body: {
        responder_id: "responder_dual_role",
        hotline_id: "dual.role.v1",
        display_name: "Dual Role Responder",
        responder_public_key_pem: state.bootstrap.responders[0].signing.publicKeyPem
      }
    });
    expect(registered.status).toBe(201);
    expect(registered.body.owner_user_id).toBe(caller.body.user_id);
    expect(state.users.get(caller.body.user_id).roles).toEqual(["caller", "responder"]);
    expect(registered.body.review_status).toBe("pending");
  });

  it("allows an existing responder to append a second hotline", async () => {
    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "multi-hotline@test.local" }
    });

    const first = await jsonRequest(baseUrl, "/v2/responders/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${caller.body.api_key}`
      },
      body: {
        responder_id: "responder_multi",
        hotline_id: "multi.first.v1",
        display_name: "First Hotline",
        responder_public_key_pem: state.bootstrap.responders[0].signing.publicKeyPem
      }
    });
    expect(first.status).toBe(201);

    const second = await jsonRequest(baseUrl, "/v2/responders/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${first.body.api_key}`
      },
      body: {
        responder_id: "responder_multi",
        hotline_id: "multi.second.v1",
        display_name: "Second Hotline",
        responder_public_key_pem: state.bootstrap.responders[0].signing.publicKeyPem,
        capabilities: ["text.summarize"]
      }
    });
    expect(second.status).toBe(201);
    expect(second.body.api_key).toBe(first.body.api_key);
    expect(state.responders.get("responder_multi").hotline_ids).toEqual(["multi.first.v1", "multi.second.v1"]);
    expect(state.apiKeys.get(first.body.api_key).hotline_ids).toEqual(["multi.first.v1", "multi.second.v1"]);
    expect(second.body.review_status).toBe("pending");
  });

  it("supports formal onboarding details and hidden admin review tests over relay transport", async () => {
    const previousReviewTransportBaseUrl = process.env.REVIEW_TRANSPORT_BASE_URL;
    const relayServer = createRelayServer({ serviceName: "platform-review-relay-test" });
    const relayUrl = await listenServer(relayServer);
    process.env.REVIEW_TRANSPORT_BASE_URL = relayUrl;

    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "review-owner@test.local" }
    });
    const callerAuth = {
      Authorization: `Bearer ${caller.body.api_key}`
    };

    const onboarding = await jsonRequest(baseUrl, "/v2/hotlines", {
      method: "POST",
      headers: callerAuth,
      body: {
        responder_id: "responder_review_probe",
        hotline_id: "review.probe.v1",
        display_name: "Review Probe",
        responder_public_key_pem: state.bootstrap.responders[0].signing.publicKeyPem,
        capabilities: ["text.summarize"],
        task_types: ["text_summarize"]
      }
    });
    expect(onboarding.status).toBe(201);
    expect(onboarding.body.responder_review_status).toBe("pending");
    expect(onboarding.body.hotline_review_status).toBe("pending");
    expect(onboarding.body.catalog_visibility).toBe("hidden");

    const publicDetailBeforeApproval = await jsonRequest(baseUrl, "/v2/hotlines/review.probe.v1");
    expect(publicDetailBeforeApproval.status).toBe(404);

    const ownerDetail = await jsonRequest(baseUrl, "/v2/hotlines/review.probe.v1", {
      headers: callerAuth
    });
    expect(ownerDetail.status).toBe(200);
    expect(ownerDetail.body.submission.submission_version).toBe(1);
    expect(ownerDetail.body.catalog_visibility).toBe("hidden");

    const responderServer = createResponderControllerServer({
      serviceName: "platform-review-responder-test",
      state: createResponderState({
        responderId: "responder_review_probe",
        hotlineIds: ["review.probe.v1"],
        signing: state.bootstrap.responders[0].signing
      }),
      transport: createRelayHttpTransportAdapter({
        baseUrl: relayUrl,
        receiver: "responder_review_probe"
      }),
      platform: {
        baseUrl,
        apiKey: onboarding.body.responder_api_key,
        responderId: "responder_review_probe"
      },
      background: {
        enabled: true,
        receiver: "responder_review_probe",
        inboxPollIntervalMs: 20
      }
    });
    await listenServer(responderServer);

    try {
      const reviewTest = await jsonRequest(baseUrl, "/v2/admin/hotlines/review.probe.v1/review-tests", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.adminApiKey}`
        },
        body: {
          task_input: { text: "review this task" },
          constraints: { hard_timeout_s: 2 }
        }
      });
      expect(reviewTest.status).toBe(202);

      let reviewResult;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        reviewResult = await jsonRequest(baseUrl, `/v1/admin/review-tests/${reviewTest.body.request_id}`, {
          headers: {
            Authorization: `Bearer ${state.adminApiKey}`
          }
        });
        if (reviewResult.status === 200 && reviewResult.body.finished_at) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(reviewResult.status).toBe(200);
      expect(reviewResult.body.verdict).toBe("pass");
      expect(reviewResult.body.request.request_kind).toBe("review_test");
      expect(reviewResult.body.request.request_visibility).toBe("hidden");

      const reviewTestList = await jsonRequest(baseUrl, "/v1/admin/review-tests?hotline_id=review.probe.v1", {
        headers: {
          Authorization: `Bearer ${state.adminApiKey}`
        }
      });
      expect(reviewTestList.status).toBe(200);
      expect(reviewTestList.body.items[0].verdict).toBe("pass");

      const adminHotlineDetail = await jsonRequest(baseUrl, "/v2/hotlines/review.probe.v1", {
        headers: {
          Authorization: `Bearer ${state.adminApiKey}`
        }
      });
      expect(adminHotlineDetail.status).toBe(200);
      expect(adminHotlineDetail.body.latest_review_test.verdict).toBe("pass");
    } finally {
      await closeServer(responderServer);
      await closeServer(relayServer);
      if (previousReviewTransportBaseUrl === undefined) {
        delete process.env.REVIEW_TRANSPORT_BASE_URL;
      } else {
        process.env.REVIEW_TRANSPORT_BASE_URL = previousReviewTransportBaseUrl;
      }
    }
  });

  it("serves admin responder, hotline, and request views and allows status actions", async () => {
    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "platform-admin@test.local" }
    });
    const callerAuth = {
      Authorization: `Bearer ${caller.body.api_key}`
    };
    const adminAuth = {
      Authorization: `Bearer ${state.adminApiKey}`
    };

    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: callerAuth,
      body: {
        request_id: "req_admin_view_1",
        responder_id: "responder_foxlab",
        hotline_id: "foxlab.text.classifier.v1"
      }
    });
    expect(token.status).toBe(201);

    const forbidden = await jsonRequest(baseUrl, "/v2/admin/responders", {
      headers: callerAuth
    });
    expect(forbidden.status).toBe(403);

    const responders = await jsonRequest(baseUrl, "/v2/admin/responders", {
      headers: adminAuth
    });
    expect(responders.status).toBe(200);
    expect(responders.body.items.some((item) => item.responder_id === "responder_foxlab")).toBe(true);

    const hotlines = await jsonRequest(baseUrl, "/v2/admin/hotlines", {
      headers: adminAuth
    });
    expect(hotlines.status).toBe(200);
    expect(hotlines.body.items.some((item) => item.hotline_id === "foxlab.text.classifier.v1")).toBe(true);

    const requests = await jsonRequest(baseUrl, "/v1/admin/requests", {
      headers: adminAuth
    });
    expect(requests.status).toBe(200);
    expect(requests.body.items.some((item) => item.request_id === "req_admin_view_1")).toBe(true);

    const grant = await jsonRequest(baseUrl, `/v1/admin/users/${caller.body.user_id}/roles`, {
      method: "POST",
      headers: adminAuth,
      body: {
        role: "admin"
      }
    });
    expect(grant.status).toBe(200);
    expect(grant.body.roles).toContain("admin");

    const delegated = await jsonRequest(baseUrl, "/v2/admin/responders", {
      headers: callerAuth
    });
    expect(delegated.status).toBe(200);

    const disableHotline = await jsonRequest(baseUrl, "/v2/admin/hotlines/foxlab.text.classifier.v1/disable", {
      method: "POST",
      headers: adminAuth,
      body: { reason: "quality regression" }
    });
    expect(disableHotline.status).toBe(200);
    expect(state.catalog.get("foxlab.text.classifier.v1").status).toBe("disabled");

    const approveHotline = await jsonRequest(baseUrl, "/v2/admin/hotlines/foxlab.text.classifier.v1/approve", {
      method: "POST",
      headers: adminAuth
    });
    expect(approveHotline.status).toBe(200);
    expect(state.catalog.get("foxlab.text.classifier.v1").status).toBe("enabled");

    const disableResponder = await jsonRequest(baseUrl, "/v2/admin/responders/responder_foxlab/disable", {
      method: "POST",
      headers: adminAuth,
      body: { reason: "maintenance window" }
    });
    expect(disableResponder.status).toBe(200);
    expect(state.responders.get("responder_foxlab").status).toBe("disabled");
    expect(state.catalog.get("foxlab.text.classifier.v1").status).toBe("enabled");

    const approveResponder = await jsonRequest(baseUrl, "/v2/admin/responders/responder_foxlab/approve", {
      method: "POST",
      headers: adminAuth,
      body: { reason: "maintenance complete" }
    });
    expect(approveResponder.status).toBe(200);
    expect(state.responders.get("responder_foxlab").status).toBe("enabled");
    expect(state.catalog.get("foxlab.text.classifier.v1").status).toBe("enabled");

    const rejectHotline = await jsonRequest(baseUrl, "/v2/admin/hotlines/foxlab.text.classifier.v1/reject", {
      method: "POST",
      headers: adminAuth,
      body: { reason: "schema issues" }
    });
    expect(rejectHotline.status).toBe(200);
    expect(state.catalog.get("foxlab.text.classifier.v1").status).toBe("disabled");

    const reapproveHotline = await jsonRequest(baseUrl, "/v2/admin/hotlines/foxlab.text.classifier.v1/approve", {
      method: "POST",
      headers: adminAuth,
      body: { reason: "schema fixed" }
    });
    expect(reapproveHotline.status).toBe(200);
    expect(state.catalog.get("foxlab.text.classifier.v1").status).toBe("enabled");

    const audit = await jsonRequest(baseUrl, "/v1/admin/audit-events?limit=10", {
      headers: adminAuth
    });
    expect(audit.status).toBe(200);
    expect(audit.body.items.some((item) => item.action === "user.role.granted" && item.target_id === caller.body.user_id)).toBe(true);
    expect(audit.body.items.some((item) => item.action === "responder.disabled" && item.reason === "maintenance window")).toBe(true);
    expect(audit.body.items.some((item) => item.action === "hotline.disabled" && item.reason === "quality regression")).toBe(true);
    expect(audit.body.items.some((item) => item.action === "hotline.rejected" && item.reason === "schema issues")).toBe(true);

    const filteredResponders = await jsonRequest(baseUrl, "/v2/admin/responders?q=foxlab&limit=1", {
      headers: adminAuth
    });
    expect(filteredResponders.status).toBe(200);
    expect(filteredResponders.body.items).toHaveLength(1);
    expect(filteredResponders.body.pagination.total).toBeGreaterThanOrEqual(1);

    const filteredHotlines = await jsonRequest(baseUrl, "/v2/admin/hotlines?responder_id=responder_foxlab&status=enabled", {
      headers: adminAuth
    });
    expect(filteredHotlines.status).toBe(200);
    expect(filteredHotlines.body.items.every((item) => item.responder_id === "responder_foxlab")).toBe(true);
    expect(filteredHotlines.body.items.some((item) => item.review_status === "approved")).toBe(true);

    const filteredRequests = await jsonRequest(baseUrl, "/v1/admin/requests?caller_id=" + caller.body.user_id, {
      headers: adminAuth
    });
    expect(filteredRequests.status).toBe(200);
    expect(filteredRequests.body.items.some((item) => item.request_id === "req_admin_view_1")).toBe(true);

    const filteredAudit = await jsonRequest(baseUrl, "/v1/admin/audit-events?action=responder.disabled", {
      headers: adminAuth
    });
    expect(filteredAudit.status).toBe(200);
    expect(filteredAudit.body.items.every((item) => item.action === "responder.disabled")).toBe(true);

    const reviews = await jsonRequest(baseUrl, "/v1/admin/reviews?review_status=approved", {
      headers: adminAuth
    });
    expect(reviews.status).toBe(200);
    expect(reviews.body.items.some((item) => item.target_id === "foxlab.text.classifier.v1")).toBe(true);
  });
  it("supports batched request event reads", async () => {
    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-batch-events@test.local" }
    });
    const callerAuth = {
      Authorization: `Bearer ${caller.body.api_key}`
    };
    const responder = state.bootstrap.responders[0];
    const responderAuth = {
      Authorization: `Bearer ${responder.api_key}`
    };
    const requestIds = ["req_batch_events_1", "req_batch_events_2"];

    for (const requestId of requestIds) {
      const issued = await jsonRequest(baseUrl, "/v1/tokens/task", {
        method: "POST",
        headers: callerAuth,
        body: {
          request_id: requestId,
          responder_id: responder.responder_id,
          hotline_id: responder.hotline_id
        }
      });
      expect(issued.status).toBe(201);

      const acked = await jsonRequest(baseUrl, `/v1/requests/${requestId}/ack`, {
        method: "POST",
        headers: responderAuth,
        body: {
          responder_id: responder.responder_id,
          hotline_id: responder.hotline_id,
          eta_hint_s: 5
        }
      });
      expect(acked.status).toBe(202);
    }

    const completed = await jsonRequest(baseUrl, `/v1/requests/${requestIds[0]}/events`, {
      method: "POST",
      headers: responderAuth,
      body: {
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id,
        event_type: "COMPLETED",
        status: "ok",
        finished_at: "2026-03-18T10:00:00.000Z"
      }
    });
    expect(completed.status).toBe(202);

    const batch = await jsonRequest(baseUrl, "/v1/requests/events/batch", {
      method: "POST",
      headers: callerAuth,
      body: {
        request_ids: [...requestIds, "req_batch_events_missing"]
      }
    });
    expect(batch.status).toBe(200);

    const byRequestId = new Map(batch.body.items.map((item) => [item.request_id, item]));
    expect(byRequestId.get(requestIds[0]).found).toBe(true);
    expect(byRequestId.get(requestIds[0]).events.some((event) => event.event_type === "ACKED")).toBe(true);
    expect(byRequestId.get(requestIds[0]).events.some((event) => event.event_type === "COMPLETED")).toBe(true);
    expect(byRequestId.get(requestIds[1]).found).toBe(true);
    expect(byRequestId.get(requestIds[1]).events.some((event) => event.event_type === "ACKED")).toBe(true);
    expect(byRequestId.get("req_batch_events_missing").found).toBe(false);
  });

  it("rotates and revokes caller and responder credentials and preserves signing key history", async () => {
    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-credential-rotation@test.local" }
    });
    const responder = state.bootstrap.responders[0];
    const adminAuth = {
      Authorization: `Bearer ${state.adminApiKey}`
    };
    const callerAuth = {
      Authorization: `Bearer ${caller.body.api_key}`
    };
    const oldResponderApiKey = responder.api_key;

    const rotateCaller = await jsonRequest(baseUrl, `/v1/admin/users/${caller.body.user_id}/api-keys/rotate`, {
      method: "POST",
      headers: adminAuth,
      body: {}
    });
    expect(rotateCaller.status).toBe(200);
    expect(rotateCaller.body.api_key).not.toBe(caller.body.api_key);

    const oldCallerDenied = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: callerAuth,
      body: {
        request_id: "req_old_caller_key_denied",
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id
      }
    });
    expect(oldCallerDenied.status).toBe(401);

    const newCallerAuth = {
      Authorization: `Bearer ${rotateCaller.body.api_key}`
    };
    const issued = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: newCallerAuth,
      body: {
        request_id: "req_rotated_keys_1",
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id
      }
    });
    expect(issued.status).toBe(201);

    const rotateResponder = await jsonRequest(baseUrl, `/v2/admin/responders/${responder.responder_id}/api-keys/rotate`, {
      method: "POST",
      headers: adminAuth,
      body: {}
    });
    expect(rotateResponder.status).toBe(200);
    expect(rotateResponder.body.api_key).not.toBe(oldResponderApiKey);

    const oldResponderDenied = await jsonRequest(baseUrl, "/v1/tokens/introspect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oldResponderApiKey}`
      },
      body: {
        task_token: issued.body.task_token
      }
    });
    expect(oldResponderDenied.status).toBe(401);

    const newResponderAllowed = await jsonRequest(baseUrl, "/v1/tokens/introspect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rotateResponder.body.api_key}`
      },
      body: {
        task_token: issued.body.task_token
      }
    });
    expect(newResponderAllowed.status).toBe(200);
    expect(newResponderAllowed.body.active).toBe(true);

    const nextSigningPair = crypto.generateKeyPairSync("ed25519");
    const nextPublicKeyPem = nextSigningPair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const rotateSigning = await jsonRequest(baseUrl, `/v2/admin/responders/${responder.responder_id}/signing-keys/rotate`, {
      method: "POST",
      headers: adminAuth,
      body: {
        responder_public_key_pem: nextPublicKeyPem,
        rotation_window_until: "2026-04-01T00:00:00.000Z"
      }
    });
    expect(rotateSigning.status).toBe(200);
    expect(rotateSigning.body.responder_public_key_pem).toBe(nextPublicKeyPem);
    expect(rotateSigning.body.responder_public_keys_pem).toContain(nextPublicKeyPem);
    expect(rotateSigning.body.responder_public_keys_pem).toContain(responder.signing.publicKeyPem);
    expect(state.catalog.get(responder.hotline_id).responder_public_key_pem).toBe(nextPublicKeyPem);

    const revokeCaller = await jsonRequest(baseUrl, "/v1/admin/api-keys/revoke", {
      method: "POST",
      headers: adminAuth,
      body: {
        api_key: rotateCaller.body.api_key
      }
    });
    expect(revokeCaller.status).toBe(200);
    expect(revokeCaller.body.revoked).toBe(true);

    const revokedCallerDenied = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: newCallerAuth,
      body: {
        request_id: "req_revoked_caller_key_denied",
        responder_id: responder.responder_id,
        hotline_id: responder.hotline_id
      }
    });
    expect(revokedCallerDenied.status).toBe(401);
  });

  it("keeps task tokens introspectable across restarts when TOKEN_SECRET stays stable", async () => {
    const secret = "integration-stable-token-secret";
    const firstState = createPlatformState({
      tokenSecret: secret,
      adminApiKey: "sk_admin_first_state"
    });
    const firstServer = createPlatformServer({
      serviceName: "platform-token-secret-first",
      state: firstState
    });
    const firstUrl = await listenServer(firstServer);

    try {
      const caller = await jsonRequest(firstUrl, "/v1/users/register", {
        method: "POST",
        body: { contact_email: "integration-stable-token@test.local" }
      });
      const responder = firstState.bootstrap.responders[0];
      const issued = await jsonRequest(firstUrl, "/v1/tokens/task", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${caller.body.api_key}`
        },
        body: {
          request_id: "req_stable_token_restart_1",
          responder_id: responder.responder_id,
          hotline_id: responder.hotline_id
        }
      });
      expect(issued.status).toBe(201);

      const secondState = createPlatformState({
        tokenSecret: secret,
        adminApiKey: "sk_admin_second_state"
      });
      const secondServer = createPlatformServer({
        serviceName: "platform-token-secret-second",
        state: secondState
      });
      const secondUrl = await listenServer(secondServer);

      try {
        const introspect = await jsonRequest(secondUrl, "/v1/tokens/introspect", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secondState.bootstrap.responders[0].api_key}`
          },
          body: {
            task_token: issued.body.task_token
          }
        });
        expect(introspect.status).toBe(200);
        expect(introspect.body.active).toBe(true);
        expect(introspect.body.claims.request_id).toBe("req_stable_token_restart_1");
      } finally {
        await closeServer(secondServer);
      }
    } finally {
      await closeServer(firstServer);
    }
  });

  it("enforces public rate limits and protects prometheus metrics with a bearer token", async () => {
    const previousWindow = process.env.PUBLIC_RATE_LIMIT_WINDOW_MS;
    const previousRegisterLimit = process.env.PUBLIC_RATE_LIMIT_REGISTER_USER_MAX;
    const previousMetricsToken = process.env.PROMETHEUS_METRICS_BEARER_TOKEN;
    process.env.PUBLIC_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.PUBLIC_RATE_LIMIT_REGISTER_USER_MAX = "1";
    process.env.PROMETHEUS_METRICS_BEARER_TOKEN = "metrics-integration-token";

    const limitedState = createPlatformState({
      adminApiKey: "sk_admin_limited_state"
    });
    const limitedServer = createPlatformServer({
      serviceName: "platform-rate-limit-test",
      state: limitedState
    });
    const limitedUrl = await listenServer(limitedServer);

    try {
      const firstRegister = await jsonRequest(limitedUrl, "/v1/users/register", {
        method: "POST",
        body: { contact_email: "integration-rate-limit-1@test.local" }
      });
      expect(firstRegister.status).toBe(201);

      const secondRegister = await jsonRequest(limitedUrl, "/v1/users/register", {
        method: "POST",
        body: { contact_email: "integration-rate-limit-2@test.local" }
      });
      expect(secondRegister.status).toBe(429);
      expect(secondRegister.body.error.code).toBe("RATE_LIMITED");

      const metricsDenied = await fetch(`${limitedUrl}/metrics`);
      expect(metricsDenied.status).toBe(401);

      const metricsAllowed = await fetch(`${limitedUrl}/metrics`, {
        headers: {
          Authorization: "Bearer metrics-integration-token"
        }
      });
      expect(metricsAllowed.status).toBe(200);
      expect(await metricsAllowed.text()).toContain("rsp_platform_requests_total");
    } finally {
      await closeServer(limitedServer);
      if (previousWindow === undefined) {
        delete process.env.PUBLIC_RATE_LIMIT_WINDOW_MS;
      } else {
        process.env.PUBLIC_RATE_LIMIT_WINDOW_MS = previousWindow;
      }
      if (previousRegisterLimit === undefined) {
        delete process.env.PUBLIC_RATE_LIMIT_REGISTER_USER_MAX;
      } else {
        process.env.PUBLIC_RATE_LIMIT_REGISTER_USER_MAX = previousRegisterLimit;
      }
      if (previousMetricsToken === undefined) {
        delete process.env.PROMETHEUS_METRICS_BEARER_TOKEN;
      } else {
        process.env.PROMETHEUS_METRICS_BEARER_TOKEN = previousMetricsToken;
      }
    }
  });
});
