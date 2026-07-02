import { renderKeyValueList } from "./human-view.js";

function entityLabels(type) {
  return type === "responders"
    ? { plural: "Responders", singular: "Responder", idLabel: "Responder ID" }
    : { plural: "Hotlines", singular: "Hotline", idLabel: "Hotline ID" };
}

function targetTypeLabel(targetType) {
  if (targetType === "responder") {
    return "responder";
  }
  if (targetType === "hotline") {
    return "hotline";
  }
  return targetType || "target";
}

function formatPoints(cents) {
  const value = Number(cents || 0) / 100;
  return `${value.toFixed(2)} PTS`;
}

export const LEGACY_CONSOLE_SECTIONS = ["responders", "hotlines", "requests", "audit", "reviews", "billing"];

export function renderBillingReadinessNotice() {
  return `
    <article class="item-card">
      <div class="item-head">
        <div>
          <strong>Billing P-1 M1.2 admin-only</strong>
          <p>Operators can inspect tenant balance, record manual recharges, and browse ledger rows.</p>
        </div>
        <span class="status pending">not end-user ready</span>
      </div>
      <p class="meta">This surface does not enable client-facing billing, spend enforcement, withdrawal, or fiat settlement.</p>
    </article>
  `;
}

export function renderBillingConsoleSection() {
  return `
    <section class="grid one" data-console-section="billing">
      <div class="card">
        <div class="section-head">
          <div>
            <h2>Billing</h2>
            <p class="meta">Admin-only tenant balance, manual recharge, and ledger inspection.</p>
          </div>
          <div class="actions inline">
            <button id="refresh-billing" class="ghost">Reload</button>
          </div>
        </div>
        ${renderBillingReadinessNotice()}
        <div class="grid two">
          <div class="item-card">
            <h3>Tenant</h3>
            <label>tenant_id</label>
            <input id="billing-tenant-id" list="billing-tenant-options" value="tenant_default" />
            <datalist id="billing-tenant-options"></datalist>
            <div class="actions inline">
              <button id="select-billing-tenant" class="ghost">Load Tenant</button>
              <button id="create-billing-tenant" class="ghost">Create Tenant</button>
            </div>
            <label>recharge_id</label>
            <input id="billing-recharge-id" placeholder="Leave blank to generate" />
            <label>amount_cents</label>
            <input id="billing-recharge-amount" inputmode="numeric" value="10000" />
            <label>provider</label>
            <input id="billing-recharge-provider" value="manual" />
            <label>external_reference</label>
            <input id="billing-recharge-reference" placeholder="optional" />
            <div class="actions inline">
              <button id="record-billing-recharge">Record Manual Recharge</button>
            </div>
          </div>
          <div>
            <h3>Balance</h3>
            <div id="billing-balance" class="stack"></div>
          </div>
        </div>
        <h3>Ledger</h3>
        <div id="billing-ledger" class="stack"></div>
        <div id="billing-output" class="human-panel">No billing tenant loaded yet.</div>
      </div>
    </section>
  `;
}

export function renderBillingBalanceSummary(balance) {
  if (!balance) {
    return `<div class="empty">No billing tenant loaded.</div>`;
  }
  const windows = Array.isArray(balance.windows) ? balance.windows : [];
  return `
    <article class="item-card">
      <div class="item-head">
        <div>
          <strong>${balance.tenant_id}</strong>
          <p>${formatPoints(balance.credit_balance_cents)} available · ${formatPoints(balance.pending_credit_cents)} pending</p>
        </div>
        <span class="status healthy">${balance.currency || "PTS"}</span>
      </div>
      <p class="meta">Mode: ${balance.credit_mode || "prepaid"} · Rate limit: ${balance.rate_limit_per_second ?? "n/a"}/s</p>
      <div class="stack">
        ${
          windows.length
            ? windows
                .map(
                  (window) => `
                    <div class="item-card">
                      <strong>${window.window_kind}</strong>
                      <p class="meta">caller used ${formatPoints(window.used_as_caller_cents)} · responder earned ${formatPoints(window.earned_as_responder_cents)} · hard block ${window.hard_block_on_exceed ? "on" : "off"}</p>
                    </div>
                  `
                )
                .join("")
            : `<div class="empty">No quota windows returned.</div>`
        }
      </div>
    </article>
  `;
}

