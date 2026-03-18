export function renderEntityCardsMarkup(items, type) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="empty">No ${type} found.</div>`;
  }

  return items
    .map((item) => {
      const id = type === "sellers" ? item.seller_id : item.subagent_id;
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
              <p>${type === "sellers" ? item.contact_email || "no contact email" : item.display_name || "unnamed subagent"}</p>
            </div>
            <span class="status ${status}">${status}</span>
          </div>
          <p class="meta">
            Review: ${reviewStatus}
            ${
              type === "sellers"
                ? ` · ${item.subagent_count} subagents`
                : ` · ${item.catalog_visibility || "hidden"} · v${item.submission_version || 1}`
            }
          </p>
          ${
            type === "subagents" && latestReviewTest
              ? `<p class="meta">Latest review test: ${latestReviewTest.verdict || latestReviewTest.status}${latestReviewTest.failure_code ? ` · ${latestReviewTest.failure_code}` : ""}</p>`
              : `<p class="meta">${type === "sellers" ? (item.subagents || []).map((subagent) => subagent.subagent_id).join(", ") || "no subagents" : `${(item.capabilities || []).join(", ") || "no capabilities"}`}</p>`
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
              <p>${item.seller_id || "unbound seller"} · ${item.subagent_id || "unbound subagent"}</p>
            </div>
            <span class="status ${String(item.latest_event?.event_type || "created").toLowerCase()}">${item.latest_event?.event_type || "CREATED"}</span>
          </div>
          <p class="meta">Events: ${item.event_count} · Buyer: ${item.buyer_id || "n/a"}</p>
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
              <p>${item.target_type}:${item.target_id}</p>
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
              <strong>${item.target_type}:${item.target_id}</strong>
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
  const pairs = Object.entries(item)
    .slice(0, 10)
    .map(
      ([key, value]) => `
        <div class="item-card">
          <strong>${key}</strong>
          <p class="meta">${typeof value === "object" ? JSON.stringify(value) : String(value)}</p>
        </div>
      `
    )
    .join("");
  return pairs || `<div class="empty">No detail fields available.</div>`;
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
    return `<div class="empty">Select a seller or subagent to see reviewer guidance.</div>`;
  }
  const target = item.subagent_id || item.seller_id || item.target_id || "selected item";
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
    return `<div class="empty">Select a seller or subagent to see suggested review actions.</div>`;
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
          <p>${item.seller_id || item.subagent_id || item.target_id || "selected item"}</p>
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
