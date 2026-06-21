export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function humanizeKey(key) {
  return String(key)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function proxyStatus(response) {
  if (response && typeof response.status === "number") {
    return response.status;
  }
  if (response?.ok === true) {
    return 200;
  }
  return 500;
}

export function proxyBody(response) {
  return response?.body ?? response ?? null;
}

export function formatDisplayValue(value) {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return value.trim() ? value : "—";
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "None";
    }
    if (value.every((entry) => typeof entry === "string" || typeof entry === "number")) {
      return value.join(", ");
    }
    return `${value.length} item(s)`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    return keys.length ? `${keys.length} nested field(s)` : "Empty object";
  }
  return String(value);
}

export function renderRawJsonToggle(label, data) {
  return `
    <details class="raw-json-toggle">
      <summary>${escapeHtml(label)}</summary>
      <pre class="output compact raw-json">${escapeHtml(JSON.stringify(data, null, 2))}</pre>
    </details>
  `;
}

export function renderKeyValueList(entries, { limit = 12 } = {}) {
  const pairs = entries.slice(0, limit);
  if (!pairs.length) {
    return `<div class="empty">No fields to display.</div>`;
  }
  return `
    <dl class="kv-list">
      ${pairs
        .map(
          ([key, value]) => `
            <div class="kv-row">
              <dt>${escapeHtml(humanizeKey(key))}</dt>
              <dd>${escapeHtml(formatDisplayValue(value))}</dd>
            </div>
          `
        )
        .join("")}
    </dl>
  `;
}

export function renderOverviewSummary(health, metrics) {
  const healthStatus = proxyStatus(health);
  const healthBody = proxyBody(health);
  const metricsStatus = proxyStatus(metrics);
  const metricsBody = proxyBody(metrics);
  const healthOk = healthStatus < 400 && healthBody?.ok !== false;
  const serviceName = healthBody?.service || "platform-api";
  const healthMessage = healthOk
    ? `${serviceName} is responding normally.`
    : healthBody?.error?.message || "Platform health check failed.";
  const eventTypes = metricsBody?.by_type ? Object.entries(metricsBody.by_type) : [];

  return `
    <div class="stack human-summary">
      <article class="item-card">
        <div class="item-head">
          <div>
            <strong>Platform Health</strong>
            <p>${escapeHtml(healthMessage)}</p>
          </div>
          <span class="status ${healthOk ? "healthy" : "disabled"}">${healthStatus}</span>
        </div>
      </article>
      <article class="item-card">
        <div class="item-head">
          <div>
            <strong>Runtime Metrics</strong>
            <p>${metricsBody?.total_events ?? 0} tracked event(s)</p>
          </div>
          <span class="status ${metricsStatus < 400 ? "healthy" : "disabled"}">${metricsStatus}</span>
        </div>
        ${
          eventTypes.length
            ? `<div class="stack">${eventTypes
                .map(
                  ([type, count]) => `
                    <div class="item-card">
                      <strong>${escapeHtml(type)}</strong>
                      <p class="meta">${count} occurrence(s)</p>
                    </div>
                  `
                )
                .join("")}</div>`
            : `<p class="meta">No event breakdown yet.</p>`
        }
      </article>
      ${renderRawJsonToggle("View raw health/metrics JSON", { health, metrics })}
    </div>
  `;
}

export function renderCatalogSummary(catalogResponse, items = []) {
  if (proxyStatus(catalogResponse) >= 400) {
    const body = proxyBody(catalogResponse);
    return `
      <div class="stack human-summary">
        <article class="item-card">
          <div class="item-head">
            <div>
              <strong>Marketplace Catalog</strong>
              <p>${escapeHtml(body?.error?.message || "Failed to load catalog.")}</p>
            </div>
            <span class="status disabled">${proxyStatus(catalogResponse)}</span>
          </div>
        </article>
        ${renderRawJsonToggle("View raw catalog JSON", catalogResponse)}
      </div>
    `;
  }

  if (!items.length) {
    return `
      <div class="stack human-summary">
        <div class="empty">No public hotlines in the marketplace catalog.</div>
        ${renderRawJsonToggle("View raw catalog JSON", catalogResponse)}
      </div>
    `;
  }

  return `
    <div class="stack human-summary">
      <p class="meta">${items.length} marketplace hotline(s) visible.</p>
      <div class="stack">
        ${items
          .slice(0, 12)
          .map(
            (item) => `
              <article class="item-card">
                <div class="item-head">
                  <div>
                    <strong>${escapeHtml(item.display_name || item.hotline_id || "Unnamed hotline")}</strong>
                    <p>${escapeHtml(item.hotline_id || "unknown hotline id")}</p>
                  </div>
                  <span class="status ${item.catalog_visibility === "public" ? "healthy" : "degraded"}">${escapeHtml(item.catalog_visibility || "hidden")}</span>
                </div>
                <p class="meta">${escapeHtml((item.capabilities || []).join(", ") || "no capabilities")}</p>
              </article>
            `
          )
          .join("")}
      </div>
      ${renderRawJsonToggle("View raw catalog JSON", catalogResponse)}
    </div>
  `;
}

export function renderListLoadedSummary(label, items, rawPayload) {
  const count = Array.isArray(items) ? items.length : 0;
  return `
    <div class="human-summary">
      <p class="meta">${count} ${escapeHtml(label)} loaded${count === 0 ? " (empty result set)" : "."}</p>
      ${renderRawJsonToggle(`View raw ${label} JSON`, rawPayload)}
    </div>
  `;
}

export function renderGatewayResponseSummary(title, response) {
  const status = proxyStatus(response);
  const body = proxyBody(response);
  const ok = status < 400 && body?.ok !== false;
  const message =
    body?.error?.message ||
    body?.session?.authenticated === true
      ? "Operator gateway session is unlocked."
      : body?.session?.setup_required
        ? "Create a local passphrase before unlocking the gateway."
        : body?.session?.locked
          ? "Operator gateway is locked."
          : body?.message ||
            (ok ? "Request completed successfully." : "Request failed.");

  const session = body?.session;
  const detailRows = [];
  if (session) {
    detailRows.push(["Configured", session.configured]);
    detailRows.push(["Authenticated", session.authenticated]);
    detailRows.push(["Locked", session.locked]);
    detailRows.push(["Platform URL", session.platform_url]);
    detailRows.push(["Admin Key Configured", session.admin_api_key_configured]);
    detailRows.push(["Expires At", session.expires_at]);
  }
  if (body?.platform_url) {
    detailRows.push(["Platform URL", body.platform_url]);
  }
  if (typeof body?.api_key_configured === "boolean") {
    detailRows.push(["Admin Key Configured", body.api_key_configured]);
  }
  if (body?.token) {
    detailRows.push(["Session Token", `${String(body.token).slice(0, 8)}…`]);
  }

  return `
    <div class="stack human-summary">
      <article class="item-card">
        <div class="item-head">
          <div>
            <strong>${escapeHtml(title)}</strong>
            <p>${escapeHtml(message)}</p>
          </div>
          <span class="status ${ok ? "healthy" : "disabled"}">${status}</span>
        </div>
        ${detailRows.length ? renderKeyValueList(detailRows) : ""}
      </article>
      ${renderRawJsonToggle("View raw response JSON", response)}
    </div>
  `;
}

export function renderDetailPanel(item) {
  if (!item) {
    return `<div class="empty">No item selected yet.</div>`;
  }
  const entries = Object.entries(item);
  return `
    <div class="stack human-summary">
      ${renderKeyValueList(entries, { limit: 20 })}
      ${renderRawJsonToggle("View raw selection JSON", item)}
    </div>
  `;
}
