// FR-002 controlled enrollment and FR-003 capability reporting. A device must
// not be able to join a private trust domain by asserting a display name, and
// the control plane must be able to answer "what version is it and how much
// can it take right now?".
import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

function signingPublicKey() {
  return crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
}

describe("device enrollment and capability reporting", () => {
  let server;
  let baseUrl;
  let state;
  let callerAuth;

  beforeEach(async () => {
    state = createPlatformState({ adminApiKey: "sk_admin_enrollment_test" });
    server = createPlatformServer({ serviceName: "device-enrollment-test", state });
    baseUrl = await listenServer(server);

    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "enrollment-owner@test.local" }
    });
    callerAuth = { Authorization: `Bearer ${caller.body.api_key}` };
  });

  afterEach(async () => {
    await closeServer(server);
  });

  function registrationBody(overrides = {}) {
    return {
      responder_id: "responder_enroll",
      hotline_id: "enroll.example.v1",
      display_name: "Enrollment Example",
      responder_public_key_pem: signingPublicKey(),
      capabilities: ["text.summarize"],
      ...overrides
    };
  }

  it("refuses anonymous enrollment", async () => {
    const response = await jsonRequest(baseUrl, "/v2/responders/register", {
      method: "POST",
      body: registrationBody()
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("AUTH_UNAUTHORIZED");
    expect(state.responders.has("responder_enroll")).toBe(false);
  });

  it("refuses an invalid credential rather than falling back to anonymous", async () => {
    const response = await jsonRequest(baseUrl, "/v2/responders/register", {
      method: "POST",
      headers: { Authorization: "Bearer sk_caller_not_a_real_key" },
      body: registrationBody()
    });

    expect(response.status).toBe(401);
    expect(state.responders.has("responder_enroll")).toBe(false);
  });

  it("enrolls a device against an authenticated owner", async () => {
    const response = await jsonRequest(baseUrl, "/v2/responders/register", {
      method: "POST",
      headers: callerAuth,
      body: registrationBody()
    });

    expect(response.status).toBe(201);
    expect(response.body.review_status).toBe("pending");
    // the enrolled device is bound to the identity that enrolled it
    expect(state.responders.get("responder_enroll").owner_user_id).toBeTruthy();
  });

  it("records version and capacity from a heartbeat", async () => {
    const enrolled = await jsonRequest(baseUrl, "/v2/responders/register", {
      method: "POST",
      headers: callerAuth,
      body: registrationBody()
    });
    const responderAuth = { Authorization: `Bearer ${enrolled.body.api_key}` };

    const heartbeat = await jsonRequest(baseUrl, "/v1/responders/responder_enroll/heartbeat", {
      method: "POST",
      headers: responderAuth,
      body: {
        status: "healthy",
        capacity: { max_concurrent: 4, in_flight: 1, accepting: true },
        version: { agent: "delexec-ops/0.1.6", runtime: "node/22.11.0" }
      }
    });

    expect(heartbeat.status).toBe(202);
    expect(heartbeat.body.capacity).toEqual({ max_concurrent: 4, in_flight: 1, accepting: true });
    expect(heartbeat.body.version).toMatchObject({ agent: "delexec-ops/0.1.6", runtime: "node/22.11.0" });

    const adminView = await jsonRequest(baseUrl, "/v2/admin/responders", {
      headers: { Authorization: `Bearer ${state.adminApiKey}` }
    });
    const record = adminView.body.items.find((item) => item.responder_id === "responder_enroll");
    expect(record.capacity).toEqual({ max_concurrent: 4, in_flight: 1, accepting: true });
    expect(record.device_version.agent).toBe("delexec-ops/0.1.6");
  });

  it("keeps unreported capacity null instead of implying zero", async () => {
    const enrolled = await jsonRequest(baseUrl, "/v2/responders/register", {
      method: "POST",
      headers: callerAuth,
      body: registrationBody()
    });
    const responderAuth = { Authorization: `Bearer ${enrolled.body.api_key}` };

    const heartbeat = await jsonRequest(baseUrl, "/v1/responders/responder_enroll/heartbeat", {
      method: "POST",
      headers: responderAuth,
      body: { status: "healthy" }
    });

    expect(heartbeat.body.capacity).toBeNull();
    expect(heartbeat.body.version).toBeNull();
  });

  it("does not let a partial heartbeat clear previously reported facts", async () => {
    const enrolled = await jsonRequest(baseUrl, "/v2/responders/register", {
      method: "POST",
      headers: callerAuth,
      body: registrationBody()
    });
    const responderAuth = { Authorization: `Bearer ${enrolled.body.api_key}` };

    await jsonRequest(baseUrl, "/v1/responders/responder_enroll/heartbeat", {
      method: "POST",
      headers: responderAuth,
      body: { status: "healthy", capacity: { max_concurrent: 4, in_flight: 0 }, version: { agent: "ops/1" } }
    });
    const second = await jsonRequest(baseUrl, "/v1/responders/responder_enroll/heartbeat", {
      method: "POST",
      headers: responderAuth,
      body: { status: "healthy" }
    });

    expect(second.body.capacity).toMatchObject({ max_concurrent: 4 });
    expect(second.body.version).toMatchObject({ agent: "ops/1" });
  });

  it("holds a device in maintenance until it says otherwise", async () => {
    const enrolled = await jsonRequest(baseUrl, "/v2/responders/register", {
      method: "POST",
      headers: callerAuth,
      body: registrationBody()
    });
    const responderAuth = { Authorization: `Bearer ${enrolled.body.api_key}` };

    const maintenance = await jsonRequest(baseUrl, "/v1/responders/responder_enroll/heartbeat", {
      method: "POST",
      headers: responderAuth,
      body: { status: "maintenance" }
    });
    expect(maintenance.status).toBe(202);
    // a fresh heartbeat must not silently promote it back into routing
    expect(maintenance.body.availability_status).toBe("maintenance");

    const back = await jsonRequest(baseUrl, "/v1/responders/responder_enroll/heartbeat", {
      method: "POST",
      headers: responderAuth,
      body: { status: "healthy" }
    });
    expect(back.body.availability_status).toBe("healthy");
  });

  it("rejects an unsupported self-reported status", async () => {
    const enrolled = await jsonRequest(baseUrl, "/v2/responders/register", {
      method: "POST",
      headers: callerAuth,
      body: registrationBody()
    });
    const responderAuth = { Authorization: `Bearer ${enrolled.body.api_key}` };

    const response = await jsonRequest(baseUrl, "/v1/responders/responder_enroll/heartbeat", {
      method: "POST",
      headers: responderAuth,
      body: { status: "vibing" }
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("CONTRACT_INVALID_HEARTBEAT_STATUS");
  });

  it("ignores a healthy self-report once the heartbeat has gone stale", async () => {
    const enrolled = await jsonRequest(baseUrl, "/v2/responders/register", {
      method: "POST",
      headers: callerAuth,
      body: registrationBody()
    });
    const responderAuth = { Authorization: `Bearer ${enrolled.body.api_key}` };
    await jsonRequest(baseUrl, "/v1/responders/responder_enroll/heartbeat", {
      method: "POST",
      headers: responderAuth,
      body: { status: "healthy" }
    });

    // simulate the device going quiet without saying so
    state.responders.get("responder_enroll").last_heartbeat_at = new Date(Date.now() - 3600_000).toISOString();

    const adminView = await jsonRequest(baseUrl, "/v2/admin/responders", {
      headers: { Authorization: `Bearer ${state.adminApiKey}` }
    });
    const record = adminView.body.items.find((item) => item.responder_id === "responder_enroll");
    expect(record.availability_status).toBe("offline");
    expect(record.reported_availability_status).toBe("healthy");
  });
});
