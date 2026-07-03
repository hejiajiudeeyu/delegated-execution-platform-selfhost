import { escapeHtml } from "./human-view.js";

export const RECOVERY_CONFIRMATION_PHRASE = "RESET";

export const SESSION_PHASES = ["unreachable", "setup", "locked", "unlocked"];

/**
 * Derive the operator-facing session phase from the gateway session payload
 * plus the browser-held session token. The gateway reports `authenticated`
 * whenever any session exists server-side, so an unlocked phase additionally
 * requires this browser to hold a token.
 *
 * @param {{ session: object | null, sessionToken: string | null }} input
 * @returns {"unreachable" | "setup" | "locked" | "unlocked"}
 */
export function deriveSessionPhase({ session, sessionToken }) {
  if (!session) {
    return "unreachable";
  }
  if (session.setup_required) {
    return "setup";
  }
  if (sessionToken && session.authenticated) {
    return "unlocked";
  }
  return "locked";
}

function phaseStatusCard(phase, session = {}) {
  const cards = {
    unreachable: {
      title: "Gateway Unreachable",
      body: "The operator gateway did not answer. Check that platform-console-gateway is running, then retry.",
      status: "disabled",
      label: "offline"
    },
    setup: {
      title: "First-Time Setup Required",
      body: "No encrypted secret store exists yet. Create a console passphrase to initialize it.",
      status: "pending",
      label: "setup required"
    },
    locked: {
      title: "Operator Gateway Locked",
      body: "An encrypted secret store exists. Unlock it with the console passphrase to use admin tools.",
      status: "disabled",
      label: "locked"
    },
    unlocked: {
      title: "Operator Gateway Unlocked",
      body: "Admin credentials stay server-side in the encrypted gateway store. They are never shown in the browser.",
      status: "healthy",
      label: "authenticated"
    }
  };
  const card = cards[phase] || cards.unreachable;
  return `
    <article class="item-card">
      <div class="item-head">
        <div>
          <strong>${card.title}</strong>
          <p>${card.body}</p>
        </div>
        <span class="status ${card.status}">${card.label}</span>
      </div>
      ${phase === "unlocked" && session.expires_at ? `<p class="meta">Session expires at: ${escapeHtml(session.expires_at)}</p>` : ""}
    </article>
  `;
}

function bootstrapSecretField({ hint }) {
  return `
    <div>
      <label for="session-bootstrap-secret">Bootstrap Secret</label>
      <input id="session-bootstrap-secret" type="password" autocomplete="off" placeholder="PLATFORM_CONSOLE_BOOTSTRAP_SECRET" />
      <p class="meta">${hint}</p>
    </div>
  `;
}

const BOOTSTRAP_SOURCE_HINT =
  "Held by whoever deployed the stack: the PLATFORM_CONSOLE_BOOTSTRAP_SECRET value from the gateway deployment environment. Required unless you are on localhost.";

function renderSetupPhase() {
  return `
    <div class="phase-block" data-session-phase="setup">
      <div class="grid three">
        <div>
          <label for="session-new-passphrase">New Passphrase</label>
          <input id="session-new-passphrase" type="password" autocomplete="new-password" placeholder="At least 8 characters" />
          <p class="meta">Protects the gateway secret store. Store it in the deployment handoff — losing it forces a destructive recovery.</p>
        </div>
        <div>
          <label for="session-confirm-passphrase">Confirm Passphrase</label>
          <input id="session-confirm-passphrase" type="password" autocomplete="new-password" placeholder="Repeat the passphrase" />
        </div>
        ${bootstrapSecretField({ hint: BOOTSTRAP_SOURCE_HINT })}
      </div>
      <div class="actions inline">
        <button type="button" data-session-action="setup">Create Passphrase &amp; Unlock</button>
      </div>
      <p class="meta">After setup, save the Platform Admin API key under Gateway Credentials to enable review and billing tools.</p>
    </div>
  `;
}

