import {
  renderAdminRequestCardsMarkup,
  renderAuditCardsMarkup,
  renderDetailSummary,
  renderHistorySummary,
  renderPaginationSummary,
  renderReviewActionSummary,
  renderReviewerGuidance,
  renderReviewCardsMarkup,
  renderEntityCardsMarkup
} from "./view-model.js";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8085";
const storageKeys = {
  actionReason: "rsp.platform.actionReason",
  bootstrapSecret: "rsp.platform.bootstrapSecret",
  reviewerNotes: "rsp.platform.reviewerNotes"
};
const sessionKeys = {
  platformConsoleSession: "rsp.platform.session"
};

const uiState = {
  sessionToken: sessionStorage.getItem(sessionKeys.platformConsoleSession) || null,
  session: null,
  credentials: null,
  responders: [],
  hotlines: [],
  requests: [],
  audit: [],
  reviews: [],
  detail: null,
  loaded: false,
  pagination: {
    responders: { limit: 8, offset: 0, total: 0, has_more: false },
    hotlines: { limit: 8, offset: 0, total: 0, has_more: false },
    requests: { limit: 8, offset: 0, total: 0, has_more: false },
    audit: { limit: 8, offset: 0, total: 0, has_more: false },
    reviews: { limit: 8, offset: 0, total: 0, has_more: false }
  }
};

const sectionLabels = {
  responders: "responders",
  hotlines: "hotlines",
  requests: "requests",
  audit: "audit",
  reviews: "reviews"
};

