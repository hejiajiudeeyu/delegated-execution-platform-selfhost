import { recordCaseResult, recordFlowIssue } from "./flow-step.js";

export async function runCase({ caseId, name, fallbackStepId, run }) {
  const started = Date.now();
  try {
    await run();
    recordCaseResult({
      case_id: caseId,
      name,
      status: "passed",
      duration_ms: Date.now() - started
    });
  } catch (error) {
    recordCaseResult({
      case_id: caseId,
      name,
      status: "failed",
      duration_ms: Date.now() - started,
      error_message: error instanceof Error ? error.message : "unknown_error"
    });

    recordFlowIssue({
      case_id: caseId,
      flow_step_id: fallbackStepId,
      severity: "error",
      error_code: "ASSERTION_FAILED",
      message: error instanceof Error ? error.message : "unknown_error"
    });

    throw error;
  }
}