function renderLockedPhase() {
  return `
    <div class="phase-block" data-session-phase="locked">
      <div class="grid three">
        <div>
          <label for="session-passphrase">Console Passphrase</label>
          <input id="session-passphrase" type="password" autocomplete="current-password" placeholder="Console passphrase" />
        </div>
      </div>
      <div class="actions inline">
        <button type="button" data-session-action="login">Unlock</button>
      </div>
      <details class="recovery-zone">
        <summary>Lost passphrase? Reset the gateway store</summary>
        <article class="item-card recovery-warning">
          <div class="item-head">
            <div>
              <strong>Destructive Recovery</strong>
              <p>Resetting creates a new encrypted store with a new passphrase. Secrets encrypted with the old passphrase — including the saved Platform Admin API key — cannot be preserved and must be re-entered afterwards.</p>
            </div>
            <span class="status degraded">destructive</span>
          </div>
        </article>
        <div class="grid three">
          ${bootstrapSecretField({ hint: BOOTSTRAP_SOURCE_HINT })}
          <div>
            <label for="session-recovery-passphrase">New Passphrase</label>
            <input id="session-recovery-passphrase" type="password" autocomplete="new-password" placeholder="At least 8 characters" />
          </div>
          <div>
            <label for="session-recovery-confirm">Type ${RECOVERY_CONFIRMATION_PHRASE} To Confirm</label>
            <input id="session-recovery-confirm" autocomplete="off" placeholder="${RECOVERY_CONFIRMATION_PHRASE}" />
          </div>
        </div>
        <div class="actions inline">
          <button type="button" class="ghost" data-session-action="recover">Reset Store &amp; Set New Passphrase</button>
        </div>
      </details>
    </div>
  `;
}

function renderUnlockedPhase({ adminKeyConfigured }) {
  return `
    <div class="phase-block" data-session-phase="unlocked">
      ${
        adminKeyConfigured
          ? `
            <article class="item-card">
              <div class="item-head">
                <div>
                  <strong>Admin Credential Ready</strong>
                  <p>The Platform Admin API key is stored in the encrypted gateway store. Review, catalog, and billing tools are available.</p>
                </div>
                <span class="status healthy">ready</span>
              </div>
            </article>
          `
          : `
            <article class="item-card">
              <div class="item-head">
                <div>
                  <strong>Next Step: Save Admin Credential</strong>
                  <p>The gateway is unlocked, but no Platform Admin API key is stored yet. Review, catalog, and billing tools stay blocked until it is saved.</p>
                </div>
                <span class="status pending">blocked</span>
              </div>
              <div class="actions">
                <button type="button" data-session-action="goto-credentials">Open Gateway Credentials</button>
              </div>
            </article>
          `
      }
      <div class="grid three">
        <div>
          <label for="session-next-passphrase">Rotate Passphrase</label>
          <input id="session-next-passphrase" type="password" autocomplete="new-password" placeholder="New passphrase (at least 8 characters)" />
        </div>
      </div>
      <div class="actions inline">
        <button type="button" class="ghost" data-session-action="change-passphrase">Change Passphrase</button>
        <button type="button" class="ghost" data-session-action="logout">Logout</button>
      </div>
    </div>
  `;
}

function renderUnreachablePhase() {
  return `
    <div class="phase-block" data-session-phase="unreachable">
      <div class="actions inline">
        <button type="button" data-session-action="retry">Retry Connection</button>
      </div>
    </div>
  `;
}

/**
 * Render the session panel body for the given phase. Secrets are never
 * echoed into the markup; inputs are rendered empty and filled by the caller.
 *
 * @param {object} options
 * @param {"unreachable" | "setup" | "locked" | "unlocked"} options.phase
 * @param {object | null} [options.session]
 * @param {boolean} [options.adminKeyConfigured]
 */
export function renderSessionPanelMarkup({ phase, session = null, adminKeyConfigured = false }) {
  const bodies = {
    setup: renderSetupPhase,
    locked: renderLockedPhase,
    unlocked: () => renderUnlockedPhase({ adminKeyConfigured }),
    unreachable: renderUnreachablePhase
  };
  const body = (bodies[phase] || renderUnreachablePhase)();
  return `
    <div class="stack">
      ${phaseStatusCard(phase, session || {})}
    </div>
    ${body}
  `;
}

/**
 * Validate recovery form values before the destructive gateway call.
 *
 * @param {{ passphrase: string, confirmation: string, bootstrapSecret: string }} input
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateRecoveryInput({ passphrase, confirmation, bootstrapSecret }) {
  if (!bootstrapSecret.trim()) {
    return { ok: false, message: "Enter the deployment-held bootstrap secret before resetting the store." };
  }
  if (passphrase.trim().length < 8) {
    return { ok: false, message: "New passphrase must be at least 8 characters." };
  }
  if (confirmation.trim() !== RECOVERY_CONFIRMATION_PHRASE) {
    return { ok: false, message: `Type ${RECOVERY_CONFIRMATION_PHRASE} to confirm the destructive reset.` };
  }
  return { ok: true };
}

/**
 * Validate first-time setup form values.
 *
 * @param {{ passphrase: string, confirmPassphrase: string }} input
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateSetupInput({ passphrase, confirmPassphrase }) {
  if (passphrase.trim().length < 8) {
    return { ok: false, message: "Passphrase must be at least 8 characters." };
  }
  if (passphrase.trim() !== confirmPassphrase.trim()) {
    return { ok: false, message: "Passphrase and confirmation do not match." };
  }
  return { ok: true };
}
