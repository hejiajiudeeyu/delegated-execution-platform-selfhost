import { describe, expect, it } from "vitest";

import {
  renderAdminRequestCardsMarkup,
  renderAuditCardsMarkup,
  renderBillingBalanceSummary,
  renderBillingConsoleSection,
  renderBillingLedgerSummary,
  renderBillingReadinessNotice,
  renderDetailSummary,
  renderEntityCardsMarkup,
  renderHistorySummary,
  LEGACY_CONSOLE_SECTIONS,
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

  it("renders billing admin summaries with an explicit admin-only readiness boundary", () => {
    const balance = {
      tenant_id: "tenant_alpha",
      credit_balance_cents: 12500,
      pending_credit_cents: 0,
      currency: "PTS",
      credit_mode: "prepaid",
      rate_limit_per_second: 2,
      windows: [
        {
          window_kind: "daily",
          used_as_caller_cents: 100,
          earned_as_responder_cents: 0,
          hard_block_on_exceed: false
        }
      ]
    };

    expect(renderBillingReadinessNotice()).toContain("admin-only");
    expect(renderBillingBalanceSummary(balance)).toContain("tenant_alpha");
    expect(renderBillingBalanceSummary(balance)).toContain("125.00 PTS");
    expect(
      renderBillingLedgerSummary([
        {
          ledger_id: "ldg_1",
          kind: "recharge",
          direction: "system",
          amount_cents: 12500,
          recorded_at: "2026-06-06T00:00:00.000Z",
          new_balance_cents: 12500
        }
      ])
    ).toContain("recharge");
    expect(renderBillingLedgerSummary([])).toContain("No billing ledger rows");
  });

  it("registers billing in the legacy console sections and renders its mount points", () => {
    expect(LEGACY_CONSOLE_SECTIONS).toContain("billing");
    expect(renderBillingConsoleSection()).toContain('id="billing-balance"');
    expect(renderBillingConsoleSection()).toContain('id="billing-ledger"');
    expect(renderBillingConsoleSection()).toContain('id="refresh-billing"');
  });
});
