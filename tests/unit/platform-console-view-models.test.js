import { describe, expect, it } from "vitest";

import {
  renderAdminRequestCardsMarkup,
  renderAuditCardsMarkup,
  renderDetailSummary,
  renderEntityCardsMarkup,
  renderHistorySummary,
  renderPaginationSummary,
  renderReviewActionSummary,
  renderReviewCardsMarkup
} from "../../apps/platform-console/src/view-model.js";

describe("platform-console view models", () => {
  it("renders platform collections and pagination summary", () => {
    expect(renderEntityCardsMarkup([{ responder_id: "responder_a", hotline_count: 2, status: "disabled" }], "responders")).toContain(
      "Approve"
    );
    expect(renderAdminRequestCardsMarkup([{ request_id: "req_a", event_count: 1 }])).toContain("req_a");
    expect(
      renderAuditCardsMarkup([{ id: "audit_1", action: "responder.disabled", target_type: "responder", target_id: "responder_a", actor_type: "admin", recorded_at: "now" }])
    ).toContain("responder.disabled");
    expect(
      renderReviewCardsMarkup([{ id: "review_1", target_type: "responder", target_id: "responder_a", review_status: "pending", actor_type: "caller", recorded_at: "now" }])
    ).toContain("pending");
    expect(renderPaginationSummary({ total: 24, offset: 10, limit: 10 }, "responders")).toBe("responders: 11-20 / 24");
    expect(renderDetailSummary({ responder_id: "responder_a", status: "disabled" })).toContain("responder_a");
    expect(renderHistorySummary([{ review_status: "pending", recorded_at: "now" }], "Review History")).toContain("Review History");
    expect(
      renderReviewActionSummary({ responder_id: "responder_a", status: "disabled" }, "manual check", [{ reason: "policy" }])
    ).toContain("manual check");
  });
});
