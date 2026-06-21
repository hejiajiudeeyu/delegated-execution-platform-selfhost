import { renderBillingConsoleSection } from "./view-model.js";

export function renderConsoleShellMarkup() {
  return `
  <div class="app-shell">
    <aside class="sidebar" aria-label="Operator navigation">
      <div class="sidebar-brand">
        <p class="eyebrow">Control Plane</p>
        <h1 class="sidebar-title">Platform Console</h1>
        <p class="sidebar-subtitle">Operator gateway for reviews, billing, and catalog control.</p>
      </div>
      <div id="session-badge" class="session-badge"></div>
      <nav id="sidebar-nav" class="sidebar-nav"></nav>
    </aside>

    <div class="app-main">
      <header class="content-header card">
        <div class="content-header-copy">
          <p class="eyebrow">Operator Surface</p>
          <h2 id="content-title">Overview</h2>
          <p id="content-description" class="meta">Platform health summary and operator gateway status.</p>
        </div>
        <div class="content-toolbar">
          <label class="toolbar-field" for="global-filter">
            <span>Filter</span>
            <input id="global-filter" placeholder="Search responders, hotlines, requests..." />
          </label>
          <label class="toolbar-field" for="action-reason">
            <span>Action reason</span>
            <input id="action-reason" value="operator review" />
          </label>
          <button id="refresh-active-panel" class="ghost" type="button">Refresh</button>
          <button id="logout-session" class="ghost" type="button">Logout</button>
        </div>
      </header>

      <div id="lock-banner" class="lock-banner card" hidden>
        <div>
          <strong>Operator gateway locked</strong>
          <p>Unlock the session or configure gateway credentials before using catalog, billing, or review tools.</p>
        </div>
        <button id="goto-session" type="button">Open Session Settings</button>
      </div>

      <div id="content-panels" class="content-panels">
        <section class="content-panel is-active" data-panel="overview">
          <div class="card">
            <div class="section-head">
              <h3>Overview</h3>
              <button id="refresh-overview" class="ghost" type="button">Reload All</button>
            </div>
            <div id="overview-output" class="stack human-panel">Waiting for platform gateway.</div>
          </div>
        </section>

        <section class="content-panel" data-panel="responders" hidden>
          <div class="card">
            <div class="section-head">
              <h3>Responders</h3>
              <div class="actions inline">
                <button id="responders-prev" class="ghost" type="button">Prev</button>
                <button id="responders-next" class="ghost" type="button">Next</button>
                <button id="refresh-responders" class="ghost" type="button">Reload</button>
              </div>
            </div>
            <p id="responders-page" class="meta">responders: no data</p>
            <div id="responders-list" class="stack"></div>
          </div>
        </section>

        <section class="content-panel" data-panel="hotlines" hidden>
          <div class="card">
            <div class="section-head">
              <h3>Hotlines</h3>
              <div class="actions inline">
                <button id="hotlines-prev" class="ghost" type="button">Prev</button>
                <button id="hotlines-next" class="ghost" type="button">Next</button>
                <button id="refresh-hotlines" class="ghost" type="button">Reload</button>
              </div>
            </div>
            <p id="hotlines-page" class="meta">hotlines: no data</p>
            <div id="hotlines-list" class="stack"></div>
          </div>
        </section>

        <section class="content-panel" data-panel="catalog" hidden>
          <div class="card">
            <div class="section-head">
              <h3>Marketplace Catalog</h3>
              <button id="refresh-catalog" class="ghost" type="button">Reload</button>
            </div>
            <div id="catalog-output" class="stack human-panel">No catalog data loaded yet.</div>
          </div>
        </section>

        <section class="content-panel" data-panel="requests" hidden>
          <div class="card">
            <div class="section-head">
              <h3>Requests</h3>
              <div class="actions inline">
                <button id="requests-prev" class="ghost" type="button">Prev</button>
                <button id="requests-next" class="ghost" type="button">Next</button>
                <button id="refresh-requests" class="ghost" type="button">Reload</button>
              </div>
            </div>
            <p id="requests-page" class="meta">requests: no data</p>
            <div id="requests-list" class="stack"></div>
            <div id="requests-output" class="human-panel">No request data loaded yet.</div>
          </div>
        </section>

        <section class="content-panel" data-panel="audit" hidden>
          <div class="card">
            <div class="section-head">
              <h3>Audit Trail</h3>
              <div class="actions inline">
                <button id="audit-prev" class="ghost" type="button">Prev</button>
                <button id="audit-next" class="ghost" type="button">Next</button>
                <button id="refresh-audit" class="ghost" type="button">Reload</button>
              </div>
            </div>
            <p id="audit-page" class="meta">audit: no data</p>
            <div id="audit-list" class="stack"></div>
            <div id="audit-output" class="human-panel">No audit data loaded yet.</div>
          </div>
        </section>

        <section class="content-panel" data-panel="reviews" hidden>
          <div class="card">
            <div class="section-head">
              <h3>Review Queue</h3>
              <div class="actions inline">
                <button id="reviews-prev" class="ghost" type="button">Prev</button>
                <button id="reviews-next" class="ghost" type="button">Next</button>
                <button id="refresh-reviews" class="ghost" type="button">Reload</button>
              </div>
            </div>
            <label>Reviewer Notes</label>
            <textarea id="reviewer-notes" rows="3" placeholder="What was reviewed, approved/rejected, and any follow-up."></textarea>
            <p id="reviews-page" class="meta">reviews: no data</p>
            <div id="reviews-list" class="stack"></div>
            <div id="reviews-output" class="human-panel">No review data loaded yet.</div>
          </div>
        </section>

        <section class="content-panel" data-panel="billing" hidden>
          ${renderBillingConsoleSection()}
        </section>

        <section class="content-panel" data-panel="session" hidden>
          <div class="card">
            <div class="section-head">
              <div>
                <h3>Unlock Operator Gateway</h3>
                <p class="meta">Initialize or unlock the encrypted local secret store.</p>
              </div>
            </div>
            <div id="session-state" class="stack"></div>
            <div class="grid three">
              <div>
                <label for="session-passphrase">Passphrase</label>
                <input id="session-passphrase" type="password" placeholder="At least 8 characters" />
              </div>
              <div>
                <label for="session-next-passphrase">New Passphrase</label>
                <input id="session-next-passphrase" type="password" placeholder="For setup or rotation" />
              </div>
              <div>
                <label for="session-bootstrap-secret">Bootstrap Secret</label>
                <input id="session-bootstrap-secret" type="password" placeholder="Required when gateway is public" />
              </div>
            </div>
            <div class="actions inline">
              <button id="setup-session" type="button">Create Local Passphrase</button>
              <button id="login-session" class="ghost" type="button">Unlock</button>
              <button id="change-passphrase" class="ghost" type="button">Change Passphrase</button>
            </div>
            <div id="session-output" class="stack human-panel">Operator session not initialized yet.</div>
          </div>
        </section>

        <section class="content-panel" data-panel="credentials" hidden>
          <div class="card">
            <div class="section-head">
              <div>
                <h3>Gateway Credentials</h3>
                <p class="meta">Platform endpoint and admin API key stored in the local gateway.</p>
              </div>
              <button id="save-credentials" type="button">Save Credential</button>
            </div>
            <div class="grid three">
              <div>
                <label for="platform-url">Platform API URL</label>
                <input id="platform-url" value="http://127.0.0.1:8080" />
              </div>
              <div>
                <label for="platform-api-key">Operator API Key</label>
                <input id="platform-api-key" type="password" placeholder="sk_admin_..." />
              </div>
              <div>
                <label>Credential State</label>
                <p id="credential-state" class="meta">Not configured yet.</p>
              </div>
            </div>
          </div>
        </section>

        <section class="content-panel content-panel--detail" data-panel="detail" hidden>
          <div class="card">
            <div class="section-head">
              <h3>Selection Detail</h3>
              <button id="close-detail" class="ghost" type="button">Back</button>
            </div>
            <div id="reviewer-guidance" class="stack"></div>
            <div id="review-action-summary" class="stack"></div>
            <div id="detail-summary" class="stack"></div>
            <div id="detail-history" class="stack"></div>
            <div id="detail-output" class="stack human-panel">No item selected yet.</div>
          </div>
        </section>
      </div>
    </div>
  </div>
  `;
}
