import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function printFlowSummary(reportPath = path.resolve(process.cwd(), "tests/reports/latest.json")) {
  if (!fs.existsSync(reportPath)) {
    console.log("[flow-report] latest.json not found");
    return;
  }

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const summary = report.summary || {};
  console.log(
    `[flow-report] summary total=${summary.total_cases || 0} passed=${summary.passed || 0} failed=${summary.failed || 0} issues=${summary.total_issues || 0}`
  );
}

const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  printFlowSummary();
}
