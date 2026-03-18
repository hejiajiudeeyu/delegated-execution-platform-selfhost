import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCase } from "../helpers/case-runner.js";
import { jsonRequest } from "../helpers/http.js";
import { recordFlowIssue } from "../helpers/flow-step.js";
import { startHttpProcessSystem, stopHttpProcessSystem } from "./http-process-system.js";

describe("e2e: timeout path", () => {
  let system;

  beforeAll(async () => {
    system = await startHttpProcessSystem();
  });

  afterAll(async () => {
    await stopHttpProcessSystem(system);
  });

  it("auto-finalizes request to TIMED_OUT", async () => {
    await runCase({
      caseId: "e2e_timeout",
      name: "timeout path should end at TIMED_OUT",
      fallbackStepId: "H3-F2",
      run: async () => {
        const requestId = `req_timeout_${Date.now()}`;

        await jsonRequest(system.buyer.baseUrl, "/controller/requests", {
          method: "POST",
          body: {
            request_id: requestId,
            seller_id: system.sellerId,
            subagent_id: system.subagentId,
            expected_signer_public_key_pem: system.signing.publicKeyPem,
            soft_timeout_s: 1,
            hard_timeout_s: 1
          }
        });

        await jsonRequest(system.buyer.baseUrl, `/controller/requests/${requestId}/mark-sent`, { method: "POST" });

        await jsonRequest(system.seller.baseUrl, "/controller/tasks", {
          method: "POST",
          body: {
            request_id: requestId,
            simulate: "timeout",
            delay_ms: 20
          }
        });

        await new Promise((resolve) => setTimeout(resolve, 1300));

        const final = await jsonRequest(system.buyer.baseUrl, `/controller/requests/${requestId}`);
        expect(final.body.status).toBe("TIMED_OUT");

        recordFlowIssue({
          case_id: "e2e_timeout",
          flow_step_id: "H3-F2",
          severity: "warning",
          error_code: "EXEC_TIMEOUT_HARD",
          message: "Hard-timeout branch exercised"
        });
      }
    });
  });
});
