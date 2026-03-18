import fs from "node:fs";
import path from "node:path";

const reportState = {
  cases: new Map(),
  issues: []
};

function nowIso() {
  return new Date().toISOString();
}

export function resetFlowReport() {
  reportState.cases.clear();
  reportState.issues.length = 0;
}

export function recordCaseResult(caseResult) {
  reportState.cases.set(caseResult.case_id, {
    ...caseResult,
    recorded_at: nowIso()
  });
}

export function recordFlowIssue(issue) {
  reportState.issues.push({
    severity: "error",
    error_code: "UNKNOWN",
    occurred_at: nowIso(),
    ...issue
  });
}

function buildSummary(report) {
  const totalCases = report.cases.length;
  const passed = report.cases.filter((item) => item.status === "passed").length;
  const failed = report.cases.filter((item) => item.status !== "passed").length;
  const issueBySeverity = report.issues.reduce((acc, item) => {
    acc[item.severity] = (acc[item.severity] || 0) + 1;
    return acc;
  }, {});

  return {
    total_cases: totalCases,
    passed,
    failed,
    total_issues: report.issues.length,
    issues_by_severity: issueBySeverity
  };
}

export function writeFlowReport(outputPath = path.resolve(process.cwd(), "tests/reports/latest.json")) {
  const existingReport = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, "utf8"))
    : { cases: [], issues: [] };

  const casesById = new Map();
  for (const item of existingReport.cases || []) {
    if (item.case_id) {
      casesById.set(item.case_id, item);
    }
  }
  for (const item of reportState.cases.values()) {
    casesById.set(item.case_id, item);
  }

  const issues = [];
  const issueDedupe = new Set();
  for (const source of [...(existingReport.issues || []), ...reportState.issues]) {
    const key = `${source.case_id || "n/a"}|${source.flow_step_id || "n/a"}|${source.error_code || "n/a"}|${
      source.message || "n/a"
    }`;
    if (issueDedupe.has(key)) {
      continue;
    }
    issueDedupe.add(key);
    issues.push(source);
  }

  const report = {
    generated_at: nowIso(),
    cases: Array.from(casesById.values()).sort((a, b) => a.case_id.localeCompare(b.case_id)),
    issues
  };

  report.summary = buildSummary(report);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(
    `[flow-report] cases=${report.summary.total_cases} passed=${report.summary.passed} failed=${report.summary.failed} issues=${report.summary.total_issues}`
  );

  return report;
}
