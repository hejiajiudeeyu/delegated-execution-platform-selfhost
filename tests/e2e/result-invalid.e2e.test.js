import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCase } from "../helpers/case-runner.js";
import { jsonRequest, waitFor } from "../helpers/http.js";
import { recordFlowIssue } from "../helpers/flow-step.js";
import { startHttpProcessSystem, stopHttpProcessSystem } from "./http-process-system.js";

describe("e2e: invalid result package", () => {
  let system;

  beforeAll(async () => {
    system = await startHttpProcessSystem();
  });

  afterAll(async () => {
    await stopHttpProcessSystem(system);
  });

  it("marks request as UNVERIFIED when schema check fails", async () => {
    await runCase({
      caseId: "e2e_result_invalid",
      name: "schema-invalid result package should be UNVERIFIED",
      fallbackStepId: "H1-F2",
      run: async () => {
        const requestId = `req_result_invalid_${Date.now()}`;

        await jsonRequest(system.caller.baseUrl, "/controller/requests", {
          method: "POST",
          body: {
            request_id: requestId,
            responder_id: system.responderId,
            hotline_id: system.hotlineId,
            expected_signer_public_key_pem: system.signing.publicKeyPem,
            soft_timeout_s: 5,
            hard_timeout_s: 10
          }
        });

        const task = await jsonRequest(system.responder.baseUrl, "/controller/tasks", {
          method: "POST",
          body: {
            request_id: requestId,
            simulate: "schema_invalid",
            delay_ms: 30
          }
        });

        const result = await waitFor(async () => {
          const polled = await jsonRequest(system.responder.baseUrl, `/controller/tasks/${task.body.task_id}/result`);
          if (polled.status !== 200 || polled.body.available !== true) {
            throw new Error("result_not_ready");
          }
          return polled;
        });

        await jsonRequest(system.caller.baseUrl, `/controller/requests/${requestId}/result`, {
          method: "POST",
          body: result.body.result_package
        });

        const final = await jsonRequest(system.caller.baseUrl, `/controller/requests/${requestId}`);
        expect(final.body.status).toBe("UNVERIFIED");
        expect(final.body.last_error_code).toBe("RESULT_SCHEMA_INVALID");

        recordFlowIssue({
          case_id: "e2e_result_invalid",
          flow_step_id: "H1-F2",
          severity: "warning",
          error_code: "RESULT_SCHEMA_INVALID",
          message: "Invalid result schema path exercised"
        });
      }
    });
  });
});
