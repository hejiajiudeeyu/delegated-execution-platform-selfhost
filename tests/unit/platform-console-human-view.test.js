import { describe, expect, it } from "vitest";

import {
  formatDisplayValue,
  humanizeKey,
  renderCatalogSummary,
  renderGatewayResponseSummary,
  renderOverviewSummary,
  renderRawJsonToggle
} from "../../apps/platform-console/src/human-view.js";

describe("platform-console human view", () => {
  it("humanizes keys and display values", () => {
    expect(humanizeKey("admin_api_key_configured")).toBe("Admin Api Key Configured");
    expect(formatDisplayValue(true)).toBe("Yes");
    expect(formatDisplayValue(["a", "b"])).toBe("a, b");
  });

  it("renders overview and catalog summaries with raw json toggle", () => {
    const overview = renderOverviewSummary(
      { status: 200, body: { ok: true, service: "platform-api" } },
      { status: 200, body: { total_events: 2, by_type: { CREATED: 2 } } }
    );
    expect(overview).toContain("Platform Health");
    expect(overview).toContain("platform-api");
    expect(overview).toContain("View raw health/metrics JSON");

    const catalog = renderCatalogSummary(
      { status: 200, body: { items: [{ hotline_id: "hl_1", display_name: "Demo", catalog_visibility: "public" }] } },
      [{ hotline_id: "hl_1", display_name: "Demo", catalog_visibility: "public" }]
    );
    expect(catalog).toContain("Demo");
    expect(catalog).toContain("View raw catalog JSON");
  });

  it("renders gateway responses in operator-friendly form", () => {
    const html = renderGatewayResponseSummary("Unlock Operator Gateway", {
      status: 200,
      body: {
        ok: true,
        token: "abc12345",
        session: {
          authenticated: true,
          locked: false,
          platform_url: "http://127.0.0.1:8080",
          admin_api_key_configured: true
        }
      }
    });
    expect(html).toContain("Unlock Operator Gateway");
    expect(html).toContain("Platform URL");
    expect(html).toContain("View raw response JSON");
    expect(renderRawJsonToggle("Raw", { ok: true })).toContain("<details");
  });
});
