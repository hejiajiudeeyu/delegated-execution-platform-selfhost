// FR-014: a Call pins an immutable HotlineVersion.
//
// Before this, the catalog held one mutable record per hotline and a
// resubmission overwrote it in place, while a Call recorded only `hotline_id`.
// A Provider could therefore change the schemas, limitations and pricing of a
// contract while a call made under the old ones was still running, and nothing
// anywhere could say which contract the call had actually agreed to. M3 has to
// adjudicate deliveries against a contract, so "which contract" has to have an
// answer first.
//
// The property that matters most here is the fourth test: republishing must not
// move a bound call.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

const ADMIN_KEY = "sk_admin_hotline_versions";

describe("immutable hotline versions", () => {
  let server;
  let baseUrl;
  let state;
  let adminAuth;
  let callerAuth;
  let responderPublicKeyPem;

  const HOTLINE_ID = "test.contract.parse.v1";
  const RESPONDER_ID = "rsp_contract_test";

  beforeEach(async () => {
    state = createPlatformState({ adminApiKey: ADMIN_KEY });
    server = createPlatformServer({ serviceName: "hotline-versions-test", state });
    baseUrl = await listenServer(server);
    adminAuth = { Authorization: `Bearer ${ADMIN_KEY}` };

    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "versions-caller@test.local" }
    });
    callerAuth = { Authorization: `Bearer ${caller.body.api_key}` };

    const { publicKey } = await import("node:crypto").then(({ generateKeyPairSync }) =>
      generateKeyPairSync("ed25519")
    );
    responderPublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  });

  afterEach(async () => {
    await closeServer(server);
  });

  async function submit(overrides = {}) {
    const response = await jsonRequest(baseUrl, "/v2/hotlines", {
      method: "POST",
      headers: callerAuth,
      body: {
        responder_id: RESPONDER_ID,
        hotline_id: HOTLINE_ID,
        display_name: "Contract test hotline",
        responder_public_key_pem: responderPublicKeyPem,
        task_delivery_address: "local://contract-test",
        task_types: ["parse"],
        tags: ["contract-test"],
        input_schema: { type: "object", required: ["document"], properties: { document: { type: "string" } } },
        output_schema: { type: "object", properties: { markdown: { type: "string" } } },
        ...overrides
      }
    });
    expect([200, 201]).toContain(response.status);
    return response;
  }

  async function approve() {
    const response = await jsonRequest(baseUrl, `/v2/admin/hotlines/${HOTLINE_ID}/approve`, {
      method: "POST",
      headers: adminAuth,
      body: { reason: "test" }
    });
    expect(response.status).toBe(200);
    return response.body;
  }

  async function approveResponder() {
    const response = await jsonRequest(baseUrl, `/v2/admin/responders/${RESPONDER_ID}/approve`, {
      method: "POST",
      headers: adminAuth,
      body: { reason: "test" }
    });
    expect(response.status).toBe(200);
  }

  async function publish(overrides = {}) {
    await submit(overrides);
    await approveResponder();
    return approve();
  }

  async function issueToken(requestId) {
    return jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: callerAuth,
      body: { request_id: requestId, responder_id: RESPONDER_ID, hotline_id: HOTLINE_ID }
    });
  }

  async function versions() {
    const response = await jsonRequest(baseUrl, `/v2/admin/hotlines/${HOTLINE_ID}/versions`, {
      headers: adminAuth
    });
    expect(response.status).toBe(200);
    return response.body;
  }

  it("publishes version 1 with a content digest when a hotline is approved", async () => {
    const approved = await publish();
    expect(approved.published_version).toBe("1");
    expect(approved.published_version_digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const history = await versions();
    expect(history.versions).toHaveLength(1);
    expect(history.versions[0]).toMatchObject({ version: "1", integrity: "verified" });
    expect(history.versions[0].contract.input_schema).toMatchObject({ type: "object" });
  });

  it("does not mint a new version when the contract has not changed", async () => {
    await publish();
    // Re-approving the same content is not a new agreement, and a version
    // number that means "someone clicked approve twice" is noise in the record
    // an operator has to read during a dispute.
    const second = await approve();
    expect(second.published_version).toBe("1");
    expect((await versions()).versions).toHaveLength(1);
  });

  it("mints a new version when the contract changes", async () => {
    await publish();
    const changed = await publish({ limitations: "no scanned documents" });
    expect(changed.published_version).toBe("2");

    const history = await versions();
    expect(history.versions.map((entry) => entry.version)).toEqual(["2", "1"]);
    expect(history.versions[0].digest).not.toBe(history.versions[1].digest);
    expect(history.published_version).toBe("2");
  });

  it("keeps a bound call on its own version when the hotline is republished", async () => {
    await publish();
    const issued = await issueToken("req_bound_contract");
    expect(issued.status).toBe(201);
    expect(issued.body.claims.hotline_version).toMatchObject({ version: "1" });

    // The provider changes the contract mid-flight — the exact move this pin
    // exists to survive.
    await publish({ limitations: "actually, no PDFs over 10MB" });

    const detail = await jsonRequest(baseUrl, "/v1/admin/requests/req_bound_contract", { headers: adminAuth });
    expect(detail.status).toBe(200);
    expect(detail.body.hotline_version).toMatchObject({
      version: "1",
      tracked: true,
      integrity: "verified",
      superseded_by_current: true
    });
    expect(detail.body.hotline_version.contract.limitations ?? null).toBeNull();
    expect(detail.body.hotline.published_version).toBe("2");
  });

  it("does not silently upgrade the contract when a token is re-issued", async () => {
    await publish();
    expect((await issueToken("req_reissue")).status).toBe(201);
    await publish({ limitations: "changed after the first token" });

    const second = await issueToken("req_reissue");
    expect(second.status).toBe(201);
    expect(second.body.claims.hotline_version.version).toBe("1");
  });

  it("tells the responder which contract it is executing, through the signed token and the delivery metadata", async () => {
    const approved = await publish();
    const issued = await issueToken("req_meta");
    expect(issued.status).toBe(201);
    expect(issued.body.claims.hotline_version).toMatchObject({
      hotline_id: HOTLINE_ID,
      version: "1",
      digest: approved.published_version_digest
    });

    const resolved = await jsonRequest(baseUrl, "/v1/service-resolutions", {
      method: "POST",
      headers: callerAuth,
      body: {
        request_id: "req_meta_resolved",
        capability: "contract-test",
        task_type: "parse",
        result_delivery: { kind: "local", address: "caller-controller" }
      }
    });
    expect(resolved.status).toBe(201);
    expect(resolved.body.delivery_meta.hotline_version).toMatchObject({ version: "1" });
  });

  it("binds a version even for a hotline approved before versions existed", async () => {
    await publish();
    // Simulate legacy persisted state: the catalog item is enabled, but no
    // version was ever published for it.
    const item = state.catalog.get(HOTLINE_ID);
    delete item.published_version;
    delete item.published_version_digest;
    state.hotlineVersions.clear();

    const issued = await issueToken("req_legacy");
    expect(issued.status).toBe(201);
    expect(issued.body.claims.hotline_version.version).toBe("1");
    expect((await versions()).versions).toHaveLength(1);
  });

  it("reports a version record that was edited in place instead of trusting it", async () => {
    await publish();
    await issueToken("req_tampered");

    // Nothing in the product does this; the point is that if anything ever
    // did — a bad migration, a hand-edited snapshot — the record says so
    // rather than presenting an altered contract as the frozen one.
    const stored = state.hotlineVersions.get(`${HOTLINE_ID}@1`);
    stored.contract.limitations = "inserted after publication";

    expect((await versions()).versions[0].integrity).toBe("digest_mismatch");
    const detail = await jsonRequest(baseUrl, "/v1/admin/requests/req_tampered", { headers: adminAuth });
    expect(detail.body.hotline_version.integrity).toBe("digest_mismatch");
  });

  it("says a call predates versioning rather than borrowing the current contract", async () => {
    await publish();
    await issueToken("req_old");
    // A call carried over from before FR-014 has no pin at all.
    delete state.requests.get("req_old").hotline_version;

    const detail = await jsonRequest(baseUrl, "/v1/admin/requests/req_old", { headers: adminAuth });
    expect(detail.body.hotline_version).toEqual({
      tracked: false,
      reason: "call predates versioned hotline contracts"
    });
  });

  it("survives a snapshot round trip", async () => {
    await publish();
    await issueToken("req_persisted");

    const { hydratePlatformState, serializePlatformState } = await import("@delexec/platform-api");
    const snapshot = JSON.parse(JSON.stringify(serializePlatformState(state)));
    const restored = createPlatformState({ adminApiKey: ADMIN_KEY });
    hydratePlatformState(restored, snapshot);

    expect(restored.hotlineVersions.get(`${HOTLINE_ID}@1`)).toMatchObject({ version: "1" });
    expect(restored.requests.get("req_persisted").hotline_version).toMatchObject({ version: "1" });
  });
});