export function renderBillingLedgerSummary(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="empty">No billing ledger rows found.</div>`;
  }
  return items
    .map(
      (item) => `
        <article class="item-card">
          <div class="item-head">
            <div>
              <strong>${item.kind || "ledger"}</strong>
              <p>${item.ledger_id || "unidentified ledger row"} · ${item.direction || "unknown direction"}</p>
            </div>
            <span class="status active">${formatPoints(item.amount_cents)}</span>
          </div>
          <p class="meta">${item.recorded_at || "n/a"} · balance after ${formatPoints(item.new_balance_cents)}</p>
        </article>
      `
    )
    .join("");
}

export function renderEntityCardsMarkup(items, type) {
  const labels = entityLabels(type);
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="empty">No ${labels.plural.toLowerCase()} found.</div>`;
  }

  return items
    .map((item) => {
      const id = type === "responders" ? item.responder_id : item.hotline_id;
      const status = item.status || item.availability_status || "unknown";
      const reviewStatus = item.review_status || "pending";
      const latestReviewTest = item.latest_review_test;
      let actions = `
        <button data-type="${type}" data-id="${id}" data-action="approve">Approve</button>
        <button data-type="${type}" data-id="${id}" data-action="reject" class="ghost">Reject</button>
      `;
      if (reviewStatus === "approved") {
        actions =
          item.status === "disabled"
            ? `<button data-type="${type}" data-id="${id}" data-action="enable">Enable</button>`
            : `<button data-type="${type}" data-id="${id}" data-action="disable">Disable</button>`;
      }
      return `
        <article class="item-card" data-detail-type="${type}" data-detail-id="${id}">
          <div class="item-head">
            <div>
              <strong>${id}</strong>
              <p>${type === "responders" ? item.delivery_email || item.contact_email || "no delivery email" : item.display_name || "unnamed hotline"}</p>
            </div>
            <span class="status ${status}">${status}</span>
          </div>
          <p class="meta">
            Review: ${reviewStatus}
            ${
              type === "responders"
                ? ` · ${item.hotline_count} hotline runtime(s)`
                : ` · ${item.catalog_visibility || "hidden"} · Hotline v${item.submission_version || 1}`
            }
          </p>
          ${
            type === "hotlines" && latestReviewTest
              ? `<p class="meta">Latest review test: ${latestReviewTest.verdict || latestReviewTest.status}${latestReviewTest.failure_code ? ` · ${latestReviewTest.failure_code}` : ""}</p>`
              : `<p class="meta">${type === "responders" ? (item.hotlines || []).map((hotline) => hotline.hotline_id).join(", ") || "no hotline runtimes" : `${(item.capabilities || []).join(", ") || "no capabilities"}`}</p>`
          }
          <div class="actions">
            ${actions}
          </div>
        </article>
      `;
    })
    .join("");
}

export function renderAdminRequestCardsMarkup(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="empty">No requests found.</div>`;
  }
  return items
    .map(
      (item) => `
        <article class="item-card" data-detail-type="requests" data-detail-id="${item.request_id}">
          <div class="item-head">
            <div>
              <strong>${item.request_id}</strong>
              <p>${item.responder_id || "unbound responder"} · ${item.hotline_id || "unbound hotline runtime"}</p>
            </div>
            <span class="status ${String(item.latest_event?.event_type || "created").toLowerCase()}">${item.latest_event?.event_type || "CREATED"}</span>
          </div>
          <p class="meta">Events: ${item.event_count} · Caller: ${item.caller_id || "n/a"}</p>
        </article>
      `
    )
    .join("");
}

export function renderAuditCardsMarkup(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="empty">No audit events found.</div>`;
  }
  return items
    .map(
      (item) => `
        <article class="item-card" data-detail-type="audit" data-detail-id="${item.id}">
          <div class="item-head">
            <div>
              <strong>${item.action}</strong>
              <p>${targetTypeLabel(item.target_type)}:${item.target_id}</p>
            </div>
            <span class="status active">${item.actor_type}</span>
          </div>
          <p class="meta">${item.recorded_at} · ${item.actor_id || "system"}${item.reason ? ` · ${item.reason}` : ""}</p>
        </article>
      `
    )
    .join("");
}

export function renderReviewCardsMarkup(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="empty">No review events found.</div>`;
  }
  return items
    .map(
      (item) => `
        <article class="item-card" data-detail-type="reviews" data-detail-id="${item.id}">
          <div class="item-head">
            <div>
              <strong>${targetTypeLabel(item.target_type)}:${item.target_id}</strong>
              <p>${item.review_status}${item.reason ? ` · ${item.reason}` : ""}</p>
            </div>
            <span class="status ${item.review_status}">${item.review_status}</span>
          </div>
          <p class="meta">${item.recorded_at} · ${item.actor_type}:${item.actor_id || "system"}${item.reason ? ` · ${item.reason}` : ""}</p>
        </article>
      `
    )
    .join("");
}

export function renderPendingReviewQueueMarkup(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="empty">No pending review submissions. New Responder or Hotline submit-review entries will appear here.</div>`;
  }

  return items
    .map((item) => {
      const entityType = item._entityType === "hotlines" ? "hotlines" : "responders";
      const id = entityType === "hotlines" ? item.hotline_id : item.responder_id;
      const reviewStatus = item.review_status || "pending";
      const status = item.status || "disabled";
      const needsEnable = reviewStatus === "approved" && status === "disabled";
      const actions = needsEnable
        ? `<button data-review-type="${entityType}" data-id="${id}" data-action="enable">Enable</button>`
        : `
            <button data-review-type="${entityType}" data-id="${id}" data-action="approve">Approve</button>
            <button data-review-type="${entityType}" data-id="${id}" data-action="reject" class="ghost">Reject</button>
          `;
      const label =
        entityType === "hotlines"
          ? item.display_name || id
          : item.display_name || item.delivery_email || item.contact_email || id;
      return `
        <article class="item-card" data-detail-type="reviews" data-detail-id="${entityType}:${id}">
          <div class="item-head">
            <div>
              <strong>${entityType === "hotlines" ? "Hotline" : "Responder"} · ${id}</strong>
              <p>${label}</p>
            </div>
            <span class="status ${reviewStatus}">${needsEnable ? "approved · disabled" : reviewStatus}</span>
          </div>
          <p class="meta">
            ${entityType === "hotlines" ? `Responder: ${item.responder_id || "n/a"}` : `Hotlines: ${item.hotline_count ?? (item.hotlines || []).length}`}
            ${item.pricing_hint?.fixed_price_cents != null ? ` · ${item.pricing_hint.fixed_price_cents} ${item.pricing_hint.currency || "PTS"}` : ""}
          </p>
          <div class="actions">
            ${actions}
          </div>
        </article>
      `;
    })
    .join("");
}

