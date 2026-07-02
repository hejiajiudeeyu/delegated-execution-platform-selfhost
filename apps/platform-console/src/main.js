import {
  CONSOLE_NAV,
  DEFAULT_EXPANDED_GROUPS,
  DEFAULT_PANEL,
  findNavLeaf,
  findNavLeafBySection,
  panelMeta,
  renderSidebarMarkup
} from "./nav-model.js";
import {
  renderCatalogSummary,
  renderDetailPanel,
  renderGatewayResponseSummary,
  renderListLoadedSummary,
  renderOverviewSummary
} from "./human-view.js";
import { renderConsoleShellMarkup } from "./shell-markup.js";
import {
  renderAdminRequestCardsMarkup,
  renderAuditCardsMarkup,
  renderBillingBalanceSummary,
  renderBillingLedgerSummary,
  renderDetailSummary,
  renderHistorySummary,
  renderPaginationSummary,
  renderReviewActionSummary,
  renderReviewerGuidance,
  renderPendingReviewQueueMarkup,
  renderEntityCardsMarkup
} from "./view-model.js";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8085";
const storageKeys = {
  actionReason: "rsp.platform.actionReason",
  billingTenantHistory: "rsp.platform.billingTenantHistory",
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
  billing: {
    balance: null,
    ledger: [],
    tenantHistory: []
  },
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
  reviews: "reviews",
  billing: "billing"
};

const paginatedSections = ["responders", "hotlines", "requests", "audit", "reviews"];

