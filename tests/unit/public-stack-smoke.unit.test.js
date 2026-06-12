import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const smokeScript = fs.readFileSync(
  path.resolve(process.cwd(), "tests/smoke/public-stack-smoke.mjs"),
  "utf8"
);

describe("public stack smoke helper", () => {
  it("consumes successful health-check response bodies before returning", () => {
    expect(smokeScript).toMatch(/if\s*\(\s*response\.ok\s*\)\s*{\s*await\s+response\.(?:arrayBuffer|text)\(\);/s);
  });
});
