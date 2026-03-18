import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { createSellerControllerServer, createSellerState } from "@delexec/seller-controller";
import { createRelayServer } from "@delexec/transport-relay";
import { createRelayHttpTransportAdapter } from "@delexec/transport-relay-http";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

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

    const catalog = await jsonRequest(baseUrl, "/v1/catalog/subagents?status=enabled");
    expect(catalog.status).toBe(200);
    expect(catalog.body.items.length).toBeGreaterThan(0);

    const selected = catalog.body.items[0];

    const tokenRes = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: auth,
      body: {
        request_id: "req_integration_platform_1",
        seller_id: selected.seller_id,
        subagent_id: selected.subagent_id
      }
    });
    expect(tokenRes.status).toBe(201);
    expect(tokenRes.body.task_token).toBeTruthy();
    expect(tokenRes.body.claims).toMatchObject({
      request_id: "req_integration_platform_1",
      seller_id: selected.seller_id,
      subagent_id: selected.subagent_id,
      aud: selected.seller_id
    });
    expect(typeof tokenRes.body.claims.exp).toBe("number");

    const sellerAuth = {
      Authorization: `Bearer ${state.bootstrap.sellers.find((item) => item.seller_id === selected.seller_id).api_key}`
    };
    const introspect = await jsonRequest(baseUrl, "/v1/tokens/introspect", {
      method: "POST",
      headers: sellerAuth,
      body: { task_token: tokenRes.body.task_token }
    });
    expect(introspect.status).toBe(200);
    expect(introspect.body.active).toBe(true);

    const template = await jsonRequest(
      baseUrl,
      `/v1/catalog/subagents/${selected.subagent_id}/template-bundle?template_ref=${encodeURIComponent(selected.template_ref)}`
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
        seller_id: "seller_foxlab",
        subagent_id: "foxlab.text.classifier.v1"
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
    const before = await jsonRequest(baseUrl, "/v1/catalog/subagents?availability_status=healthy");
    expect(before.status).toBe(200);
    expect(before.body.items.length).toBeGreaterThan(0);

    const target = before.body.items[0];
    const sellerAuth = {
      Authorization: `Bearer ${state.bootstrap.sellers.find((item) => item.seller_id === target.seller_id).api_key}`
    };
    const heartbeat = await jsonRequest(baseUrl, `/v1/sellers/${target.seller_id}/heartbeat`, {
      method: "POST",
      headers: sellerAuth,
      body: { status: "degraded" }
    });
    expect(heartbeat.status).toBe(202);

    const degraded = await jsonRequest(baseUrl, "/v1/catalog/subagents?availability_status=degraded");
    expect(degraded.status).toBe(200);
    expect(degraded.body.items.some((item) => item.seller_id === target.seller_id)).toBe(true);
  });

  it("enforces request ownership and keeps ACK idempotent", async () => {
    const buyerOne = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-owner-1@test.local" }
    });
    const buyerTwo = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-owner-2@test.local" }
    });
    const requestId = "req_request_ownership_1";
    const seller = state.bootstrap.sellers[0];

    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: { Authorization: `Bearer ${buyerOne.body.api_key}` },
      body: {
        request_id: requestId,
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id
      }
    });
    expect(token.status).toBe(201);

    const deliveryMeta = await jsonRequest(baseUrl, `/v1/requests/${requestId}/delivery-meta`, {
      method: "POST",
      headers: { Authorization: `Bearer ${buyerOne.body.api_key}` },
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        task_token: token.body.task_token,
        result_delivery: {
          kind: "local",
          address: "buyer-controller"
        }
      }
    });
    expect(deliveryMeta.status).toBe(200);
    expect(deliveryMeta.body.task_delivery.address.startsWith("local://")).toBe(true);
    expect(deliveryMeta.body.result_delivery.address).toBe("buyer-controller");
    expect(deliveryMeta.body.verification.display_code).toBeTypeOf("string");

    const foreignEvents = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      headers: { Authorization: `Bearer ${buyerTwo.body.api_key}` }
    });
    expect(foreignEvents.status).toBe(403);
    expect(foreignEvents.body.error.code).toBe("AUTH_RESOURCE_FORBIDDEN");

    const foreignDeliveryMeta = await jsonRequest(baseUrl, `/v1/requests/${requestId}/delivery-meta`, {
      method: "POST",
      headers: { Authorization: `Bearer ${buyerTwo.body.api_key}` },
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        result_delivery: {
          kind: "local",
          address: "buyer-controller"
        }
      }
    });
    expect(foreignDeliveryMeta.status).toBe(403);
    expect(foreignDeliveryMeta.body.error.code).toBe("AUTH_RESOURCE_FORBIDDEN");

    const sellerAuth = {
      Authorization: `Bearer ${state.bootstrap.sellers.find((item) => item.seller_id === seller.seller_id).api_key}`
    };
    const firstAck = await jsonRequest(baseUrl, `/v1/requests/${requestId}/ack`, {
      method: "POST",
      headers: sellerAuth,
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        eta_hint_s: 2
      }
    });
    expect(firstAck.status).toBe(202);

    const secondAck = await jsonRequest(baseUrl, `/v1/requests/${requestId}/ack`, {
      method: "POST",
      headers: sellerAuth,
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        eta_hint_s: 3
      }
    });
    expect(secondAck.status).toBe(202);

    const events = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      headers: { Authorization: `Bearer ${buyerOne.body.api_key}` }
    });
    expect(events.status).toBe(200);
    expect(events.body.events.filter((event) => event.event_type === "ACKED")).toHaveLength(1);
  });

  it("allows seller to append COMPLETED and FAILED request events idempotently", async () => {
    const buyer = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-request-events@test.local" }
    });
    const seller = state.bootstrap.sellers[0];
    const sellerAuth = {
      Authorization: `Bearer ${state.bootstrap.sellers.find((item) => item.seller_id === seller.seller_id).api_key}`
    };
    const buyerAuth = {
      Authorization: `Bearer ${buyer.body.api_key}`
    };
    const requestId = "req_request_events_1";

    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: buyerAuth,
      body: {
        request_id: requestId,
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id
      }
    });
    expect(token.status).toBe(201);

    const deliveryMeta = await jsonRequest(baseUrl, `/v1/requests/${requestId}/delivery-meta`, {
      method: "POST",
      headers: buyerAuth,
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        task_token: token.body.task_token,
        result_delivery: {
          kind: "local",
          address: "buyer-controller"
        }
      }
    });
    expect(deliveryMeta.status).toBe(200);

    const completed = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      method: "POST",
      headers: sellerAuth,
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        event_type: "COMPLETED",
        status: "ok",
        finished_at: "2026-03-11T10:00:00Z"
      }
    });
    expect(completed.status).toBe(202);
    expect(completed.body.event.event_type).toBe("COMPLETED");

    const completedAgain = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      method: "POST",
      headers: sellerAuth,
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
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
      headers: buyerAuth,
      body: {
        request_id: failedRequestId,
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id
      }
    });
    expect(failedToken.status).toBe(201);

    await jsonRequest(baseUrl, `/v1/requests/${failedRequestId}/delivery-meta`, {
      method: "POST",
      headers: buyerAuth,
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        task_token: failedToken.body.task_token,
        result_delivery: {
          kind: "local",
          address: "buyer-controller"
        }
      }
    });

    const failed = await jsonRequest(baseUrl, `/v1/requests/${failedRequestId}/events`, {
      method: "POST",
      headers: sellerAuth,
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        event_type: "FAILED",
        status: "error",
        error_code: "EXEC_INTERNAL_ERROR",
        finished_at: "2026-03-11T10:01:00Z"
      }
    });
    expect(failed.status).toBe(202);
    expect(failed.body.event.error_code).toBe("EXEC_INTERNAL_ERROR");

    const events = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      headers: buyerAuth
    });
    expect(events.status).toBe(200);
    expect(events.body.events.filter((event) => event.event_type === "COMPLETED")).toHaveLength(1);
  });

  it("rejects request event writes from non-seller callers and mismatched bindings", async () => {
    const buyer = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-request-events-auth@test.local" }
    });
    const seller = state.bootstrap.sellers[0];
    const sellerAuth = {
      Authorization: `Bearer ${state.bootstrap.sellers.find((item) => item.seller_id === seller.seller_id).api_key}`
    };
    const buyerAuth = {
      Authorization: `Bearer ${buyer.body.api_key}`
    };
    const requestId = "req_request_events_auth_1";

    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: buyerAuth,
      body: {
        request_id: requestId,
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id
      }
    });
    expect(token.status).toBe(201);

    await jsonRequest(baseUrl, `/v1/requests/${requestId}/delivery-meta`, {
      method: "POST",
      headers: buyerAuth,
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        task_token: token.body.task_token,
        result_delivery: {
          kind: "local",
          address: "buyer-controller"
        }
      }
    });

    const buyerWrite = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      method: "POST",
      headers: buyerAuth,
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        event_type: "COMPLETED"
      }
    });
    expect(buyerWrite.status).toBe(403);
    expect(buyerWrite.body.error.code).toBe("AUTH_SCOPE_FORBIDDEN");

    const mismatch = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      method: "POST",
      headers: sellerAuth,
      body: {
        seller_id: seller.seller_id,
        subagent_id: "wrong.agent.v1",
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
          seller_id: "seller_foxlab",
          subagent_id: "foxlab.text.classifier.v1"
        }
      });
      expect(issue.status).toBe(201);

      await new Promise((resolve) => setTimeout(resolve, 1200));

      const sellerAuth = {
        Authorization: `Bearer ${state.bootstrap.sellers.find((item) => item.seller_id === "seller_foxlab").api_key}`
      };
      const introspect = await jsonRequest(baseUrl, "/v1/tokens/introspect", {
        method: "POST",
        headers: sellerAuth,
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
    const buyer = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-platform-inbox@test.local" }
    });
    const seller = state.bootstrap.sellers[0];

    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: { Authorization: `Bearer ${buyer.body.api_key}` },
      body: {
        request_id: "req_platform_inbox_1",
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id
      }
    });
    expect(token.status).toBe(201);

    const deliveryMeta = await jsonRequest(baseUrl, "/v1/requests/req_platform_inbox_1/delivery-meta", {
      method: "POST",
      headers: { Authorization: `Bearer ${buyer.body.api_key}` },
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
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
      { method: "POST", path: "/v1/sellers/seller_foxlab/heartbeat", body: { status: "healthy" } }
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

  it("registers seller identities and filters catalog by capability", async () => {
    const registered = await jsonRequest(baseUrl, "/v1/sellers/register", {
      method: "POST",
      body: {
        seller_id: "seller_legalworks",
        subagent_id: "legalworks.contract.extractor.v1",
        display_name: "LegalWorks Contract Extractor",
        seller_public_key_pem: state.bootstrap.sellers[0].signing.publicKeyPem,
        task_types: ["contract_extract"],
        capabilities: ["contract.extract", "legal.review"],
        tags: ["legal", "contracts"]
      }
    });
    expect(registered.status).toBe(201);
    expect(registered.body.api_key).toMatch(/^sk_seller_/);

    expect(registered.body.status).toBe("disabled");
    expect(registered.body.review_status).toBe("pending");
    expect(registered.body.seller_review_status).toBe("pending");
    expect(registered.body.subagent_review_status).toBe("pending");
    expect(registered.body.catalog_visibility).toBe("hidden");

    const filteredBeforeApproval = await jsonRequest(baseUrl, "/v1/catalog/subagents?capability=contract.extract");
    expect(filteredBeforeApproval.status).toBe(200);
    expect(filteredBeforeApproval.body.items).toHaveLength(0);

    const buyer = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "pending-seller-buyer@test.local" }
    });
    const tokenBeforeApproval = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${buyer.body.api_key}`
      },
      body: {
        request_id: "req_pending_seller_1",
        seller_id: "seller_legalworks",
        subagent_id: "legalworks.contract.extractor.v1"
      }
    });
    expect(tokenBeforeApproval.status).toBe(404);
    expect(tokenBeforeApproval.body.error.code).toBe("CATALOG_SUBAGENT_NOT_FOUND");

    const approved = await jsonRequest(baseUrl, "/v1/admin/subagents/legalworks.contract.extractor.v1/approve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.adminApiKey}`
      },
      body: {
        reason: "initial review passed"
      }
    });
    expect(approved.status).toBe(200);

    const filteredAfterSubagentOnly = await jsonRequest(baseUrl, "/v1/catalog/subagents?capability=contract.extract");
    expect(filteredAfterSubagentOnly.status).toBe(200);
    expect(filteredAfterSubagentOnly.body.items).toHaveLength(0);

    const approveSeller = await jsonRequest(baseUrl, "/v1/admin/sellers/seller_legalworks/approve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.adminApiKey}`
      },
      body: {
        reason: "seller review passed"
      }
    });
    expect(approveSeller.status).toBe(200);

    const filtered = await jsonRequest(baseUrl, "/v1/catalog/subagents?capability=contract.extract");
    expect(filtered.status).toBe(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0]).toMatchObject({
      seller_id: "seller_legalworks",
      subagent_id: "legalworks.contract.extractor.v1"
    });

    const publicDetail = await jsonRequest(baseUrl, "/v1/catalog/subagents/legalworks.contract.extractor.v1");
    expect(publicDetail.status).toBe(200);
    expect(publicDetail.body.catalog_visibility).toBe("public");

    const tagged = await jsonRequest(baseUrl, "/v1/catalog/subagents?tag=legal");
    expect(tagged.status).toBe(200);
    expect(tagged.body.items.some((item) => item.subagent_id === "legalworks.contract.extractor.v1")).toBe(true);
  });

  it("allows a buyer to add the seller role on the same user", async () => {
    const buyer = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "dual-role@test.local" }
    });
    expect(buyer.status).toBe(201);

    const registered = await jsonRequest(baseUrl, "/v1/sellers/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${buyer.body.api_key}`
      },
      body: {
        seller_id: "seller_dual_role",
        subagent_id: "dual.role.v1",
        display_name: "Dual Role Seller",
        seller_public_key_pem: state.bootstrap.sellers[0].signing.publicKeyPem
      }
    });
    expect(registered.status).toBe(201);
    expect(registered.body.owner_user_id).toBe(buyer.body.user_id);
    expect(state.users.get(buyer.body.user_id).roles).toEqual(["buyer", "seller"]);
    expect(registered.body.review_status).toBe("pending");
  });

  it("allows an existing seller to append a second subagent", async () => {
    const buyer = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "multi-subagent@test.local" }
    });

    const first = await jsonRequest(baseUrl, "/v1/sellers/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${buyer.body.api_key}`
      },
      body: {
        seller_id: "seller_multi",
        subagent_id: "multi.first.v1",
        display_name: "First Subagent",
        seller_public_key_pem: state.bootstrap.sellers[0].signing.publicKeyPem
      }
    });
    expect(first.status).toBe(201);

    const second = await jsonRequest(baseUrl, "/v1/sellers/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${first.body.api_key}`
      },
      body: {
        seller_id: "seller_multi",
        subagent_id: "multi.second.v1",
        display_name: "Second Subagent",
        seller_public_key_pem: state.bootstrap.sellers[0].signing.publicKeyPem,
        capabilities: ["text.summarize"]
      }
    });
    expect(second.status).toBe(201);
    expect(second.body.api_key).toBe(first.body.api_key);
    expect(state.sellers.get("seller_multi").subagent_ids).toEqual(["multi.first.v1", "multi.second.v1"]);
    expect(state.apiKeys.get(first.body.api_key).subagent_ids).toEqual(["multi.first.v1", "multi.second.v1"]);
    expect(second.body.review_status).toBe("pending");
  });

  it("supports formal onboarding details and hidden admin review tests over relay transport", async () => {
    const previousReviewTransportBaseUrl = process.env.REVIEW_TRANSPORT_BASE_URL;
    const relayServer = createRelayServer({ serviceName: "platform-review-relay-test" });
    const relayUrl = await listenServer(relayServer);
    process.env.REVIEW_TRANSPORT_BASE_URL = relayUrl;

    const buyer = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "review-owner@test.local" }
    });
    const buyerAuth = {
      Authorization: `Bearer ${buyer.body.api_key}`
    };

    const onboarding = await jsonRequest(baseUrl, "/v1/catalog/subagents", {
      method: "POST",
      headers: buyerAuth,
      body: {
        seller_id: "seller_review_probe",
        subagent_id: "review.probe.v1",
        display_name: "Review Probe",
        seller_public_key_pem: state.bootstrap.sellers[0].signing.publicKeyPem,
        capabilities: ["text.summarize"],
        task_types: ["text_summarize"]
      }
    });
    expect(onboarding.status).toBe(201);
    expect(onboarding.body.seller_review_status).toBe("pending");
    expect(onboarding.body.subagent_review_status).toBe("pending");
    expect(onboarding.body.catalog_visibility).toBe("hidden");

    const publicDetailBeforeApproval = await jsonRequest(baseUrl, "/v1/catalog/subagents/review.probe.v1");
    expect(publicDetailBeforeApproval.status).toBe(404);

    const ownerDetail = await jsonRequest(baseUrl, "/v1/catalog/subagents/review.probe.v1", {
      headers: buyerAuth
    });
    expect(ownerDetail.status).toBe(200);
    expect(ownerDetail.body.submission.submission_version).toBe(1);
    expect(ownerDetail.body.catalog_visibility).toBe("hidden");

    const sellerServer = createSellerControllerServer({
      serviceName: "platform-review-seller-test",
      state: createSellerState({
        sellerId: "seller_review_probe",
        subagentIds: ["review.probe.v1"],
        signing: state.bootstrap.sellers[0].signing
      }),
      transport: createRelayHttpTransportAdapter({
        baseUrl: relayUrl,
        receiver: "seller_review_probe"
      }),
      platform: {
        baseUrl,
        apiKey: onboarding.body.seller_api_key,
        sellerId: "seller_review_probe"
      },
      background: {
        enabled: true,
        receiver: "seller_review_probe",
        inboxPollIntervalMs: 20
      }
    });
    await listenServer(sellerServer);

    try {
      const reviewTest = await jsonRequest(baseUrl, "/v1/admin/subagents/review.probe.v1/review-tests", {
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

      const reviewTestList = await jsonRequest(baseUrl, "/v1/admin/review-tests?subagent_id=review.probe.v1", {
        headers: {
          Authorization: `Bearer ${state.adminApiKey}`
        }
      });
      expect(reviewTestList.status).toBe(200);
      expect(reviewTestList.body.items[0].verdict).toBe("pass");

      const adminSubagentDetail = await jsonRequest(baseUrl, "/v1/catalog/subagents/review.probe.v1", {
        headers: {
          Authorization: `Bearer ${state.adminApiKey}`
        }
      });
      expect(adminSubagentDetail.status).toBe(200);
      expect(adminSubagentDetail.body.latest_review_test.verdict).toBe("pass");
    } finally {
      await closeServer(sellerServer);
      await closeServer(relayServer);
      if (previousReviewTransportBaseUrl === undefined) {
        delete process.env.REVIEW_TRANSPORT_BASE_URL;
      } else {
        process.env.REVIEW_TRANSPORT_BASE_URL = previousReviewTransportBaseUrl;
      }
    }
  });

  it("serves admin seller, subagent, and request views and allows status actions", async () => {
    const buyer = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "platform-admin@test.local" }
    });
    const buyerAuth = {
      Authorization: `Bearer ${buyer.body.api_key}`
    };
    const adminAuth = {
      Authorization: `Bearer ${state.adminApiKey}`
    };

    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: buyerAuth,
      body: {
        request_id: "req_admin_view_1",
        seller_id: "seller_foxlab",
        subagent_id: "foxlab.text.classifier.v1"
      }
    });
    expect(token.status).toBe(201);

    const forbidden = await jsonRequest(baseUrl, "/v1/admin/sellers", {
      headers: buyerAuth
    });
    expect(forbidden.status).toBe(403);

    const sellers = await jsonRequest(baseUrl, "/v1/admin/sellers", {
      headers: adminAuth
    });
    expect(sellers.status).toBe(200);
    expect(sellers.body.items.some((item) => item.seller_id === "seller_foxlab")).toBe(true);

    const subagents = await jsonRequest(baseUrl, "/v1/admin/subagents", {
      headers: adminAuth
    });
    expect(subagents.status).toBe(200);
    expect(subagents.body.items.some((item) => item.subagent_id === "foxlab.text.classifier.v1")).toBe(true);

    const requests = await jsonRequest(baseUrl, "/v1/admin/requests", {
      headers: adminAuth
    });
    expect(requests.status).toBe(200);
    expect(requests.body.items.some((item) => item.request_id === "req_admin_view_1")).toBe(true);

    const grant = await jsonRequest(baseUrl, `/v1/admin/users/${buyer.body.user_id}/roles`, {
      method: "POST",
      headers: adminAuth,
      body: {
        role: "admin"
      }
    });
    expect(grant.status).toBe(200);
    expect(grant.body.roles).toContain("admin");

    const delegated = await jsonRequest(baseUrl, "/v1/admin/sellers", {
      headers: buyerAuth
    });
    expect(delegated.status).toBe(200);

    const disableSubagent = await jsonRequest(baseUrl, "/v1/admin/subagents/foxlab.text.classifier.v1/disable", {
      method: "POST",
      headers: adminAuth,
      body: { reason: "quality regression" }
    });
    expect(disableSubagent.status).toBe(200);
    expect(state.catalog.get("foxlab.text.classifier.v1").status).toBe("disabled");

    const approveSubagent = await jsonRequest(baseUrl, "/v1/admin/subagents/foxlab.text.classifier.v1/approve", {
      method: "POST",
      headers: adminAuth
    });
    expect(approveSubagent.status).toBe(200);
    expect(state.catalog.get("foxlab.text.classifier.v1").status).toBe("enabled");

    const disableSeller = await jsonRequest(baseUrl, "/v1/admin/sellers/seller_foxlab/disable", {
      method: "POST",
      headers: adminAuth,
      body: { reason: "maintenance window" }
    });
    expect(disableSeller.status).toBe(200);
    expect(state.sellers.get("seller_foxlab").status).toBe("disabled");
    expect(state.catalog.get("foxlab.text.classifier.v1").status).toBe("enabled");

    const approveSeller = await jsonRequest(baseUrl, "/v1/admin/sellers/seller_foxlab/approve", {
      method: "POST",
      headers: adminAuth,
      body: { reason: "maintenance complete" }
    });
    expect(approveSeller.status).toBe(200);
    expect(state.sellers.get("seller_foxlab").status).toBe("enabled");
    expect(state.catalog.get("foxlab.text.classifier.v1").status).toBe("enabled");

    const rejectSubagent = await jsonRequest(baseUrl, "/v1/admin/subagents/foxlab.text.classifier.v1/reject", {
      method: "POST",
      headers: adminAuth,
      body: { reason: "schema issues" }
    });
    expect(rejectSubagent.status).toBe(200);
    expect(state.catalog.get("foxlab.text.classifier.v1").status).toBe("disabled");

    const reapproveSubagent = await jsonRequest(baseUrl, "/v1/admin/subagents/foxlab.text.classifier.v1/approve", {
      method: "POST",
      headers: adminAuth,
      body: { reason: "schema fixed" }
    });
    expect(reapproveSubagent.status).toBe(200);
    expect(state.catalog.get("foxlab.text.classifier.v1").status).toBe("enabled");

    const audit = await jsonRequest(baseUrl, "/v1/admin/audit-events?limit=10", {
      headers: adminAuth
    });
    expect(audit.status).toBe(200);
    expect(audit.body.items.some((item) => item.action === "user.role.granted" && item.target_id === buyer.body.user_id)).toBe(true);
    expect(audit.body.items.some((item) => item.action === "seller.disabled" && item.reason === "maintenance window")).toBe(true);
    expect(audit.body.items.some((item) => item.action === "subagent.disabled" && item.reason === "quality regression")).toBe(true);
    expect(audit.body.items.some((item) => item.action === "subagent.rejected" && item.reason === "schema issues")).toBe(true);

    const filteredSellers = await jsonRequest(baseUrl, "/v1/admin/sellers?q=foxlab&limit=1", {
      headers: adminAuth
    });
    expect(filteredSellers.status).toBe(200);
    expect(filteredSellers.body.items).toHaveLength(1);
    expect(filteredSellers.body.pagination.total).toBeGreaterThanOrEqual(1);

    const filteredSubagents = await jsonRequest(baseUrl, "/v1/admin/subagents?seller_id=seller_foxlab&status=enabled", {
      headers: adminAuth
    });
    expect(filteredSubagents.status).toBe(200);
    expect(filteredSubagents.body.items.every((item) => item.seller_id === "seller_foxlab")).toBe(true);
    expect(filteredSubagents.body.items.some((item) => item.review_status === "approved")).toBe(true);

    const filteredRequests = await jsonRequest(baseUrl, "/v1/admin/requests?buyer_id=" + buyer.body.user_id, {
      headers: adminAuth
    });
    expect(filteredRequests.status).toBe(200);
    expect(filteredRequests.body.items.some((item) => item.request_id === "req_admin_view_1")).toBe(true);

    const filteredAudit = await jsonRequest(baseUrl, "/v1/admin/audit-events?action=seller.disabled", {
      headers: adminAuth
    });
    expect(filteredAudit.status).toBe(200);
    expect(filteredAudit.body.items.every((item) => item.action === "seller.disabled")).toBe(true);

    const reviews = await jsonRequest(baseUrl, "/v1/admin/reviews?review_status=approved", {
      headers: adminAuth
    });
    expect(reviews.status).toBe(200);
    expect(reviews.body.items.some((item) => item.target_id === "foxlab.text.classifier.v1")).toBe(true);
  });
  it("supports batched request event reads", async () => {
    const buyer = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-batch-events@test.local" }
    });
    const buyerAuth = {
      Authorization: `Bearer ${buyer.body.api_key}`
    };
    const seller = state.bootstrap.sellers[0];
    const sellerAuth = {
      Authorization: `Bearer ${seller.api_key}`
    };
    const requestIds = ["req_batch_events_1", "req_batch_events_2"];

    for (const requestId of requestIds) {
      const issued = await jsonRequest(baseUrl, "/v1/tokens/task", {
        method: "POST",
        headers: buyerAuth,
        body: {
          request_id: requestId,
          seller_id: seller.seller_id,
          subagent_id: seller.subagent_id
        }
      });
      expect(issued.status).toBe(201);

      const acked = await jsonRequest(baseUrl, `/v1/requests/${requestId}/ack`, {
        method: "POST",
        headers: sellerAuth,
        body: {
          seller_id: seller.seller_id,
          subagent_id: seller.subagent_id,
          eta_hint_s: 5
        }
      });
      expect(acked.status).toBe(202);
    }

    const completed = await jsonRequest(baseUrl, `/v1/requests/${requestIds[0]}/events`, {
      method: "POST",
      headers: sellerAuth,
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        event_type: "COMPLETED",
        status: "ok",
        finished_at: "2026-03-18T10:00:00.000Z"
      }
    });
    expect(completed.status).toBe(202);

    const batch = await jsonRequest(baseUrl, "/v1/requests/events/batch", {
      method: "POST",
      headers: buyerAuth,
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

  it("rotates and revokes buyer and seller credentials and preserves signing key history", async () => {
    const buyer = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-credential-rotation@test.local" }
    });
    const seller = state.bootstrap.sellers[0];
    const adminAuth = {
      Authorization: `Bearer ${state.adminApiKey}`
    };
    const buyerAuth = {
      Authorization: `Bearer ${buyer.body.api_key}`
    };
    const oldSellerApiKey = seller.api_key;

    const rotateBuyer = await jsonRequest(baseUrl, `/v1/admin/users/${buyer.body.user_id}/api-keys/rotate`, {
      method: "POST",
      headers: adminAuth,
      body: {}
    });
    expect(rotateBuyer.status).toBe(200);
    expect(rotateBuyer.body.api_key).not.toBe(buyer.body.api_key);

    const oldBuyerDenied = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: buyerAuth,
      body: {
        request_id: "req_old_buyer_key_denied",
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id
      }
    });
    expect(oldBuyerDenied.status).toBe(401);

    const newBuyerAuth = {
      Authorization: `Bearer ${rotateBuyer.body.api_key}`
    };
    const issued = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: newBuyerAuth,
      body: {
        request_id: "req_rotated_keys_1",
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id
      }
    });
    expect(issued.status).toBe(201);

    const rotateSeller = await jsonRequest(baseUrl, `/v1/admin/sellers/${seller.seller_id}/api-keys/rotate`, {
      method: "POST",
      headers: adminAuth,
      body: {}
    });
    expect(rotateSeller.status).toBe(200);
    expect(rotateSeller.body.api_key).not.toBe(oldSellerApiKey);

    const oldSellerDenied = await jsonRequest(baseUrl, "/v1/tokens/introspect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oldSellerApiKey}`
      },
      body: {
        task_token: issued.body.task_token
      }
    });
    expect(oldSellerDenied.status).toBe(401);

    const newSellerAllowed = await jsonRequest(baseUrl, "/v1/tokens/introspect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rotateSeller.body.api_key}`
      },
      body: {
        task_token: issued.body.task_token
      }
    });
    expect(newSellerAllowed.status).toBe(200);
    expect(newSellerAllowed.body.active).toBe(true);

    const nextSigningPair = crypto.generateKeyPairSync("ed25519");
    const nextPublicKeyPem = nextSigningPair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const rotateSigning = await jsonRequest(baseUrl, `/v1/admin/sellers/${seller.seller_id}/signing-keys/rotate`, {
      method: "POST",
      headers: adminAuth,
      body: {
        seller_public_key_pem: nextPublicKeyPem,
        rotation_window_until: "2026-04-01T00:00:00.000Z"
      }
    });
    expect(rotateSigning.status).toBe(200);
    expect(rotateSigning.body.seller_public_key_pem).toBe(nextPublicKeyPem);
    expect(rotateSigning.body.seller_public_keys_pem).toContain(nextPublicKeyPem);
    expect(rotateSigning.body.seller_public_keys_pem).toContain(seller.signing.publicKeyPem);
    expect(state.catalog.get(seller.subagent_id).seller_public_key_pem).toBe(nextPublicKeyPem);

    const revokeBuyer = await jsonRequest(baseUrl, "/v1/admin/api-keys/revoke", {
      method: "POST",
      headers: adminAuth,
      body: {
        api_key: rotateBuyer.body.api_key
      }
    });
    expect(revokeBuyer.status).toBe(200);
    expect(revokeBuyer.body.revoked).toBe(true);

    const revokedBuyerDenied = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: newBuyerAuth,
      body: {
        request_id: "req_revoked_buyer_key_denied",
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id
      }
    });
    expect(revokedBuyerDenied.status).toBe(401);
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
      const buyer = await jsonRequest(firstUrl, "/v1/users/register", {
        method: "POST",
        body: { contact_email: "integration-stable-token@test.local" }
      });
      const seller = firstState.bootstrap.sellers[0];
      const issued = await jsonRequest(firstUrl, "/v1/tokens/task", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer.body.api_key}`
        },
        body: {
          request_id: "req_stable_token_restart_1",
          seller_id: seller.seller_id,
          subagent_id: seller.subagent_id
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
            Authorization: `Bearer ${secondState.bootstrap.sellers[0].api_key}`
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