async function requestJson(baseUrl, pathname, { method = "GET", body } = {}) {
  const headers = {};
  if (uiState.sessionToken) {
    headers["X-Platform-Console-Session"] = uiState.sessionToken;
  }
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json; charset=utf-8" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

function gatewayUrl() {
  if (window.location.port === "8085") {
    return window.location.origin;
  }
  if (window.location.pathname.startsWith("/console")) {
    return `${window.location.origin}/gateway`;
  }
  return DEFAULT_GATEWAY_URL;
}

async function gatewayRequest(pathname, options = {}) {
  return requestJson(gatewayUrl(), pathname, options);
}

async function proxyRequest(pathname, options = {}) {
  return gatewayRequest(`/proxy${pathname}`, options);
}

function setSessionToken(token) {
  uiState.sessionToken = token || null;
  if (token) {
    sessionStorage.setItem(sessionKeys.platformConsoleSession, token);
    return;
  }
  sessionStorage.removeItem(sessionKeys.platformConsoleSession);
}

const app = document.querySelector("#app");

app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <div>
        <p class="eyebrow">Control Plane</p>
        <h1>Platform Control</h1>
        <p class="lede">Health, Hotline catalog, request oversight, and operator actions for the platform through a local gateway.</p>
      </div>
      <div class="status-block">
        <span class="pill">Health</span>
        <span class="pill cool">Metrics</span>
        <span class="pill warm">Admin</span>
      </div>
    </section>

    <section class="card endpoint">
      <div class="section-head">
        <div>
          <p class="eyebrow">Local Session</p>
          <h2>Unlock Operator Gateway</h2>
        </div>
        <button id="logout-session" class="ghost">Logout</button>
      </div>
      <div id="session-state" class="stack"></div>
      <div class="grid three">
        <div>
          <label>Passphrase</label>
          <input id="session-passphrase" type="password" placeholder="At least 8 characters" />
        </div>
        <div>
          <label>New Passphrase</label>
          <input id="session-next-passphrase" type="password" placeholder="For setup or rotation" />
        </div>
        <div>
          <label>Bootstrap Secret</label>
          <input id="session-bootstrap-secret" type="password" placeholder="Required when gateway is public" />
        </div>
      </div>
      <div class="actions inline">
        <button id="setup-session">Create Local Passphrase</button>
        <button id="login-session" class="ghost">Unlock</button>
        <button id="change-passphrase" class="ghost">Change Passphrase</button>
      </div>
      <pre id="session-output" class="output compact">Operator session not initialized yet.</pre>
    </section>

    <section class="card endpoint">
      <div class="section-head">
        <div>
          <p class="eyebrow">Gateway Credentials</p>
          <h2>Platform Endpoint</h2>
        </div>
        <div class="actions inline">
          <button id="save-credentials">Save Credential</button>
          <button id="refresh-overview">Refresh Overview</button>
        </div>
      </div>
      <div class="grid three">
        <div>
          <label>Platform API URL</label>
          <input id="platform-url" value="http://127.0.0.1:8080" />
        </div>
        <div>
          <label>Operator API Key</label>
          <input id="platform-api-key" type="password" placeholder="sk_admin_..." />
        </div>
        <div>
          <label>Credential State</label>
          <p id="credential-state" class="meta">Not configured yet.</p>
        </div>
      </div>
      <label>Approval / Audit Reason</label>
      <input id="action-reason" value="operator review" />
      <label>Reviewer Notes</label>
      <textarea id="reviewer-notes" rows="4" placeholder="What was reviewed, what is being approved/rejected, and any follow-up."></textarea>
          <label>Global Filter</label>
      <input id="global-filter" placeholder="responder, hotline, request, action..." />
      <label>Section Filter</label>
      <select id="section-filter">
        <option value="all">all</option>
        <option value="responders">responders</option>
        <option value="hotlines">hotlines</option>
        <option value="requests">requests</option>
        <option value="audit">audit</option>
        <option value="reviews">reviews</option>
      </select>
    </section>

    <div id="console-body">
      <section class="grid three-panels">
        <div class="card">
          <h2>Overview</h2>
          <pre id="overview-output" class="output">Waiting for platform gateway.</pre>
        </div>
        <div class="card">
          <div class="section-head">
            <h2>Responders</h2>
            <div class="actions inline">
              <button id="responders-prev" class="ghost">Prev</button>
              <button id="responders-next" class="ghost">Next</button>
              <button id="refresh-responders" class="ghost">Reload</button>
            </div>
          </div>
          <p id="responders-page" class="meta">responders: no data</p>
          <div id="responders-list" class="stack"></div>
        </div>
        <div class="card">
          <div class="section-head">
            <h2>Hotlines</h2>
            <div class="actions inline">
              <button id="hotlines-prev" class="ghost">Prev</button>
              <button id="hotlines-next" class="ghost">Next</button>
              <button id="refresh-hotlines" class="ghost">Reload</button>
            </div>
          </div>
          <p id="hotlines-page" class="meta">hotlines: no data</p>
          <div id="hotlines-list" class="stack"></div>
        </div>
      </section>

      <section class="grid two">
        <div class="card">
          <div class="section-head">
            <h2>Requests</h2>
            <div class="actions inline">
              <button id="requests-prev" class="ghost">Prev</button>
              <button id="requests-next" class="ghost">Next</button>
              <button id="refresh-requests" class="ghost">Reload</button>
            </div>
          </div>
          <p id="requests-page" class="meta">requests: no data</p>
          <div id="requests-list" class="stack"></div>
          <pre id="requests-output" class="output compact">No request data loaded yet.</pre>
        </div>
        <div class="card">
          <div class="section-head">
            <h2>Hotline Catalog Control</h2>
            <button id="refresh-catalog" class="ghost">Reload</button>
          </div>
          <pre id="catalog-output" class="output compact">No catalog data loaded yet.</pre>
        </div>
      </section>

      <section class="grid two">
        <div class="card">
          <div class="section-head">
            <h2>Audit Trail</h2>
            <div class="actions inline">
              <button id="audit-prev" class="ghost">Prev</button>
              <button id="audit-next" class="ghost">Next</button>
              <button id="refresh-audit" class="ghost">Reload</button>
            </div>
          </div>
          <p id="audit-page" class="meta">audit: no data</p>
          <div id="audit-list" class="stack"></div>
          <pre id="audit-output" class="output compact">No audit data loaded yet.</pre>
        </div>
        <div class="card">
          <div class="section-head">
            <h2>Responder Review Queue</h2>
            <div class="actions inline">
              <button id="reviews-prev" class="ghost">Prev</button>
              <button id="reviews-next" class="ghost">Next</button>
              <button id="refresh-reviews" class="ghost">Reload</button>
            </div>
          </div>
          <p id="reviews-page" class="meta">reviews: no data</p>
          <div id="reviews-list" class="stack"></div>
          <pre id="reviews-output" class="output compact">No review data loaded yet.</pre>
        </div>
      </section>

      <section class="grid one">
        <div class="card">
          <div class="section-head">
            <h2>Selection Detail</h2>
          </div>
          <div id="reviewer-guidance" class="stack"></div>
          <div id="review-action-summary" class="stack"></div>
          <div id="detail-summary" class="stack"></div>
          <div id="detail-history" class="stack"></div>
          <pre id="detail-output" class="output compact">No item selected yet.</pre>
        </div>
      </section>
    </div>
  </main>
`;

const consoleBody = document.querySelector("#console-body");
const sessionState = document.querySelector("#session-state");
const sessionOutput = document.querySelector("#session-output");
const sessionPassphraseInput = document.querySelector("#session-passphrase");
const sessionNextPassphraseInput = document.querySelector("#session-next-passphrase");
const sessionBootstrapSecretInput = document.querySelector("#session-bootstrap-secret");
const platformUrlInput = document.querySelector("#platform-url");
const platformKeyInput = document.querySelector("#platform-api-key");
const credentialState = document.querySelector("#credential-state");
const actionReasonInput = document.querySelector("#action-reason");
const reviewerNotesInput = document.querySelector("#reviewer-notes");
const globalFilterInput = document.querySelector("#global-filter");
const sectionFilterInput = document.querySelector("#section-filter");
const overviewOutput = document.querySelector("#overview-output");
const requestsOutput = document.querySelector("#requests-output");
const requestsList = document.querySelector("#requests-list");
const catalogOutput = document.querySelector("#catalog-output");
const auditOutput = document.querySelector("#audit-output");
const auditList = document.querySelector("#audit-list");
const reviewsOutput = document.querySelector("#reviews-output");
const reviewsList = document.querySelector("#reviews-list");
const reviewerGuidance = document.querySelector("#reviewer-guidance");
const reviewActionSummary = document.querySelector("#review-action-summary");
const detailSummary = document.querySelector("#detail-summary");
const detailHistory = document.querySelector("#detail-history");
const detailOutput = document.querySelector("#detail-output");
const respondersList = document.querySelector("#responders-list");
const hotlinesList = document.querySelector("#hotlines-list");
const pageOutputs = {
  responders: document.querySelector("#responders-page"),
  hotlines: document.querySelector("#hotlines-page"),
  requests: document.querySelector("#requests-page"),
  audit: document.querySelector("#audit-page"),
  reviews: document.querySelector("#reviews-page")
};

function savePrefs() {
  localStorage.setItem(storageKeys.actionReason, actionReasonInput.value);
  localStorage.setItem(storageKeys.bootstrapSecret, sessionBootstrapSecretInput.value);
  localStorage.setItem(storageKeys.reviewerNotes, reviewerNotesInput.value);
}

function loadPrefs() {
  actionReasonInput.value = localStorage.getItem(storageKeys.actionReason) || actionReasonInput.value;
  sessionBootstrapSecretInput.value = localStorage.getItem(storageKeys.bootstrapSecret) || "";
  reviewerNotesInput.value = localStorage.getItem(storageKeys.reviewerNotes) || "";
}

function applyFilter(items) {
  const term = globalFilterInput.value.trim().toLowerCase();
  if (!term) {
    return items;
  }
  return items.filter((item) => JSON.stringify(item).toLowerCase().includes(term));
}

function sectionVisible(section) {
  return sectionFilterInput.value === "all" || sectionFilterInput.value === section;
}

function updatePageSummary(section) {
  pageOutputs[section].textContent = renderPaginationSummary(uiState.pagination[section], sectionLabels[section] || section);
}

function queryWithPagination(section) {
  const query = new URLSearchParams({
    limit: String(uiState.pagination[section].limit),
    offset: String(uiState.pagination[section].offset)
  });
  const q = globalFilterInput.value.trim();
  if (q) {
    query.set("q", q);
  }
  return query;
}

function setDetail(item) {
  uiState.detail = item;
  reviewerGuidance.innerHTML = renderReviewerGuidance(item);
  detailSummary.innerHTML = renderDetailSummary(item);
  const responderId = item?.responder_id || (item?.target_type === "responder" ? item.target_id : null);
  const hotlineId =
    item?.hotline_id ||
    (item?.target_type === "hotline" ? item.target_id : null) ||
    (item?.responder_id ? null : item?.hotline_id || null);
  const matchingReviews = uiState.reviews.filter(
    (entry) =>
      (responderId && entry.target_type === "responder" && entry.target_id === responderId) ||
      (hotlineId && entry.target_type === "hotline" && entry.target_id === hotlineId)
  );
  const matchingAudit = uiState.audit.filter(
    (entry) =>
      (responderId && entry.target_type === "responder" && entry.target_id === responderId) ||
      (hotlineId && entry.target_type === "hotline" && entry.target_id === hotlineId)
  );
  const combinedHistory = [...matchingReviews, ...matchingAudit].sort((left, right) =>
    String(right.recorded_at || "").localeCompare(String(left.recorded_at || ""))
  );
  detailHistory.innerHTML = `
    ${renderHistorySummary(matchingReviews, "Review History")}
    ${renderHistorySummary(matchingAudit, "Audit History")}
  `;
  reviewActionSummary.innerHTML = renderReviewActionSummary(item, reviewerNotesInput.value.trim(), combinedHistory);
  detailOutput.textContent = item ? JSON.stringify(item, null, 2) : "No item selected yet.";
}

function renderSessionState() {
  const session = uiState.session || {};
  const ready = session.authenticated && uiState.credentials?.api_key_configured;
  if (session.setup_required) {
    sessionState.innerHTML = `
      <article class="item-card">
        <div class="item-head">
          <div>
            <strong>Create Local Passphrase</strong>
            <p>Initialize the shared encrypted secret store used by local control surfaces.</p>
          </div>
          <span class="status disabled">setup required</span>
        </div>
      </article>
    `;
  } else if (!session.authenticated) {
    sessionState.innerHTML = `
      <article class="item-card">
        <div class="item-head">
          <div>
            <strong>Operator Gateway Locked</strong>
            <p>Unlock the local gateway before using platform admin actions.</p>
          </div>
          <span class="status disabled">locked</span>
        </div>
      </article>
    `;
  } else {
    sessionState.innerHTML = `
      <article class="item-card">
        <div class="item-head">
          <div>
            <strong>Operator Gateway Unlocked</strong>
            <p>Admin credentials remain server-side in the local gateway only.</p>
          </div>
          <span class="status healthy">authenticated</span>
        </div>
        <p class="meta">Session expires at: ${session.expires_at || "n/a"}</p>
      </article>
    `;
  }
  credentialState.textContent = uiState.credentials?.api_key_configured
    ? "Configured in local encrypted secret store."
    : "Not configured yet.";
  consoleBody.style.display = ready ? "" : "none";
}

async function refreshSession() {
  const response = await gatewayRequest("/session");
  uiState.session = response.body?.session || null;
  renderSessionState();
}

async function refreshCredentials() {
  if (!uiState.session?.authenticated) {
    uiState.credentials = null;
    renderSessionState();
    return;
  }
  const response = await gatewayRequest("/credentials/platform-admin");
  if (response.status === 200) {
    uiState.credentials = response.body;
    platformUrlInput.value = response.body.platform_url || platformUrlInput.value;
  } else {
    uiState.credentials = null;
  }
  renderSessionState();
}

async function setupSession() {
  const passphrase = sessionNextPassphraseInput.value.trim() || sessionPassphraseInput.value.trim();
  const bootstrapSecret = sessionBootstrapSecretInput.value.trim();
  const response = await gatewayRequest("/session/setup", {
    method: "POST",
    body: {
      passphrase,
      ...(bootstrapSecret ? { bootstrap_secret: bootstrapSecret } : {})
    }
  });
  sessionOutput.textContent = JSON.stringify(response, null, 2);
  if (response.status < 400) {
    setSessionToken(response.body?.token || null);
    sessionPassphraseInput.value = "";
    sessionNextPassphraseInput.value = "";
    await refreshSession();
    await refreshCredentials();
  }
}

async function loginSession() {
  const response = await gatewayRequest("/session/login", {
    method: "POST",
    body: { passphrase: sessionPassphraseInput.value.trim() }
  });
  sessionOutput.textContent = JSON.stringify(response, null, 2);
  if (response.status < 400) {
    setSessionToken(response.body?.token || null);
    sessionPassphraseInput.value = "";
    sessionNextPassphraseInput.value = "";
    await refreshSession();
    await refreshCredentials();
    if (uiState.credentials?.api_key_configured && !uiState.loaded) {
      uiState.loaded = true;
      await refreshAll();
    }
  }
}

async function logoutSession() {
  const response = await gatewayRequest("/session/logout", {
    method: "POST",
    body: {}
  });
  setSessionToken(null);
  sessionOutput.textContent = JSON.stringify(response, null, 2);
  uiState.session = response.body?.session || null;
  uiState.credentials = null;
  uiState.loaded = false;
  renderSessionState();
}

async function changePassphrase() {
  const response = await gatewayRequest("/session/change-passphrase", {
    method: "POST",
    body: { next_passphrase: sessionNextPassphraseInput.value.trim() }
  });
  sessionOutput.textContent = JSON.stringify(response, null, 2);
  if (response.status < 400) {
    sessionPassphraseInput.value = "";
    sessionNextPassphraseInput.value = "";
    await refreshSession();
  }
}

async function saveCredentials() {
  const response = await gatewayRequest("/credentials/platform-admin", {
    method: "PUT",
    body: {
      base_url: platformUrlInput.value.trim(),
      api_key: platformKeyInput.value.trim()
    }
  });
  sessionOutput.textContent = JSON.stringify(response, null, 2);
  if (response.status < 400) {
    platformKeyInput.value = "";
    await refreshCredentials();
    if (uiState.credentials?.api_key_configured) {
      uiState.loaded = true;
      await refreshAll();
    }
  }
}

async function refreshOverview() {
  if (!uiState.credentials?.api_key_configured) {
    overviewOutput.textContent = "Save platform credentials in the local gateway first.";
    return;
  }
  const [health, metrics] = await Promise.all([proxyRequest("/healthz"), proxyRequest("/v1/metrics/summary")]);
  overviewOutput.textContent = JSON.stringify({ health, metrics }, null, 2);
}

async function refreshCatalog() {
  if (!uiState.credentials?.api_key_configured) {
    catalogOutput.textContent = "Save platform credentials in the local gateway first.";
    return;
  }
  const catalog = await proxyRequest("/v2/hotlines");
  catalogOutput.textContent = JSON.stringify({ ...catalog, body: { items: applyFilter(catalog.body?.items || []) } }, null, 2);
}

async function refreshRequests() {
  if (!sectionVisible("requests")) {
    requestsList.innerHTML = `<div class="empty">Requests hidden by section filter.</div>`;
    return;
  }
  const requests = await proxyRequest(`/v1/admin/requests?${queryWithPagination("requests").toString()}`);
  uiState.requests = requests.body?.items || [];
  uiState.pagination.requests = requests.body?.pagination || uiState.pagination.requests;
  const filteredItems = applyFilter(uiState.requests);
  requestsList.innerHTML = renderAdminRequestCardsMarkup(filteredItems);
  updatePageSummary("requests");
  requestsOutput.textContent = JSON.stringify({ ...requests, body: { items: filteredItems } }, null, 2);
}

async function refreshResponders() {
  if (!sectionVisible("responders")) {
    respondersList.innerHTML = `<div class="empty">Responders hidden by section filter.</div>`;
    return;
  }
  const responders = await proxyRequest(`/v2/admin/responders?${queryWithPagination("responders").toString()}`);
  uiState.responders = responders.body?.items || [];
  uiState.pagination.responders = responders.body?.pagination || uiState.pagination.responders;
  respondersList.innerHTML = renderEntityCardsMarkup(applyFilter(uiState.responders), "responders");
  updatePageSummary("responders");
}

async function refreshHotlines() {
  if (!sectionVisible("hotlines")) {
    hotlinesList.innerHTML = `<div class="empty">Hotlines hidden by section filter.</div>`;
    return;
  }
  const hotlines = await proxyRequest(`/v2/admin/hotlines?${queryWithPagination("hotlines").toString()}`);
  uiState.hotlines = hotlines.body?.items || [];
  uiState.pagination.hotlines = hotlines.body?.pagination || uiState.pagination.hotlines;
  hotlinesList.innerHTML = renderEntityCardsMarkup(applyFilter(uiState.hotlines), "hotlines");
  updatePageSummary("hotlines");
}

async function refreshAudit() {
  if (!sectionVisible("audit")) {
    auditList.innerHTML = `<div class="empty">Audit hidden by section filter.</div>`;
    return;
  }
  const audit = await proxyRequest(`/v1/admin/audit-events?${queryWithPagination("audit").toString()}`);
  uiState.audit = audit.body?.items || [];
  uiState.pagination.audit = audit.body?.pagination || uiState.pagination.audit;
  const filteredItems = applyFilter(uiState.audit);
  auditList.innerHTML = renderAuditCardsMarkup(filteredItems);
  updatePageSummary("audit");
  auditOutput.textContent = JSON.stringify({ ...audit, body: { items: filteredItems } }, null, 2);
}

async function refreshReviews() {
  if (!sectionVisible("reviews")) {
    reviewsList.innerHTML = `<div class="empty">Reviews hidden by section filter.</div>`;
    return;
  }
  const reviews = await proxyRequest(`/v1/admin/reviews?${queryWithPagination("reviews").toString()}`);
  uiState.reviews = reviews.body?.items || [];
  uiState.pagination.reviews = reviews.body?.pagination || uiState.pagination.reviews;
  const filteredItems = applyFilter(uiState.reviews);
  reviewsList.innerHTML = renderReviewCardsMarkup(filteredItems);
  updatePageSummary("reviews");
  reviewsOutput.textContent = JSON.stringify({ ...reviews, body: { items: filteredItems } }, null, 2);
}

async function refreshAll() {
  await Promise.all([refreshOverview(), refreshResponders(), refreshHotlines(), refreshRequests(), refreshCatalog(), refreshAudit(), refreshReviews()]);
}

async function runAction(type, id, action) {
  const pathname = type === "responders" ? `/v2/admin/responders/${id}/${action}` : `/v2/admin/hotlines/${id}/${action}`;
  await proxyRequest(pathname, {
    method: "POST",
    body: {
      reason: reviewerNotesInput.value.trim() || actionReasonInput.value.trim() || null
    }
  });
  await Promise.all([refreshResponders(), refreshHotlines(), refreshCatalog(), refreshAudit(), refreshReviews()]);
}

respondersList.addEventListener("click", async (event) => {
  const card = event.target.closest("[data-detail-id]");
  if (card && !event.target.closest("button")) {
    setDetail(uiState.responders.find((item) => item.responder_id === card.dataset.detailId) || null);
  }
  const button = event.target.closest("button[data-type='responders']");
  if (button) {
    await runAction("responders", button.dataset.id, button.dataset.action);
  }
});

hotlinesList.addEventListener("click", async (event) => {
  const card = event.target.closest("[data-detail-id]");
  if (card && !event.target.closest("button")) {
    setDetail(uiState.hotlines.find((item) => item.hotline_id === card.dataset.detailId) || null);
  }
  const button = event.target.closest("button[data-type='hotlines']");
  if (button) {
    await runAction("hotlines", button.dataset.id, button.dataset.action);
  }
});

requestsList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-detail-id]");
  if (card) {
    setDetail(uiState.requests.find((item) => item.request_id === card.dataset.detailId) || null);
  }
});

auditList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-detail-id]");
  if (card) {
    setDetail(uiState.audit.find((item) => item.id === card.dataset.detailId) || null);
  }
});

reviewsList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-detail-id]");
  if (card) {
    setDetail(uiState.reviews.find((item) => item.id === card.dataset.detailId) || null);
  }
});

for (const section of ["responders", "hotlines", "requests", "audit", "reviews"]) {
  document.querySelector(`#${section}-prev`).addEventListener("click", async () => {
    const pagination = uiState.pagination[section];
    pagination.offset = Math.max(0, pagination.offset - pagination.limit);
    await ({ responders: refreshResponders, hotlines: refreshHotlines, requests: refreshRequests, audit: refreshAudit, reviews: refreshReviews }[section])();
  });
  document.querySelector(`#${section}-next`).addEventListener("click", async () => {
    const pagination = uiState.pagination[section];
    if (!pagination.has_more) {
      return;
    }
    pagination.offset += pagination.limit;
    await ({ responders: refreshResponders, hotlines: refreshHotlines, requests: refreshRequests, audit: refreshAudit, reviews: refreshReviews }[section])();
  });
}