const navState = {
  activePanel: DEFAULT_PANEL,
  previousPanel: DEFAULT_PANEL,
  expandedGroups: new Set(DEFAULT_EXPANDED_GROUPS)
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
app.innerHTML = renderConsoleShellMarkup();

const sidebarNav = document.querySelector("#sidebar-nav");
const sessionBadge = document.querySelector("#session-badge");
const contentTitle = document.querySelector("#content-title");
const contentDescription = document.querySelector("#content-description");
const lockBanner = document.querySelector("#lock-banner");
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
const billingTenantInput = document.querySelector("#billing-tenant-id");
const billingTenantOptions = document.querySelector("#billing-tenant-options");
const billingRechargeIdInput = document.querySelector("#billing-recharge-id");
const billingRechargeAmountInput = document.querySelector("#billing-recharge-amount");
const billingRechargeProviderInput = document.querySelector("#billing-recharge-provider");
const billingRechargeReferenceInput = document.querySelector("#billing-recharge-reference");
const billingBalance = document.querySelector("#billing-balance");
const billingLedger = document.querySelector("#billing-ledger");
const billingOutput = document.querySelector("#billing-output");
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

function hasAdminCredentialsConfigured() {
  const session = uiState.session || {};
  return Boolean(session.admin_api_key_configured || uiState.credentials?.api_key_configured);
}

function isClientSessionActive() {
  const session = uiState.session || {};
  return Boolean(uiState.sessionToken && session.authenticated);
}

function operatorDataReady() {
  return Boolean(isClientSessionActive() && hasAdminCredentialsConfigured());
}

function syncLockBanner() {
  const onSettingsPanel = navState.activePanel === "session" || navState.activePanel === "credentials";
  lockBanner.hidden = operatorDataReady() || onSettingsPanel;
}

function initialPanelFromUrl() {
  const urlSection = new URLSearchParams(window.location.search).get("section");
  const hashSection = window.location.hash.replace(/^#\/?/, "");
  const pathSection = window.location.pathname.replace(/\/$/, "").split("/").pop();
  const candidates = [urlSection, hashSection, pathSection].filter(Boolean);
  for (const candidate of candidates) {
    const leaf = findNavLeafBySection(candidate) || findNavLeaf(candidate);
    if (leaf) {
      return leaf.panel;
    }
  }
  return DEFAULT_PANEL;
}

function renderContentHeader() {
  const meta = panelMeta(navState.activePanel);
  contentTitle.textContent = meta.title;
  contentDescription.textContent = meta.description;
}

function renderSessionBadge() {
  const session = uiState.session || {};
  let status = "ready";
  let label = "Ready";
  if (session.setup_required) {
    status = "setup";
    label = "Setup required";
  } else if (!session.authenticated) {
    status = "locked";
    label = "Locked";
  } else if (!uiState.sessionToken) {
    status = "locked";
    label = "Unlock required";
  } else if (!hasAdminCredentialsConfigured()) {
    status = "needs-creds";
    label = "Needs credentials";
  }
  sessionBadge.innerHTML = `
    <span class="session-badge-dot session-badge-dot--${status}" aria-hidden="true"></span>
    <span class="session-badge-label">${label}</span>
  `;
}

function renderNav() {
  sidebarNav.innerHTML = renderSidebarMarkup({
    activePanel: navState.activePanel,
    expandedGroups: navState.expandedGroups,
    dataReady: operatorDataReady()
  });
}

function syncPanelVisibility() {
  for (const panel of document.querySelectorAll(".content-panel")) {
    const isActive = panel.dataset.panel === navState.activePanel;
    panel.hidden = !isActive;
    panel.classList.toggle("is-active", isActive);
  }
}

function expandGroupForPanel(panelId) {
  for (const item of CONSOLE_NAV) {
    if ("children" in item && item.children.some((child) => child.panel === panelId)) {
      navState.expandedGroups.add(item.id);
    }
  }
}

async function refreshActivePanel() {
  const refreshers = {
    overview: refreshOverview,
    responders: refreshResponders,
    hotlines: refreshHotlines,
    catalog: refreshCatalog,
    requests: refreshRequests,
    audit: refreshAudit,
    reviews: refreshReviews,
    billing: refreshBilling,
    session: refreshSession,
    credentials: refreshCredentials,
    detail: async () => {}
  };
  const refresh = refreshers[navState.activePanel];
  if (refresh) {
    await refresh();
  }
}

async function activatePanel(panelId, { pushHistory = true, force = false } = {}) {
  if (panelId === "detail") {
    navState.previousPanel = navState.activePanel;
    navState.activePanel = panelId;
    renderContentHeader();
    renderNav();
    syncPanelVisibility();
    return;
  }

  const leaf = findNavLeaf(panelId);
  if (!leaf) {
    return;
  }
  if (!force && leaf.requiresData && !operatorDataReady()) {
    activatePanel("session", { pushHistory: false, force: true });
    return;
  }

  navState.activePanel = panelId;
  expandGroupForPanel(panelId);
  renderContentHeader();
  renderNav();
  syncPanelVisibility();
  syncLockBanner();

  if (pushHistory) {
    const section = leaf.section;
    const nextUrl = section
      ? `${window.location.pathname}${window.location.search}#${section}`
      : `${window.location.pathname}${window.location.search}`;
    history.replaceState(null, "", nextUrl);
  }

  if (leaf.requiresData && operatorDataReady()) {
    await refreshActivePanel();
  }
}

function loadPrefs() {
  actionReasonInput.value = localStorage.getItem(storageKeys.actionReason) || actionReasonInput.value;
  sessionBootstrapSecretInput.value = localStorage.getItem(storageKeys.bootstrapSecret) || "";
  reviewerNotesInput.value = localStorage.getItem(storageKeys.reviewerNotes) || "";
  uiState.billing.tenantHistory = loadBillingTenantHistory();
  renderBillingTenantOptions();
  billingTenantInput.value = uiState.billing.tenantHistory[0] || billingTenantInput.value;
  navState.activePanel = initialPanelFromUrl();
  expandGroupForPanel(navState.activePanel);
}

function loadBillingTenantHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKeys.billingTenantHistory) || "[]");
    if (Array.isArray(parsed)) {
      const history = parsed.filter((item) => typeof item === "string" && item.trim()).slice(0, 10);
      return history.length ? history : ["tenant_default"];
    }
  } catch {
    // Ignore malformed local operator preferences.
  }
  return ["tenant_default"];
}

function saveBillingTenantHistory() {
  localStorage.setItem(storageKeys.billingTenantHistory, JSON.stringify(uiState.billing.tenantHistory.slice(0, 10)));
}

function rememberBillingTenant(tenantId) {
  const nextTenant = tenantId.trim();
  if (!nextTenant) {
    return;
  }
  uiState.billing.tenantHistory = [nextTenant, ...uiState.billing.tenantHistory.filter((item) => item !== nextTenant)].slice(0, 10);
  saveBillingTenantHistory();
  renderBillingTenantOptions();
}

function renderBillingTenantOptions() {
  billingTenantOptions.innerHTML = uiState.billing.tenantHistory.map((tenantId) => `<option value="${tenantId}"></option>`).join("");
}

function applyFilter(items) {
  const term = globalFilterInput.value.trim().toLowerCase();
  if (!term) {
    return items;
  }
  return items.filter((item) => JSON.stringify(item).toLowerCase().includes(term));
}

