// FR-010 / FR-013: approval is publication, so approval is where a declaration
// has to prove it is a contract.
//
// A production audit on 2026-08-06 found the shape this prevents: the only
// hotline that had ever done real work declared no input schema, no output
// schema, no examples and no limits. It was callable because nothing required
// otherwise, and a caller had no way to know what to send.
//
// Checked at approval rather than submission on purpose — a device must still
// be able to enroll, and the operator should get one list of everything the
// declaration is missing rather than a Provider decoding a rejection from a log.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";

import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";
import { publishableContract } from "../helpers/hotline-contract.js";

const ADMIN_KEY = "sk_admin_contract_completeness";
const HOTLINE_ID = "test.completeness.v1";
const RESPONDER_ID = "rsp_completeness";

describe("a hotline must be a contract before it can be published", () => {
  let server;
  let baseUrl;
  let state;
  let adminAuth;
  let callerAuth;
  let publicKeyPem;

  beforeEach(async () => {
    state = createPlatformState({ adminApiKey: ADMIN_KEY });
    server = createPlatformServer({ serviceName: "completeness-test", state });
    baseUrl = await listenServer(server);
    adminAuth = { Authorization: `Bearer ${ADMIN_KEY}` };

    const caller = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "completeness@test.local" }
    });
    callerAuth = { Authorization: `Bearer ${caller.body.api_key}` };
    publicKeyPem = crypto
      .generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
  });

  afterEach(async () => {
    await closeServer(server);
  });

  async function submit(contractFields) {
    const response = await jsonRequest(baseUrl, "/v2/hotlines", {
      method: "POST",
      headers: callerAuth,
      body: {
        responder_id: RESPONDER_ID,
        hotline_id: HOTLINE_ID,
        display_name: "Completeness test",
        responder_public_key_pem: publicKeyPem,
        task_delivery_address: "local://completeness",
        task_types: ["parse"],
        ...contractFields
      }
    });
    expect([200, 201]).toContain(response.status);
    return response;
  }

  function approve() {
    return jsonRequest(baseUrl, `/v2/admin/hotlines/${HOTLINE_ID}/approve`, {
      method: "POST",
      headers: adminAuth,
      body: { reason: "test" }
    });
  }

  it("lets a device enroll even when its declaration is incomplete", async () => {
    // Submission must keep working: an enrollment that fails on a
    // documentation problem looks like a broken device.
    const response = await submit({});
    expect([200, 201]).toContain(response.status);
    expect(state.catalog.get(HOTLINE_ID)).toBeTruthy();
  });

  it("refuses to publish a declaration that declares nothing", async () => {
    await submit({});
    const response = await approve();

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("CONTRACT_HOTLINE_INCOMPLETE");
    const problems = response.body.problems.join("\n");
    expect(problems).toContain("input_schema is required");
    expect(problems).toContain("output_schema is required");
    expect(problems).toContain("at least one worked input example");
    expect(problems).toContain("what this hotline is not for");
  });

  it("leaves the hotline unpublished when approval is refused", async () => {
    await submit({});
    await approve();

    const item = state.catalog.get(HOTLINE_ID);
    expect(item.status).toBe("disabled");
    expect(item.review_status).toBe("pending");
    expect(item.published_version).toBeUndefined();
  });

  it("refuses an example its own schema rejects", async () => {
    await submit(
      publishableContract({
        input_examples: [{ title: "Wrong shape", input: { txt: "misspelled key" } }]
      })
    );
    const response = await approve();

    expect(response.status).toBe(400);
    expect(response.body.problems.join("\n")).toContain(
      "input_examples[0] does not satisfy input_schema"
    );
  });

  it("refuses a declaration that never says what it is not for", async () => {
    await submit(publishableContract({ limitations: [], not_recommended_for: [] }));
    const response = await approve();

    expect(response.status).toBe(400);
    expect(response.body.problems.join("\n")).toContain("what this hotline is not for");
  });

  it("publishes a complete declaration", async () => {
    await submit(publishableContract());
    await jsonRequest(baseUrl, `/v2/admin/responders/${RESPONDER_ID}/approve`, {
      method: "POST",
      headers: adminAuth,
      body: { reason: "test" }
    });
    const response = await approve();

    expect(response.status).toBe(200);
    expect(response.body.published_version).toBe("1");
    expect(state.catalog.get(HOTLINE_ID).status).toBe("enabled");
  });

  it("reports every problem at once rather than one per attempt", async () => {
    await submit({ limitations: ["stated"] });
    const response = await approve();

    // Four separate omissions, one round trip.
    expect(response.body.problems.length).toBeGreaterThanOrEqual(4);
  });

  it("does not disturb hotlines approved before the rule existed", async () => {
    // Already-published hotlines are not re-validated: the rule gates
    // publication, and re-validating would disable running production
    // hotlines without anyone choosing to.
    await submit({});
    const item = state.catalog.get(HOTLINE_ID);
    item.status = "enabled";
    item.review_status = "approved";
    const responder = state.responders.get(RESPONDER_ID);
    responder.status = "enabled";
    responder.review_status = "approved";

    const listed = await jsonRequest(baseUrl, "/v2/hotlines?status=enabled");
    expect(listed.body.items.some((entry) => entry.hotline_id === HOTLINE_ID)).toBe(true);
  });
});