export function renderPaginationSummary(pagination, label) {
  if (!pagination) {
    return `${label}: no data`;
  }
  const start = pagination.total === 0 ? 0 : pagination.offset + 1;
  const end = Math.min(pagination.offset + pagination.limit, pagination.total);
  return `${label}: ${start}-${end} / ${pagination.total}`;
}

export function renderDetailSummary(item) {
  if (!item) {
    return `<div class="empty">No item selected yet.</div>`;
  }
  return renderKeyValueList(Object.entries(item), { limit: 10 });
}

export function renderHistorySummary(items, title) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="empty">No ${title.toLowerCase()} found for the current selection.</div>`;
  }
  return `
    <article class="item-card">
      <div class="item-head">
        <div>
          <strong>${title}</strong>
          <p>${items.length} item(s)</p>
        </div>
        <span class="status healthy">history</span>
      </div>
      <div class="stack">
        ${items
          .slice(0, 5)
          .map(
            (item) => `
              <div class="item-card">
                <strong>${item.review_status || item.action || "event"}</strong>
                <p class="meta">${item.recorded_at || "n/a"}${item.reason ? ` · ${item.reason}` : ""}</p>
              </div>
            `
          )
          .join("")}
      </div>
    </article>
  `;
}

export function renderReviewerGuidance(item) {
  if (!item) {
    return `<div class="empty">Select a Responder or Hotline to see reviewer guidance.</div>`;
  }
  const target = item.hotline_id || item.responder_id || item.target_id || "selected item";
  const status = item.review_status || item.status || "unknown";
  const hints = [];
  if (item.status === "disabled" && item.review_status === "approved") {
    hints.push("Disabled resources should include a clear re-enable condition or operator follow-up note.");
  }
  if (status === "pending") {
    hints.push("Pending reviews should capture what was checked and what remains unresolved.");
  }
  if (item.latest_review_test?.verdict === "fail") {
    hints.push(`Latest review test failed: ${item.latest_review_test.failure_code || item.latest_review_test.result_summary}.`);
  }
  if (item.capabilities?.length) {
    hints.push(`Confirm capabilities match the declared scope: ${item.capabilities.join(", ")}.`);
  }
  if (hints.length === 0) {
    hints.push("Record why the action is being taken and what follow-up is expected.");
  }
  return `
    <article class="item-card">
      <div class="item-head">
        <div>
          <strong>Reviewer Guidance</strong>
          <p>${target}</p>
        </div>
        <span class="status healthy">${status}</span>
      </div>
      <ul class="meta-list">
        ${hints.map((hint) => `<li>${hint}</li>`).join("")}
      </ul>
    </article>
  `;
}

export function renderReviewActionSummary(item, reviewerNotes = "", history = []) {
  if (!item) {
    return `<div class="empty">Select a Responder or Hotline to see suggested review actions.</div>`;
  }
  const status = item.status || "unknown";
  const latestReason = history.find((entry) => entry.reason)?.reason || "No prior reason recorded.";
  const recommendedAction =
    item.review_status !== "approved" ? "approve or reject" : status === "disabled" ? "enable" : "disable";
  return `
    <article class="item-card">
      <div class="item-head">
        <div>
          <strong>Review Action Summary</strong>
          <p>${item.responder_id || item.hotline_id || item.target_id || "selected item"}</p>
        </div>
        <span class="status ${status}">${status}</span>
      </div>
      <p class="meta">Recommended action: ${recommendedAction}</p>
      <p class="meta">Current note: ${reviewerNotes || "No reviewer notes entered yet."}</p>
      <p class="meta">Latest reason: ${latestReason}</p>
      ${
        item.latest_review_test
          ? `<p class="meta">Latest review test: ${item.latest_review_test.verdict || item.latest_review_test.status}${item.latest_review_test.failure_code ? ` · ${item.latest_review_test.failure_code}` : ""}</p>`
          : ""
      }
    </article>
  `;
}
