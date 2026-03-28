import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCase } from "../helpers/case-runner.js";
import { jsonRequest, waitFor } from "../helpers/http.js";
import { startHttpProcessSystem, stopHttpProcessSystem } from "./http-process-system.js";

describe("e2e: success path", () => {
  let system;

  beforeAll(async () => {
    system = await startHttpProcessSystem();
  });

  afterAll(async () => {
    await stopHttpProcessSystem(system);
  });

  it("completes request with SUCCEEDED status", async () => {
    await runCase({
      caseId: "e2e_success",
      name: "success path should end at SUCCEEDED",
      fallbackStepId: "H2-S1",
      run: async () => {
        const requestId = `req_success_${Date.now()}`;

        const registered = await jsonRequest(system.caller.baseUrl, "/controller/register", {
          method: "POST",
          body: { contact_email: "e2e-success@test.local" }
        });
        expect(registered.status).toBe(201);

        const authHeader = { "X-Platform-Api-Key": registered.body.api_key };

        const catalog = await waitFor(async () => {
          const current = await jsonRequest(system.caller.baseUrl, "/controller/hotlines?status=enabled", {
            headers: authHeader
          });
          const item = current.body?.items?.find(
            (entry) => entry.responder_id === system.responderId && entry.hotline_id === system.hotlineId
          );
          if (!item) {
            throw new Error("bootstrap_catalog_item_not_ready");
          }
          return item;
        });

        const started = await jsonRequest(system.caller.baseUrl, "/controller/remote-requests", {
          method: "POST",
          headers: authHeader,
          body: {
            request_id: requestId,
            responder_id: catalog.responder_id,
            hotline_id: catalog.hotline_id,
            expected_signer_public_key_pem: catalog.responder_public_key_pem,
            simulate: "success",
            delay_ms: 30,
            soft_timeout_s: 5,
            hard_timeout_s: 10
          }
        });
        expect(started.status).toBe(201);

        await waitFor(async () => {
          const current = await jsonRequest(system.caller.baseUrl, `/controller/requests/${requestId}`);
          if (current.body.status !== "ACKED" && current.body.status !== "SUCCEEDED") {
            throw new Error("ack_not_ready");
          }
          return current;
        });

        const final = await waitFor(async () => {
          const current = await jsonRequest(system.caller.baseUrl, `/controller/requests/${requestId}`);
          if (current.body.status !== "SUCCEEDED") {
            throw new Error("result_not_ready");
          }
          return current;
        });
        expect(final.body.status).toBe("SUCCEEDED");
      }
    });
  });
});