function setDetail(item, { navigate = true } = {}) {
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
  detailOutput.innerHTML = renderDetailPanel(item);
  if (navigate) {
    void activatePanel("detail", { pushHistory: false });
  }
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

function renderSessionState() {
  const session = uiState.session || {};
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
  credentialState.textContent = hasAdminCredentialsConfigured()
    ? "Configured in local encrypted secret store."
    : "Not configured yet.";
  renderSessionBadge();
  renderNav();
  syncLockBanner();
}

async function refreshSession() {
  const response = await gatewayRequest("/session");
  uiState.session = response.body?.session || null;
  renderSessionState();
}

async function refreshCredentials() {
  if (!isClientSessionActive()) {
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
  sessionOutput.innerHTML = renderGatewayResponseSummary("Create Local Passphrase", response);
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
  sessionOutput.innerHTML = renderGatewayResponseSummary("Unlock Operator Gateway", response);
  if (response.status < 400) {
    setSessionToken(response.body?.token || null);
    if (response.body?.session) {
      uiState.session = response.body.session;
    }
    sessionPassphraseInput.value = "";
    sessionNextPassphraseInput.value = "";
    await refreshSession();
    await refreshCredentials();
    syncLockBanner();
    if (operatorDataReady() && !uiState.loaded) {
      uiState.loaded = true;
      await refreshAll();
    }
    if (operatorDataReady() && (navState.activePanel === "session" || navState.activePanel === "overview")) {
      await activatePanel(DEFAULT_PANEL, { pushHistory: false, force: true });
    }
  }
}

async function logoutSession() {
  const response = await gatewayRequest("/session/logout", {
    method: "POST",
    body: {}
  });
  setSessionToken(null);
  sessionOutput.innerHTML = renderGatewayResponseSummary("Logout", response);
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
  sessionOutput.innerHTML = renderGatewayResponseSummary("Change Passphrase", response);
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
  sessionOutput.innerHTML = renderGatewayResponseSummary("Save Gateway Credentials", response);
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
    overviewOutput.innerHTML = `<div class="empty">Save platform credentials in the local gateway first.</div>`;
    return;
  }
  const [health, metrics] = await Promise.all([proxyRequest("/healthz"), proxyRequest("/v1/metrics/summary")]);
  overviewOutput.innerHTML = renderOverviewSummary(health, metrics);
}

async function refreshCatalog() {
  if (!uiState.credentials?.api_key_configured) {
    catalogOutput.innerHTML = `<div class="empty">Save platform credentials in the local gateway first.</div>`;
    return;
  }
  const catalog = await proxyRequest("/v2/hotlines");
  const filteredItems = applyFilter(catalog.body?.items || []);
  catalogOutput.innerHTML = renderCatalogSummary(catalog, filteredItems);
}

async function refreshRequests() {
  const requests = await proxyRequest(`/v1/admin/requests?${queryWithPagination("requests").toString()}`);
  uiState.requests = requests.body?.items || [];
  uiState.pagination.requests = requests.body?.pagination || uiState.pagination.requests;
  const filteredItems = applyFilter(uiState.requests);
  requestsList.innerHTML = renderAdminRequestCardsMarkup(filteredItems);
  updatePageSummary("requests");
  requestsOutput.innerHTML = renderListLoadedSummary("requests", filteredItems, {
    ...requests,
    body: { items: filteredItems }
  });
}

async function refreshResponders() {
  const responders = await proxyRequest(`/v2/admin/responders?${queryWithPagination("responders").toString()}`);
  uiState.responders = responders.body?.items || [];
  uiState.pagination.responders = responders.body?.pagination || uiState.pagination.responders;
  respondersList.innerHTML = renderEntityCardsMarkup(applyFilter(uiState.responders), "responders");
  updatePageSummary("responders");
}

async function refreshHotlines() {
  const hotlines = await proxyRequest(`/v2/admin/hotlines?${queryWithPagination("hotlines").toString()}`);
  uiState.hotlines = hotlines.body?.items || [];
  uiState.pagination.hotlines = hotlines.body?.pagination || uiState.pagination.hotlines;
  hotlinesList.innerHTML = renderEntityCardsMarkup(applyFilter(uiState.hotlines), "hotlines");
  updatePageSummary("hotlines");
}

async function refreshAudit() {
  const audit = await proxyRequest(`/v1/admin/audit-events?${queryWithPagination("audit").toString()}`);
  uiState.audit = audit.body?.items || [];
  uiState.pagination.audit = audit.body?.pagination || uiState.pagination.audit;
  const filteredItems = applyFilter(uiState.audit);
  auditList.innerHTML = renderAuditCardsMarkup(filteredItems);
  updatePageSummary("audit");
  auditOutput.innerHTML = renderListLoadedSummary("audit events", filteredItems, {
    ...audit,
    body: { items: filteredItems }
  });
}

async function refreshReviews() {
  const [pendingResponders, pendingHotlines, enableResponders, enableHotlines] = await Promise.all([
    proxyRequest("/v2/admin/responders?review_status=pending&limit=50"),
    proxyRequest("/v2/admin/hotlines?review_status=pending&limit=50"),
    proxyRequest("/v2/admin/responders?review_status=approved&status=disabled&limit=50"),
    proxyRequest("/v2/admin/hotlines?review_status=approved&status=disabled&limit=50")
  ]);
  const merged = [
    ...(pendingResponders.body?.items || []).map((item) => ({ ...item, _entityType: "responders" })),
    ...(pendingHotlines.body?.items || []).map((item) => ({ ...item, _entityType: "hotlines" })),
    ...(enableResponders.body?.items || []).map((item) => ({ ...item, _entityType: "responders" })),
    ...(enableHotlines.body?.items || []).map((item) => ({ ...item, _entityType: "hotlines" }))
  ];
  const seen = new Set();
  uiState.reviews = merged.filter((item) => {
    const entityType = item._entityType === "hotlines" ? "hotlines" : "responders";
    const id = entityType === "hotlines" ? item.hotline_id : item.responder_id;
    const key = `${entityType}:${id}`;
    if (!id || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  uiState.pagination.reviews = {
    limit: uiState.reviews.length,
    offset: 0,
    total: uiState.reviews.length,
    has_more: false
  };
  const filteredItems = applyFilter(uiState.reviews);
  reviewsList.innerHTML = renderPendingReviewQueueMarkup(filteredItems);
  updatePageSummary("reviews");
  reviewsOutput.innerHTML = renderListLoadedSummary("pending review submissions", filteredItems, {
    status: 200,
    body: { items: filteredItems }
  });
}

function currentBillingTenantId() {
  return billingTenantInput.value.trim();
}

function renderBillingFromState() {
  billingBalance.innerHTML = renderBillingBalanceSummary(uiState.billing.balance);
  billingLedger.innerHTML = renderBillingLedgerSummary(applyFilter(uiState.billing.ledger));
}

async function refreshBilling() {
  if (!uiState.credentials?.api_key_configured) {
    billingBalance.innerHTML = `<div class="empty">Save platform credentials in the local gateway first.</div>`;
    billingLedger.innerHTML = `<div class="empty">Save platform credentials in the local gateway first.</div>`;
    billingOutput.innerHTML = `<div class="empty">Save platform credentials in the local gateway first.</div>`;
    return;
  }
  const tenantId = currentBillingTenantId();
  if (!tenantId) {
    billingBalance.innerHTML = renderBillingBalanceSummary(null);
    billingLedger.innerHTML = renderBillingLedgerSummary([]);
    billingOutput.innerHTML = `<div class="empty">Enter a tenant_id to load billing state.</div>`;
    return;
  }
  const encodedTenantId = encodeURIComponent(tenantId);
  const [balance, ledger] = await Promise.all([
    proxyRequest(`/v1/admin/billing/tenants/${encodedTenantId}/balance`),
    proxyRequest(`/v1/admin/billing/tenants/${encodedTenantId}/ledger?limit=25`)
  ]);
  if (balance.status === 200 && balance.body?.balance) {
    uiState.billing.balance = balance.body.balance;
    rememberBillingTenant(tenantId);
  } else {
    uiState.billing.balance = null;
  }
  uiState.billing.ledger = ledger.status === 200 ? ledger.body?.items || [] : [];
  renderBillingFromState();
  billingOutput.innerHTML = renderListLoadedSummary("billing ledger rows", uiState.billing.ledger, { balance, ledger });
}

async function createBillingTenant() {
  if (!uiState.credentials?.api_key_configured) {
    billingOutput.innerHTML = `<div class="empty">Save platform credentials in the local gateway first.</div>`;
    return;
  }
  const tenantId = currentBillingTenantId();
  if (!tenantId) {
    billingOutput.innerHTML = `<div class="empty">Enter a tenant_id before creating a billing tenant.</div>`;
    return;
  }
  const response = await proxyRequest("/v1/admin/billing/tenants", {
    method: "POST",
    body: { tenant_id: tenantId }
  });
  billingOutput.innerHTML = renderGatewayResponseSummary("Create Billing Tenant", response);
  if (response.status < 400) {
    rememberBillingTenant(tenantId);
    await refreshBilling();
  }
}

async function recordBillingRecharge() {
  if (!uiState.credentials?.api_key_configured) {
    billingOutput.innerHTML = `<div class="empty">Save platform credentials in the local gateway first.</div>`;
    return;
  }
  const tenantId = currentBillingTenantId();
  const amountCents = Number(billingRechargeAmountInput.value);
  if (!tenantId) {
    billingOutput.innerHTML = `<div class="empty">Enter a tenant_id before recording a recharge.</div>`;
    return;
  }
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    billingOutput.innerHTML = `<div class="empty">amount_cents must be a positive integer.</div>`;
    return;
  }
  const rechargeId = billingRechargeIdInput.value.trim() || `rch_${tenantId}_${Date.now()}`;
  const response = await proxyRequest(`/v1/admin/billing/tenants/${encodeURIComponent(tenantId)}/recharges`, {
    method: "POST",
    body: {
      recharge_id: rechargeId,
      amount_cents: amountCents,
      currency: "PTS",
      provider: billingRechargeProviderInput.value.trim() || "manual",
      external_reference: billingRechargeReferenceInput.value.trim() || null
    }
  });
  billingOutput.innerHTML = renderGatewayResponseSummary("Record Manual Recharge", response);
  if (response.status < 400) {
    billingRechargeIdInput.value = "";
    rememberBillingTenant(tenantId);
    await refreshBilling();
  }
}

async function refreshAll() {
  await Promise.all([
    refreshOverview(),
    refreshResponders(),
    refreshHotlines(),
    refreshRequests(),
    refreshCatalog(),
    refreshAudit(),
    refreshReviews(),
    refreshBilling()
  ]);
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

reviewsList.addEventListener("click", async (event) => {
  const card = event.target.closest("[data-detail-id]");
  if (card && !event.target.closest("button")) {
    const detailId = card.dataset.detailId || "";
    setDetail(uiState.reviews.find((item) => {
      const entityType = item._entityType === "hotlines" ? "hotlines" : "responders";
      const id = entityType === "hotlines" ? item.hotline_id : item.responder_id;
      return `${entityType}:${id}` === detailId;
    }) || null);
  }
  const button = event.target.closest("button[data-review-type]");
  if (button) {
    await runAction(button.dataset.reviewType, button.dataset.id, button.dataset.action);
    await refreshReviews();
  }
});

for (const section of paginatedSections) {
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

sidebarNav.addEventListener("click", (event) => {
  const groupToggle = event.target.closest("[data-nav-group-toggle]");
  if (groupToggle) {
    const groupId = groupToggle.dataset.navGroupToggle;
    if (navState.expandedGroups.has(groupId)) {
      navState.expandedGroups.delete(groupId);
    } else {
      navState.expandedGroups.add(groupId);
    }
    renderNav();
    return;
  }
  const leafButton = event.target.closest("[data-nav-panel]");
  if (leafButton && !leafButton.classList.contains("is-disabled")) {
    void activatePanel(leafButton.dataset.navPanel);
  }
});

document.querySelector("#goto-session").addEventListener("click", () => {
  void activatePanel("session", { force: true });
});
document.querySelector("#close-detail").addEventListener("click", () => {
  void activatePanel(navState.previousPanel || DEFAULT_PANEL, { pushHistory: false, force: true });
});
document.querySelector("#refresh-active-panel").addEventListener("click", () => {
  void refreshActivePanel();
});

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
document.querySelector("#refresh-billing").addEventListener("click", refreshBilling);
document.querySelector("#select-billing-tenant").addEventListener("click", refreshBilling);
document.querySelector("#create-billing-tenant").addEventListener("click", createBillingTenant);
document.querySelector("#record-billing-recharge").addEventListener("click", recordBillingRecharge);
globalFilterInput.addEventListener("input", () => {
  for (const pagination of Object.values(uiState.pagination)) {
    pagination.offset = 0;
  }
  if (operatorDataReady()) {
    void refreshActivePanel();
  }
});
for (const input of [platformUrlInput, actionReasonInput, reviewerNotesInput, sessionBootstrapSecretInput]) {
  input.addEventListener("change", savePrefs);
  input.addEventListener("blur", savePrefs);
}
reviewerNotesInput.addEventListener("input", () => {
  if (uiState.detail) {
    setDetail(uiState.detail, { navigate: false });
  }
});

loadPrefs();
renderContentHeader();
syncPanelVisibility();
void (async () => {
  await refreshSession();
  await refreshCredentials();
  if (operatorDataReady()) {
    uiState.loaded = true;
  }
  await activatePanel(navState.activePanel, { pushHistory: false, force: true });
})();