document.querySelector("#setup-session").addEventListener("click", setupSession);
document.querySelector("#login-session").addEventListener("click", loginSession);
document.querySelector("#logout-session").addEventListener("click", logoutSession);
document.querySelector("#change-passphrase").addEventListener("click", changePassphrase);
document.querySelector("#save-credentials").addEventListener("click", saveCredentials);
document.querySelector("#refresh-overview").addEventListener("click", refreshAll);
document.querySelector("#refresh-responders").addEventListener("click", refreshResponders);
document.querySelector("#refresh-hotlines").addEventListener("click", refreshHotlines);
document.querySelector("#refresh-requests").addEventListener("click", refreshRequests);
document.querySelector("#refresh-catalog").addEventListener("click", refreshCatalog);
document.querySelector("#refresh-audit").addEventListener("click", refreshAudit);
document.querySelector("#refresh-reviews").addEventListener("click", refreshReviews);
globalFilterInput.addEventListener("input", () => {
  for (const pagination of Object.values(uiState.pagination)) {
    pagination.offset = 0;
  }
  if (uiState.credentials?.api_key_configured) {
    void refreshAll();
  }
});
sectionFilterInput.addEventListener("change", () => {
  if (uiState.credentials?.api_key_configured) {
    void Promise.all([refreshResponders(), refreshHotlines(), refreshRequests(), refreshAudit(), refreshReviews()]);
  }
});
for (const input of [platformUrlInput, actionReasonInput, reviewerNotesInput, sessionBootstrapSecretInput]) {
  input.addEventListener("change", savePrefs);
  input.addEventListener("blur", savePrefs);
}
reviewerNotesInput.addEventListener("input", () => {
  if (uiState.detail) {
    setDetail(uiState.detail);
  }
});

loadPrefs();
void (async () => {
  await refreshSession();
  await refreshCredentials();
  if (uiState.credentials?.api_key_configured) {
    uiState.loaded = true;
    await refreshAll();
  }
})();
