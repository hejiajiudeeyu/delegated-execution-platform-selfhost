import fs from "node:fs";
import path from "node:path";

const reportPath = path.resolve(process.cwd(), "tests/reports/latest.json");
if (fs.existsSync(reportPath)) {
  fs.unlinkSync(reportPath);
  console.log(`[flow-report] removed ${reportPath}`);
} else {
  console.log("[flow-report] no previous report to remove");
}
